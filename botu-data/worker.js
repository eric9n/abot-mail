/**
 * botu-data: personal structured data (contacts, calendar, notes).
 * POST /mcp   MCP (Streamable HTTP, JSON-RPC), Bearer DATA_MCP_TOKEN
 * GET /ctc/{id}  GET /cal/{id}  GET /note/{id}   canonical JSON, same token
 * GET /health liveness, no personal data
 * scheduled    detector and delivery repair (not a URL)
 * queue        botu-deliver / botu-deliver-dlq (not a URL)
 *
 * D1 binding is DB. This worker does not read the mail archive.
 */

import {
  buildWebhookBody,
  createPhase2,
  signWebhook,
  stableStringify,
  verifyWebhookRequest,
} from "./phase2.js";

export { buildWebhookBody, signWebhook, stableStringify, verifyWebhookRequest };

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1_000_000;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_PREFIXES = new Set(["cal_", "ctc_", "note_", "evt_", "sub_", "dlv_"]);
const REPEAT_FREQ = new Set(["none", "daily", "weekly", "monthly"]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const CONTACT_FIELDS = "id, name, aliases, org, title, email, phone, relation, notes, source, created_by, created_at, updated_at";
const EVENT_FIELDS =
  "id, title, start_utc, end_utc, timezone, all_day, repeat, source, attendee_ids, reminder_minutes, location, notes, status, google_event_id, created_by, created_at, updated_at";
const NOTE_FIELDS = "id, title, body, tags, links, source, created_by, created_at, updated_at";

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RpcError";
  }
}

/** Character-by-character compare. Always walks the longer string. */
export function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  const len = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < len; i++) {
    const ca = i < left.length ? left.charCodeAt(i) : 0;
    const cb = i < right.length ? right.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export function likeContains(value) {
  const escaped = String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/**
 * prefix + 12 chars from [a-z0-9]. Bytes >= 252 are skipped so `% 36` is unbiased.
 * Throws if the buffer does not contain 12 usable bytes.
 */
export function idFromBytes(prefix, bytes) {
  if (!ID_PREFIXES.has(prefix)) {
    throw new Error("bad id prefix");
  }
  let body = "";
  for (let i = 0; i < bytes.length && body.length < 12; i++) {
    const n = bytes[i];
    if (n >= 252) continue;
    body += ID_ALPHABET[n % 36];
  }
  if (body.length !== 12) throw new Error("not enough entropy");
  return prefix + body;
}

export function newId(prefix) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    try {
      return idFromBytes(prefix, bytes);
    } catch (err) {
      if (!err || err.message !== "not enough entropy") throw err;
    }
  }
  throw new Error("id entropy exhausted");
}

export function canonicalUtc(value, label) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new RpcError(-32602, `${label} must be UTC ISO8601`);
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new RpcError(-32602, `${label} must be UTC ISO8601`);
  return new Date(t).toISOString();
}

export function assertTimeOrder(startUtc, endUtc) {
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  if (!(end > start)) throw new RpcError(-32602, "end_utc must be after start_utc");
}

/** Object or JSON text. freq must be none, daily, weekly, or monthly. */
export function normalizeRepeat(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new RpcError(-32602, "repeat must be valid JSON");
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RpcError(-32602, "repeat must be a JSON object");
  }
  if (typeof parsed.freq !== "string" || !REPEAT_FREQ.has(parsed.freq)) {
    throw new RpcError(-32602, "repeat.freq must be none, daily, weekly, or monthly");
  }
  return JSON.stringify(parsed);
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function assertOnlyKeys(obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new RpcError(-32602, `unexpected argument: ${key}`);
  }
}

function requireArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new RpcError(-32602, "arguments must be an object");
  }
}

function clampLimit(limit, fallback, max) {
  if (limit == null) return fallback;
  if (!Number.isInteger(limit)) throw new RpcError(-32602, "limit must be an integer");
  if (limit < 1) throw new RpcError(-32602, "limit must be >= 1");
  return Math.min(limit, max);
}

function requireId(value, prefix) {
  if (typeof value !== "string" || !new RegExp(`^${prefix}[a-z0-9]{12}$`).test(value)) {
    throw new RpcError(-32602, "id is required");
  }
  return value;
}

function notFound() {
  return new RpcError(-32602, "not found");
}

function optionalQuery(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new RpcError(-32602, "query must be a string");
  if (value.length > 200) throw new RpcError(-32602, "query is too long");
  return value;
}

function optionalTag(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new RpcError(-32602, "tag must be a string");
  if (value.length > 100) throw new RpcError(-32602, "tag is too long");
  return value;
}

function optionalStatus(value) {
  if (value == null || value === "") return null;
  if (value !== "confirmed" && value !== "cancelled") {
    throw new RpcError(-32602, "status must be confirmed or cancelled");
  }
  return value;
}

function readText(value, key, { required, allowEmpty, max, nullable }) {
  if (value == null) {
    if (required) throw new RpcError(-32602, `${key} is required`);
    if (nullable) return null;
    throw new RpcError(-32602, `${key} must be a string`);
  }
  if (typeof value !== "string") throw new RpcError(-32602, `${key} must be a string`);
  if (!allowEmpty && value.trim() === "") throw new RpcError(-32602, `${key} is required`);
  if (value.length > max) throw new RpcError(-32602, `${key} is too long`);
  return value;
}

function takeText(args, key, opts) {
  if (!has(args, key)) {
    if (opts.required) throw new RpcError(-32602, `${key} is required`);
    return undefined;
  }
  return readText(args[key], key, opts);
}

function readStringArray(value, key, itemMax) {
  if (!Array.isArray(value)) throw new RpcError(-32602, `${key} must be an array`);
  if (value.length > 100) throw new RpcError(-32602, `${key} is too long`);
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") throw new RpcError(-32602, `${key} must be an array of strings`);
    if (item.length > itemMax) throw new RpcError(-32602, `${key} item is too long`);
    out.push(item);
  }
  return JSON.stringify(out);
}

function takeStringArray(args, key, itemMax) {
  if (!has(args, key)) return undefined;
  return readStringArray(args[key], key, itemMax);
}

function readMinutes(value) {
  if (!Array.isArray(value)) throw new RpcError(-32602, "reminder_minutes must be an array");
  if (value.length > 50) throw new RpcError(-32602, "reminder_minutes is too long");
  const out = [];
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item > 525600) {
      throw new RpcError(-32602, "reminder_minutes must be non-negative integers");
    }
    out.push(item);
  }
  return JSON.stringify(out);
}

function takeMinutes(args) {
  if (!has(args, "reminder_minutes")) return undefined;
  return readMinutes(args.reminder_minutes);
}

function readCreatedBy(value) {
  if (value == null) return "human";
  if (value !== "human" && value !== "bot:main") {
    throw new RpcError(-32602, "created_by must be human or bot:main");
  }
  return value;
}

function takeCreatedBy(args) {
  if (!has(args, "created_by")) return "human";
  return readCreatedBy(args.created_by);
}

function readTimezone(value) {
  if (value == null) return "Asia/Shanghai";
  if (typeof value !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) {
    throw new RpcError(-32602, "timezone must be a string");
  }
  return value;
}

function takeTimezone(args) {
  if (!has(args, "timezone")) return undefined;
  return readTimezone(args.timezone);
}

function readAllDay(value) {
  if (value == null) return 0;
  if (typeof value !== "boolean") throw new RpcError(-32602, "all_day must be a boolean");
  return value ? 1 : 0;
}

function takeAllDay(args) {
  if (!has(args, "all_day")) return undefined;
  return readAllDay(args.all_day);
}

function takeRepeat(args) {
  if (!has(args, "repeat")) return undefined;
  if (args.repeat == null) throw new RpcError(-32602, "repeat must be valid JSON");
  return normalizeRepeat(args.repeat);
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowIso(deps) {
  const ms = deps && typeof deps.nowMs === "number" && Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  return new Date(ms).toISOString();
}

const RESOURCE_KIND = { ctc_: "ctc", cal_: "cal", note_: "note" };

/** Absolute canonical URL for a record. Origin is the request origin, not stored. */
export function canonicalUrl(origin, id) {
  const prefix = typeof id === "string" ? id.slice(0, id.indexOf("_") + 1) : "";
  const kind = RESOURCE_KIND[prefix];
  if (!kind) throw new Error("bad id");
  const path = `/${kind}/${id}`;
  if (typeof origin !== "string" || origin === "") return path;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

function contactView(row, origin) {
  return {
    id: row.id,
    url: canonicalUrl(origin, row.id),
    name: row.name,
    aliases: parseJson(row.aliases, []),
    org: row.org ?? null,
    title: row.title ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    relation: row.relation ?? null,
    notes: row.notes ?? null,
    source: row.source,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function eventView(row, origin) {
  return {
    id: row.id,
    url: canonicalUrl(origin, row.id),
    title: row.title,
    start_utc: row.start_utc,
    end_utc: row.end_utc,
    timezone: row.timezone,
    all_day: row.all_day === 1 || row.all_day === true,
    repeat: parseJson(row.repeat, { freq: "none" }),
    source: row.source,
    attendee_ids: parseJson(row.attendee_ids, []),
    reminder_minutes: parseJson(row.reminder_minutes, []),
    location: row.location ?? null,
    notes: row.notes ?? null,
    status: row.status,
    google_event_id: row.google_event_id ?? null,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function noteView(row, origin) {
  return {
    id: row.id,
    url: canonicalUrl(origin, row.id),
    title: row.title,
    body: row.body,
    tags: parseJson(row.tags, []),
    links: parseJson(row.links, []),
    source: row.source,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function queryAll(deps, sql, params) {
  if (!deps || typeof deps.queryAll !== "function") throw new Error("queryAll is not configured");
  const rows = await deps.queryAll(sql, params);
  return Array.isArray(rows) ? rows : [];
}

async function queryFirst(deps, sql, params) {
  if (!deps || typeof deps.queryFirst !== "function") throw new Error("queryFirst is not configured");
  const row = await deps.queryFirst(sql, params);
  return row ?? null;
}

async function queryRun(deps, sql, params) {
  if (!deps || typeof deps.queryRun !== "function") throw new Error("queryRun is not configured");
  return deps.queryRun(sql, params);
}

function isUniqueError(err) {
  return /unique/i.test(String(err && err.message));
}

async function insertWithId(deps, prefix, sql, paramsAfterId) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId(prefix);
    try {
      await queryRun(deps, sql, [id, ...paramsAfterId]);
      return id;
    } catch (err) {
      lastErr = err;
      if (!isUniqueError(err)) throw err;
    }
  }
  throw lastErr;
}

function assign(sets, params, column, value) {
  if (value === undefined) return;
  sets.push(`${column} = ?`);
  params.push(value);
}

async function createContact(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["name", "aliases", "org", "title", "email", "phone", "relation", "notes", "created_by"]));
  const name = readText(args.name, "name", { required: true, allowEmpty: false, max: 200 });
  const aliases = takeStringArray(args, "aliases", 200) ?? "[]";
  const org = takeText(args, "org", { nullable: true, allowEmpty: true, max: 200 });
  const title = takeText(args, "title", { nullable: true, allowEmpty: true, max: 200 });
  const email = takeText(args, "email", { nullable: true, allowEmpty: true, max: 200 });
  const phone = takeText(args, "phone", { nullable: true, allowEmpty: true, max: 200 });
  const relation = takeText(args, "relation", { nullable: true, allowEmpty: true, max: 200 });
  const notes = takeText(args, "notes", { nullable: true, allowEmpty: true, max: 20000 });
  const createdBy = takeCreatedBy(args);
  const now = nowIso(deps);
  const id = await insertWithId(
    deps,
    "ctc_",
    `INSERT INTO contacts (
      id, name, aliases, org, title, email, phone, relation, notes, source, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
    [name, aliases, org ?? null, title ?? null, email ?? null, phone ?? null, relation ?? null, notes ?? null, createdBy, now, now],
  );
  return { id, url: canonicalUrl(deps && deps.origin, id) };
}

async function getContact(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "ctc_");
  const row = await queryFirst(deps, `SELECT ${CONTACT_FIELDS} FROM contacts WHERE id = ?`, [id]);
  if (!row) return { found: false, id };
  return { found: true, ...contactView(row, deps.origin) };
}

async function listContacts(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["query", "limit"]));
  const limit = clampLimit(args.limit, 20, 100);
  const query = optionalQuery(args.query);
  const params = [];
  let where = "";
  if (query != null) {
    const pattern = likeContains(query);
    where = "WHERE (name LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR IFNULL(org, '') LIKE ? ESCAPE '\\')\n";
    params.push(pattern, pattern, pattern);
  }
  params.push(limit);
  const rows = await queryAll(
    deps,
    `SELECT ${CONTACT_FIELDS}
FROM contacts
${where}ORDER BY updated_at DESC, id ASC
LIMIT ?`,
    params,
  );
  return rows.map((row) => contactView(row, deps.origin));
}

async function updateContact(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id", "name", "aliases", "org", "title", "email", "phone", "relation", "notes"]));
  const id = requireId(args.id, "ctc_");
  const sets = [];
  const params = [];
  assign(sets, params, "name", takeText(args, "name", { allowEmpty: false, max: 200 }));
  assign(sets, params, "aliases", takeStringArray(args, "aliases", 200));
  assign(sets, params, "org", takeText(args, "org", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "title", takeText(args, "title", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "email", takeText(args, "email", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "phone", takeText(args, "phone", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "relation", takeText(args, "relation", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "notes", takeText(args, "notes", { nullable: true, allowEmpty: true, max: 20000 }));
  if (sets.length === 0) throw new RpcError(-32602, "no fields to update");
  const existing = await queryFirst(deps, "SELECT id FROM contacts WHERE id = ?", [id]);
  if (!existing) throw notFound();
  const now = nowIso(deps);
  sets.push("updated_at = ?");
  params.push(now, id);
  await queryRun(deps, `UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`, params);
  const row = await queryFirst(deps, `SELECT ${CONTACT_FIELDS} FROM contacts WHERE id = ?`, [id]);
  return { found: true, ...contactView(row, deps.origin) };
}

async function deleteContact(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "ctc_");
  const existing = await queryFirst(deps, "SELECT id FROM contacts WHERE id = ?", [id]);
  if (!existing) throw notFound();
  await queryRun(deps, "DELETE FROM contacts WHERE id = ?", [id]);
  return { id, deleted: true };
}

async function createEvent(args, deps) {
  requireArgs(args);
  assertOnlyKeys(
    args,
    new Set([
      "title",
      "start_utc",
      "end_utc",
      "timezone",
      "all_day",
      "repeat",
      "attendee_ids",
      "reminder_minutes",
      "location",
      "notes",
      "created_by",
    ]),
  );
  const title = readText(args.title, "title", { required: true, allowEmpty: false, max: 500 });
  const start = canonicalUtc(args.start_utc, "start_utc");
  const end = canonicalUtc(args.end_utc, "end_utc");
  assertTimeOrder(start, end);
  const timezone = has(args, "timezone") ? readTimezone(args.timezone) : "Asia/Shanghai";
  const allDay = has(args, "all_day") ? readAllDay(args.all_day) : 0;
  const repeat = has(args, "repeat") ? takeRepeat(args) : '{"freq":"none"}';
  const attendees = takeStringArray(args, "attendee_ids", 64) ?? "[]";
  const reminders = takeMinutes(args) ?? "[]";
  const location = takeText(args, "location", { nullable: true, allowEmpty: true, max: 500 });
  const notes = takeText(args, "notes", { nullable: true, allowEmpty: true, max: 20000 });
  const createdBy = takeCreatedBy(args);
  const now = nowIso(deps);
  const id = await insertWithId(
    deps,
    "cal_",
    `INSERT INTO calendar_events (
      id, title, start_utc, end_utc, timezone, all_day, repeat, source,
      attendee_ids, reminder_minutes, location, notes, status, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bot', ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
    [title, start, end, timezone, allDay, repeat, attendees, reminders, location ?? null, notes ?? null, createdBy, now, now],
  );
  return { id, url: canonicalUrl(deps && deps.origin, id) };
}

async function getEvent(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "cal_");
  const row = await queryFirst(deps, `SELECT ${EVENT_FIELDS} FROM calendar_events WHERE id = ?`, [id]);
  if (!row) return { found: false, id };
  return { found: true, ...eventView(row, deps.origin) };
}

async function listEvents(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["start_utc", "end_utc", "status", "limit"]));
  const start = canonicalUtc(args.start_utc, "start_utc");
  const end = canonicalUtc(args.end_utc, "end_utc");
  assertTimeOrder(start, end);
  const status = optionalStatus(args.status);
  const limit = clampLimit(args.limit, 100, 500);
  const where = ["start_utc < ?", "end_utc > ?"];
  const params = [end, start];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  params.push(limit);
  const rows = await queryAll(
    deps,
    `SELECT ${EVENT_FIELDS}
FROM calendar_events
WHERE ${where.join("\n  AND ")}
ORDER BY start_utc ASC, id ASC
LIMIT ?`,
    params,
  );
  return rows.map((row) => eventView(row, deps.origin));
}

async function updateEvent(args, deps) {
  requireArgs(args);
  assertOnlyKeys(
    args,
    new Set([
      "id",
      "title",
      "start_utc",
      "end_utc",
      "timezone",
      "all_day",
      "repeat",
      "attendee_ids",
      "reminder_minutes",
      "location",
      "notes",
      "status",
    ]),
  );
  const id = requireId(args.id, "cal_");
  const title = takeText(args, "title", { allowEmpty: false, max: 500 });
  const start = has(args, "start_utc") ? canonicalUtc(args.start_utc, "start_utc") : undefined;
  const end = has(args, "end_utc") ? canonicalUtc(args.end_utc, "end_utc") : undefined;
  const timezone = takeTimezone(args);
  const allDay = takeAllDay(args);
  const repeat = takeRepeat(args);
  const attendees = takeStringArray(args, "attendee_ids", 64);
  const reminders = takeMinutes(args);
  const location = takeText(args, "location", { nullable: true, allowEmpty: true, max: 500 });
  const notes = takeText(args, "notes", { nullable: true, allowEmpty: true, max: 20000 });
  const status = has(args, "status") ? optionalStatus(args.status) : undefined;
  if (has(args, "status") && status == null) throw new RpcError(-32602, "status must be confirmed or cancelled");
  const sets = [];
  const params = [];
  assign(sets, params, "title", title);
  assign(sets, params, "start_utc", start);
  assign(sets, params, "end_utc", end);
  assign(sets, params, "timezone", timezone);
  assign(sets, params, "all_day", allDay);
  assign(sets, params, "repeat", repeat);
  assign(sets, params, "attendee_ids", attendees);
  assign(sets, params, "reminder_minutes", reminders);
  assign(sets, params, "location", location);
  assign(sets, params, "notes", notes);
  assign(sets, params, "status", status);
  if (sets.length === 0) throw new RpcError(-32602, "no fields to update");
  const existing = await queryFirst(deps, `SELECT ${EVENT_FIELDS} FROM calendar_events WHERE id = ?`, [id]);
  if (!existing) throw notFound();
  assertTimeOrder(start ?? existing.start_utc, end ?? existing.end_utc);
  const now = nowIso(deps);
  sets.push("updated_at = ?");
  params.push(now, id);
  await queryRun(deps, `UPDATE calendar_events SET ${sets.join(", ")} WHERE id = ?`, params);
  const row = await queryFirst(deps, `SELECT ${EVENT_FIELDS} FROM calendar_events WHERE id = ?`, [id]);
  return { found: true, ...eventView(row, deps.origin) };
}

async function deleteEvent(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "cal_");
  const existing = await queryFirst(deps, "SELECT id FROM calendar_events WHERE id = ?", [id]);
  if (!existing) throw notFound();
  const now = nowIso(deps);
  await queryRun(deps, "UPDATE calendar_events SET status = 'cancelled', updated_at = ? WHERE id = ?", [now, id]);
  return { id, status: "cancelled" };
}

async function createNote(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["title", "body", "tags", "links", "created_by"]));
  const title = takeText(args, "title", { allowEmpty: true, max: 500 }) ?? "";
  const body = takeText(args, "body", { allowEmpty: true, max: 100000 }) ?? "";
  const tags = takeStringArray(args, "tags", 100) ?? "[]";
  const links = takeStringArray(args, "links", 500) ?? "[]";
  const createdBy = takeCreatedBy(args);
  const now = nowIso(deps);
  const id = await insertWithId(
    deps,
    "note_",
    `INSERT INTO notes (
      id, title, body, tags, links, source, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
    [title, body, tags, links, createdBy, now, now],
  );
  return { id, url: canonicalUrl(deps && deps.origin, id) };
}

async function getNote(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "note_");
  const row = await queryFirst(deps, `SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?`, [id]);
  if (!row) return { found: false, id };
  return { found: true, ...noteView(row, deps.origin) };
}

async function listNotes(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["query", "tag", "limit"]));
  const limit = clampLimit(args.limit, 20, 100);
  const query = optionalQuery(args.query);
  const tag = optionalTag(args.tag);
  const where = [];
  const params = [];
  if (query != null) {
    const pattern = likeContains(query);
    where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (tag != null) {
    where.push("EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = ?)");
    params.push(tag);
  }
  params.push(limit);
  const whereSql = where.length ? `WHERE ${where.join("\n  AND ")}\n` : "";
  const rows = await queryAll(
    deps,
    `SELECT ${NOTE_FIELDS}
FROM notes
${whereSql}ORDER BY updated_at DESC, id ASC
LIMIT ?`,
    params,
  );
  return rows.map((row) => noteView(row, deps.origin));
}

async function updateNote(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id", "title", "body", "tags", "links"]));
  const id = requireId(args.id, "note_");
  const sets = [];
  const params = [];
  assign(sets, params, "title", takeText(args, "title", { allowEmpty: true, max: 500 }));
  assign(sets, params, "body", takeText(args, "body", { allowEmpty: true, max: 100000 }));
  assign(sets, params, "tags", takeStringArray(args, "tags", 100));
  assign(sets, params, "links", takeStringArray(args, "links", 500));
  if (sets.length === 0) throw new RpcError(-32602, "no fields to update");
  const existing = await queryFirst(deps, "SELECT id FROM notes WHERE id = ?", [id]);
  if (!existing) throw notFound();
  const now = nowIso(deps);
  sets.push("updated_at = ?");
  params.push(now, id);
  await queryRun(deps, `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`, params);
  const row = await queryFirst(deps, `SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?`, [id]);
  return { found: true, ...noteView(row, deps.origin) };
}

async function deleteNote(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "note_");
  const existing = await queryFirst(deps, "SELECT id FROM notes WHERE id = ?", [id]);
  if (!existing) throw notFound();
  await queryRun(deps, "DELETE FROM notes WHERE id = ?", [id]);
  return { id, deleted: true };
}

const phase2 = createPhase2({
  RpcError,
  newId,
  queryAll,
  queryFirst,
  queryRun,
  nowIso,
  canonicalUtc,
  requireArgs,
  assertOnlyKeys,
  has,
  requireId,
  notFound,
  clampLimit,
  timingSafeEqual,
  isUniqueError,
  d1Deps,
});

export const TOOLS = [
  {
    name: "create_contact",
    description: "新建联系人。name 必填。aliases 为字符串数组。返回 {id, url}，id 前缀 ctc_，url 是 canonical URL。created_by 可选：human 或 bot:main。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        org: { type: "string" },
        title: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        relation: { type: "string" },
        notes: { type: "string" },
        created_by: { type: "string", enum: ["human", "bot:main"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_contact",
    description: "按 id 读取一个联系人。命中时带 url。不存在时 found 为 false。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_contacts",
    description: "列出联系人。query 对 name、aliases、org 做 LIKE。limit 默认 20，最大 100。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_contact",
    description: "按 id 更新联系人字段。只改传入的字段。aliases 会整组替换。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        org: { type: "string" },
        title: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        relation: { type: "string" },
        notes: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_contact",
    description: "硬删除一个联系人。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_event",
    description:
      "新建日历事件。start_utc / end_utc 为 UTC ISO8601，end 必须晚于 start。repeat.freq 为 none、daily、weekly 或 monthly。返回 {id, url}，id 前缀 cal_。不检查 attendee_ids 是否已有联系人。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start_utc: { type: "string" },
        end_utc: { type: "string" },
        timezone: { type: "string", default: "Asia/Shanghai" },
        all_day: { type: "boolean", default: false },
        repeat: { type: "object" },
        attendee_ids: { type: "array", items: { type: "string" } },
        reminder_minutes: { type: "array", items: { type: "integer" } },
        location: { type: "string" },
        notes: { type: "string" },
        created_by: { type: "string", enum: ["human", "bot:main"] },
      },
      required: ["title", "start_utc", "end_utc"],
      additionalProperties: false,
    },
  },
  {
    name: "get_event",
    description: "按 id 读取一个事件，包括已取消的事件。命中时带 url。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_events",
    description:
      "列出与 [start_utc, end_utc) 重叠的事件（start_utc < 窗口结束且 end_utc > 窗口开始）。status 可选 confirmed 或 cancelled；省略则两者都返回。",
    inputSchema: {
      type: "object",
      properties: {
        start_utc: { type: "string" },
        end_utc: { type: "string" },
        status: { type: "string", enum: ["confirmed", "cancelled"] },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["start_utc", "end_utc"],
      additionalProperties: false,
    },
  },
  {
    name: "update_event",
    description: "按 id 更新事件。改时间时仍要求结束晚于开始。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        start_utc: { type: "string" },
        end_utc: { type: "string" },
        timezone: { type: "string" },
        all_day: { type: "boolean" },
        repeat: { type: "object" },
        attendee_ids: { type: "array", items: { type: "string" } },
        reminder_minutes: { type: "array", items: { type: "integer" } },
        location: { type: "string" },
        notes: { type: "string" },
        status: { type: "string", enum: ["confirmed", "cancelled"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_event",
    description: "将事件 status 标为 cancelled，保留历史，不物理删除。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_note",
    description: "新建笔记。title、body、tags、links 都可选。返回 {id, url}，id 前缀 note_。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        links: { type: "array", items: { type: "string" } },
        created_by: { type: "string", enum: ["human", "bot:main"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_note",
    description: "按 id 读取一条笔记。命中时带 url。不存在时 found 为 false。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_notes",
    description: "列出笔记。query 对 title 和 body 做 LIKE。tag 精确匹配 tags 数组里的一项。limit 默认 20，最大 100。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_note",
    description: "按 id 更新笔记。tags 和 links 会整组替换。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        links: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_note",
    description: "硬删除一条笔记。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  ...phase2.tools,
];

function toolText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function callTool(name, args, deps) {
  switch (name) {
    case "create_contact":
      return createContact(args, deps);
    case "get_contact":
      return getContact(args, deps);
    case "list_contacts":
      return listContacts(args, deps);
    case "update_contact":
      return updateContact(args, deps);
    case "delete_contact":
      return deleteContact(args, deps);
    case "create_event":
      return createEvent(args, deps);
    case "get_event":
      return getEvent(args, deps);
    case "list_events":
      return listEvents(args, deps);
    case "update_event":
      return updateEvent(args, deps);
    case "delete_event":
      return deleteEvent(args, deps);
    case "create_note":
      return createNote(args, deps);
    case "get_note":
      return getNote(args, deps);
    case "list_notes":
      return listNotes(args, deps);
    case "update_note":
      return updateNote(args, deps);
    case "delete_note":
      return deleteNote(args, deps);
    default: {
      const handler = phase2.handlers[name];
      if (handler) return handler(args, deps);
      throw new RpcError(-32601, `unknown tool: ${name}`);
    }
  }
}

export async function handleMcpRpc(message, deps) {
  try {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { type: "error", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
      return { type: "error", id, error: { code: -32600, message: "Invalid Request" } };
    }
    if (message.method.startsWith("notifications/")) {
      return { type: "notification" };
    }
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      return { type: "error", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const id = message.id;
    if (message.method === "initialize") {
      return {
        type: "result",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "botu-data-mcp", version: "1.0.0" },
        },
      };
    }
    if (message.method === "tools/list") {
      return { type: "result", id, result: { tools: TOOLS } };
    }
    if (message.method === "tools/call") {
      const params = message.params;
      if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.name !== "string") {
        throw new RpcError(-32602, "tools/call requires params.name");
      }
      const args = params.arguments == null ? {} : params.arguments;
      if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "arguments must be an object");
      const known = TOOLS.some((tool) => tool.name === params.name);
      if (!known) throw new RpcError(-32601, `unknown tool: ${params.name}`);
      const value = await callTool(params.name, args, deps);
      return { type: "result", id, result: toolText(value) };
    }
    return { type: "error", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  } catch (err) {
    const id = message && typeof message === "object" && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
    if (err instanceof RpcError) {
      return { type: "error", id, error: { code: err.code, message: err.message } };
    }
    console.error(JSON.stringify({ msg: "mcp failed", error: err && err.message }));
    return { type: "error", id, error: { code: -32603, message: "internal error" } };
  }
}

function bindStmt(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length) return stmt.bind(...params);
  return stmt;
}

function d1Deps(env) {
  const source = env && env.DB;
  return {
    async queryAll(sql, params) {
      const out = await bindStmt(source, sql, params).all();
      return out.results || [];
    },
    async queryFirst(sql, params) {
      const row = await bindStmt(source, sql, params).first();
      return row ?? null;
    },
    async queryRun(sql, params) {
      return bindStmt(source, sql, params).run();
    },
    async batch(statements) {
      if (!source || typeof source.batch !== "function") throw new Error("batch is not configured");
      const prepared = statements.map((statement) => {
        const stmt = source.prepare(statement.sql);
        return statement.params && statement.params.length ? stmt.bind(...statement.params) : stmt;
      });
      const out = await source.batch(prepared);
      return Array.isArray(out) ? out : [];
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function pathOf(request) {
  const url = new URL(request.url);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) return url.pathname.slice(0, -1);
  return url.pathname;
}

function bearerOk(header, token) {
  if (typeof header !== "string" || typeof token !== "string" || token.length === 0) return false;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(match[1], token);
}

function jsonContentType(header) {
  if (!header) return false;
  const media = header.split(";", 1)[0].trim().toLowerCase();
  return media === "application/json";
}

const RESOURCE_READ = {
  ctc: { idPrefix: "ctc_", sql: `SELECT ${CONTACT_FIELDS} FROM contacts WHERE id = ?`, view: contactView },
  cal: { idPrefix: "cal_", sql: `SELECT ${EVENT_FIELDS} FROM calendar_events WHERE id = ?`, view: eventView },
  note: { idPrefix: "note_", sql: `SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?`, view: noteView },
};

function resourceFromPath(path) {
  const match = /^\/(ctc|cal|note)\/([^/]+)$/.exec(path);
  if (!match) return null;
  let id = match[2];
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return { kind: match[1], id: match[2], malformed: true };
  }
  return { kind: match[1], id };
}

function isResourceId(id, prefix) {
  return typeof id === "string" && new RegExp(`^${prefix}[a-z0-9]{12}$`).test(id);
}

export async function handleFetch(request, env, deps = {}) {
  const origin = new URL(request.url).origin;
  const path = pathOf(request);

  if (path === "/health") {
    if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
    try {
      const row = await d1Deps(env).queryFirst("SELECT 1 AS ok", []);
      if (!row) return json({ ok: false }, 503);
      return json({ ok: true });
    } catch (err) {
      console.error(JSON.stringify({ msg: "health failed", error: err && err.message }));
      return json({ ok: false }, 503);
    }
  }

  if (path === "/mcp") {
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    if (!bearerOk(request.headers.get("authorization"), env && env.DATA_MCP_TOKEN)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    if (!jsonContentType(request.headers.get("content-type"))) {
      return json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Content-Type must be application/json" } },
        415,
      );
    }
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "payload too large" } }, 413);
    }
    let message;
    try {
      message = JSON.parse(new TextDecoder("utf-8").decode(raw));
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const rpc = await handleMcpRpc(message, phase2.bindRuntime(env, { nowMs: deps.nowMs, origin }));
    if (rpc.type === "notification") return new Response(null, { status: 202 });
    if (rpc.type === "error") {
      return json({ jsonrpc: "2.0", id: rpc.id ?? null, error: rpc.error });
    }
    return json({ jsonrpc: "2.0", id: rpc.id, result: rpc.result });
  }

  const resource = resourceFromPath(path);
  if (resource) {
    if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
    if (!bearerOk(request.headers.get("authorization"), env && env.DATA_MCP_TOKEN)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const spec = RESOURCE_READ[resource.kind];
    if (resource.malformed || !isResourceId(resource.id, spec.idPrefix)) {
      return json({ found: false, id: resource.id }, 404);
    }
    try {
      const row = await d1Deps(env).queryFirst(spec.sql, [resource.id]);
      if (!row) return json({ found: false, id: resource.id }, 404);
      return json({ found: true, ...spec.view(row, origin) });
    } catch (err) {
      console.error(JSON.stringify({ msg: "resource read failed", error: err && err.message }));
      return json({ ok: false }, 500);
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

export async function handleScheduled(event, env, deps = {}) {
  return phase2.handleScheduled(event, env, deps);
}

export async function handleQueue(batch, env, deps = {}) {
  return phase2.handleQueue(batch, env, deps);
}

export async function consumeDelivery(message, env, deps = {}) {
  return phase2.consumeDelivery(message, env, deps);
}

export default {
  fetch(request, env, ctx) {
    return handleFetch(request, env, { ctx });
  },
  scheduled(event, env, ctx) {
    return handleScheduled(event, env, { ctx });
  },
  queue(batch, env, ctx) {
    return handleQueue(batch, env, { ctx });
  },
};
