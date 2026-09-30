/**
 * Phase 2 bus: events, subscriptions, deliveries, heartbeats.
 * Appended beside Phase 1. Does not change contact / calendar / note behavior.
 */

const DAY_MS = 86_400_000;
const SCAN_LIMIT = 500;
const DETECT_LIMIT = 50;
const PAYLOAD_MAX_BYTES = 4096;
const DEFAULT_EVENT_TYPES = '["watchdog.*","calendar.*"]';
const TYPE_SEGMENT = "[a-z][a-z0-9_]{0,30}";
const EVENT_TYPE_RE = new RegExp(`^${TYPE_SEGMENT}(?:\\.${TYPE_SEGMENT})+$`);
const EVENT_PREFIX_RE = new RegExp(`^${TYPE_SEGMENT}(?:\\.${TYPE_SEGMENT})*\\.\\*$`);
const DEDUPE_RE = /^[A-Za-z0-9:._-]{1,200}$/;
const AGENT_ID_RE = /^bot:[a-z0-9][a-z0-9_-]{0,31}$/;
const LEASE_RE = /^[0-9a-f]{32}$/;
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RETRY_DELAYS = [60, 120, 240];
const DELIVER_QUEUE_NAME = "botu-deliver";
const DLQ_QUEUE_NAME = "botu-deliver-dlq";
const SECRET_KEYS = new Set([
  "secret",
  "token",
  "password",
  "authorization",
  "signing_secret",
  "webhook_secret",
  "data_mcp_token",
  "mcp_token",
  "subscription_seal",
]);

function changesOf(result) {
  if (!result || typeof result !== "object") return 0;
  if (result.meta && Number.isInteger(result.meta.changes)) return result.meta.changes;
  if (Number.isInteger(result.changes)) return result.changes;
  return 0;
}

function nowMsOf(deps) {
  if (deps && typeof deps.nowMs === "number" && Number.isFinite(deps.nowMs)) return deps.nowMs;
  return Date.now();
}

let tokenEqual = (left, right) => left === right;

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(text) {
  const clean = String(text).replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new Error("bad base64");
  }
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(text) {
  if (typeof text !== "string" || text.length === 0 || /[^A-Za-z0-9_-]/.test(text)) {
    throw new Error("bad base64url");
  }
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  return base64ToBytes(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export function stableStringify(value) {
  return encodeStable(value, false);
}

function encodeStable(value, checkSecrets) {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string") {
    if (checkSecrets && value.includes("whsec_")) {
      const err = new Error("payload contains a secret");
      err.code = -32602;
      err.name = "RpcError";
      throw err;
    }
    return JSON.stringify(value);
  }
  if (kind === "boolean") return JSON.stringify(value);
  if (kind === "number") {
    if (!Number.isFinite(value)) throw payloadInvalid();
    return JSON.stringify(value);
  }
  if (kind !== "object") throw payloadInvalid();
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeStable(item, checkSecrets)).join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw payloadInvalid();
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    if (checkSecrets && SECRET_KEYS.has(key.toLowerCase())) throw payloadSecret();
    if (value[key] === undefined) throw payloadInvalid();
    parts.push(`${JSON.stringify(key)}:${encodeStable(value[key], checkSecrets)}`);
  }
  return `{${parts.join(",")}}`;
}

function payloadInvalid() {
  const err = new Error("payload is invalid");
  err.code = -32602;
  err.name = "RpcError";
  return err;
}

function payloadSecret() {
  const err = new Error("payload contains a secret");
  err.code = -32602;
  err.name = "RpcError";
  return err;
}

function asRpc(err, RpcError) {
  if (err instanceof RpcError) return err;
  if (err && err.name === "RpcError" && Number.isInteger(err.code)) return new RpcError(err.code, err.message);
  return err;
}

export function serializePayload(value) {
  const payload = value == null ? {} : value;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("payload must be an object");
    err.code = -32602;
    err.name = "RpcError";
    throw err;
  }
  const text = encodeStable(payload, true);
  if (new TextEncoder().encode(text).byteLength > PAYLOAD_MAX_BYTES) {
    const err = new Error("payload is too large");
    err.code = -32602;
    err.name = "RpcError";
    throw err;
  }
  return text;
}

export function decodeSealKey(env) {
  const raw = env && env.SUBSCRIPTION_SEAL;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const bytes = base64ToBytes(raw);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function newWebhookSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${bytesToBase64(bytes)}`;
}

function newLeaseToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function importAes(keyBytes, usages) {
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, usages);
}

async function sealSecret(secret, subscriptionId, keyBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAes(keyBytes, ["encrypt"]);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(subscriptionId) },
      key,
      new TextEncoder().encode(secret),
    ),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return bytesToBase64(out);
}

async function openSecret(sealed, subscriptionId, keyBytes) {
  const raw = base64ToBytes(sealed);
  if (raw.length < 28) throw new Error("seal");
  const iv = raw.slice(0, 12);
  const cipher = raw.slice(12);
  const key = await importAes(keyBytes, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(subscriptionId) },
    key,
    cipher,
  );
  return new TextDecoder().decode(plain);
}

export async function signWebhook(secret, timestamp, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildWebhookBody(event) {
  const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
  return stableStringify({
    id: event.id,
    type: event.type,
    dedupe_key: event.dedupe_key,
    created_at: event.created_at,
    not_before: event.not_before,
    payload,
  });
}

export async function verifyWebhookRequest({ secret, timestamp, body, signature, nowMs }) {
  const ts = typeof timestamp === "number" && Number.isFinite(timestamp) ? String(timestamp) : timestamp;
  if (typeof ts !== "string" || !/^\d+$/.test(ts)) return false;
  const nowSec = Math.floor((typeof nowMs === "number" ? nowMs : Date.now()) / 1000);
  if (Math.abs(nowSec - Number(ts)) > 300) return false;
  if (typeof signature !== "string" || typeof body !== "string" || typeof secret !== "string") return false;
  const expected = `v1=${await signWebhook(secret, ts, body)}`;
  return tokenEqual(expected, signature);
}

function encodeCursor(createdAt, id) {
  return `v1.${bytesToBase64Url(new TextEncoder().encode(`${createdAt}\n${id}`))}`;
}

function isIpAddress(host) {
  if (host.startsWith("[") || host.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function eventTypeMatches(type, filters) {
  for (const item of filters) {
    if (item === "*") return true;
    if (typeof item === "string" && item.endsWith(".*")) {
      if (type.startsWith(item.slice(0, -1))) return true;
    } else if (item === type) return true;
  }
  return false;
}

function parseFilters(eventTypes) {
  if (typeof eventTypes !== "string" || eventTypes === "") return ["watchdog.*", "calendar.*"];
  try {
    const parsed = JSON.parse(eventTypes);
    return Array.isArray(parsed) ? parsed : ["watchdog.*", "calendar.*"];
  } catch {
    return ["watchdog.*", "calendar.*"];
  }
}

function httpErrorToken(status) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 100 || code > 999) return "http_000";
  return `http_${code}`;
}

function fetchFailureToken(err) {
  const name = err && err.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "network";
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function createPhase2(api) {
  const {
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
  } = api;

  tokenEqual = timingSafeEqual;

  function raise(err) {
    throw asRpc(err, RpcError);
  }

  function serialize(value) {
    try {
      return serializePayload(value);
    } catch (err) {
      raise(err);
    }
  }

  function assertWebhookUrl(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 500) {
      throw new RpcError(-32602, "webhook url is invalid");
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new RpcError(-32602, "webhook url is invalid");
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new RpcError(-32602, "webhook url is invalid");
    }
    if (url.port !== "" && url.port !== "443") throw new RpcError(-32602, "webhook url is invalid");
    if (isIpAddress(host)) throw new RpcError(-32602, "webhook url is invalid");
    if (host === "localhost" || host === "localhost.localdomain") {
      throw new RpcError(-32602, "webhook url is invalid");
    }
    if (host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal")) {
      throw new RpcError(-32602, "webhook url is invalid");
    }
    return value;
  }

  function normalizeEventTypes(value, { allowDefault }) {
    if (value == null) {
      if (allowDefault) return DEFAULT_EVENT_TYPES;
      throw new RpcError(-32602, "event_types is invalid");
    }
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
      throw new RpcError(-32602, "event_types is invalid");
    }
    for (const item of value) {
      if (item === "*") continue;
      if (typeof item !== "string" || item.length > 66) throw new RpcError(-32602, "event_types is invalid");
      if (item.endsWith(".*")) {
        if (!EVENT_PREFIX_RE.test(item)) throw new RpcError(-32602, "event_types is invalid");
        continue;
      }
      if (item.length > 64 || !EVENT_TYPE_RE.test(item)) throw new RpcError(-32602, "event_types is invalid");
    }
    return JSON.stringify(value);
  }

  function readAgent(value, fallback) {
    if (value == null) {
      if (fallback == null) throw new RpcError(-32602, "agent_id is invalid");
      return fallback;
    }
    if (typeof value !== "string" || !AGENT_ID_RE.test(value)) throw new RpcError(-32602, "agent_id is invalid");
    return value;
  }

  function readWatch(value, fallback) {
    if (value == null) {
      if (fallback == null) throw new RpcError(-32602, "watch_heartbeat must be a boolean");
      return fallback;
    }
    if (typeof value !== "boolean") throw new RpcError(-32602, "watch_heartbeat must be a boolean");
    return value ? 1 : 0;
  }

  function readVisibility(value) {
    if (value == null) return 120;
    if (!Number.isInteger(value)) throw new RpcError(-32602, "visibility_seconds must be an integer");
    if (value < 30 || value > 900) throw new RpcError(-32602, "visibility_seconds is out of range");
    return value;
  }

  function readTtl(value) {
    if (value == null) return 600;
    if (!Number.isInteger(value)) throw new RpcError(-32602, "ttl_seconds must be an integer");
    if (value < 120 || value > 86400) throw new RpcError(-32602, "ttl_seconds is out of range");
    return value;
  }

  function readNotBefore(value, nowMs) {
    if (value == null) return new Date(nowMs).toISOString();
    const iso = canonicalUtc(value, "not_before");
    const t = Date.parse(iso);
    if (t < nowMs - 7 * DAY_MS || t > nowMs + 366 * DAY_MS) {
      throw new RpcError(-32602, "not_before is out of range");
    }
    return iso;
  }

  function assertEmitType(type) {
    if (typeof type !== "string" || type.length > 64 || !EVENT_TYPE_RE.test(type)) {
      throw new RpcError(-32602, "type is invalid");
    }
    if (type === "calendar.due" || type.startsWith("watchdog.")) {
      throw new RpcError(-32602, "type is not allowed");
    }
    return type;
  }

  function assertEmitDedupe(key) {
    if (typeof key !== "string" || !DEDUPE_RE.test(key)) throw new RpcError(-32602, "dedupe_key is invalid");
    if (key.startsWith("watchdog.") || key.startsWith("calendar.due:")) {
      throw new RpcError(-32602, "dedupe_key is not allowed");
    }
    return key;
  }

  function decodeCursor(cursor) {
    if (cursor == null) return { value: null, raw: null };
    if (cursor === "") return { value: null, raw: "" };
    if (typeof cursor !== "string" || !cursor.startsWith("v1.")) throw new RpcError(-32602, "cursor is invalid");
    let text;
    try {
      text = new TextDecoder().decode(base64UrlToBytes(cursor.slice(3)));
    } catch {
      throw new RpcError(-32602, "cursor is invalid");
    }
    const nl = text.indexOf("\n");
    if (nl <= 0 || text.indexOf("\n", nl + 1) !== -1) throw new RpcError(-32602, "cursor is invalid");
    const createdAt = text.slice(0, nl);
    const id = text.slice(nl + 1);
    if (!CURSOR_TIME_RE.test(createdAt) || !/^evt_[a-z0-9]{12}$/.test(id)) {
      throw new RpcError(-32602, "cursor is invalid");
    }
    return { value: { created_at: createdAt, id }, raw: cursor };
  }

  function requireSeal(deps) {
    const key = deps && deps.sealKey;
    if (!(key instanceof Uint8Array) || key.length !== 32) {
      throw new RpcError(-32603, "subscription seal is not configured");
    }
    return key;
  }

  async function sendDelivery(deps, deliveryId) {
    if (!deps || typeof deps.sendDelivery !== "function") throw new Error("deliver queue is not configured");
    await deps.sendDelivery(deliveryId);
  }

  async function insertDelivery(deps, eventId, subscriptionId, fields) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId("dlv_");
      try {
        await queryRun(
          deps,
          `INSERT INTO deliveries (
            id, event_id, subscription_id, state, attempts, next_attempt_at, queued_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'due', 0, ?, ?, ?, ?)`,
          [id, eventId, subscriptionId, fields.nextAttemptAt, fields.queuedAt, fields.now, fields.now],
        );
        return id;
      } catch (err) {
        if (!isUniqueError(err)) throw err;
        const existing = await queryFirst(
          deps,
          "SELECT id FROM deliveries WHERE event_id = ? AND subscription_id = ?",
          [eventId, subscriptionId],
        );
        if (existing) return null;
      }
    }
    throw new Error("delivery id entropy exhausted");
  }

  async function fanoutEvent(deps, event) {
    const subs = await queryAll(
      deps,
      "SELECT id, event_types FROM subscriptions WHERE status = 'active' AND mode = 'webhook'",
      [],
    );
    const nowMs = Date.parse(event.now);
    const visible = Date.parse(event.notBefore) <= nowMs;
    for (const sub of subs) {
      if (!eventTypeMatches(event.type, parseFilters(sub.event_types))) continue;
      const queuedAt = visible ? event.now : null;
      const nextAttemptAt = visible ? null : event.notBefore;
      const id = await insertDelivery(deps, event.id, sub.id, {
        nextAttemptAt,
        queuedAt,
        now: event.now,
      });
      if (!id || !visible) continue;
      try {
        await sendDelivery(deps, id);
      } catch (err) {
        console.error(JSON.stringify({ msg: "deliver enqueue failed", delivery_id: id, error: err && err.message }));
        await queryRun(deps, "UPDATE deliveries SET queued_at = NULL, updated_at = ? WHERE id = ?", [event.now, id]);
      }
    }
  }

  async function insertBusEvent(deps, spec) {
    const now = nowIso(deps);
    const notBefore = spec.notBefore || now;
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId("evt_");
      try {
        const result = await queryRun(
          deps,
          `INSERT INTO events (
            id, type, payload, status, dedupe_key, created_at, not_before, source, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
          ON CONFLICT(dedupe_key) WHERE status = 'pending' DO NOTHING`,
          [id, spec.type, spec.payloadText, spec.dedupeKey, now, notBefore, spec.source, now],
        );
        if (changesOf(result) === 0) {
          const existing = await queryFirst(
            deps,
            "SELECT id FROM events WHERE dedupe_key = ? AND status = 'pending'",
            [spec.dedupeKey],
          );
          if (!existing) throw new Error("dedupe conflict without row");
          return { id: existing.id, created: false };
        }
        if (spec.type !== "watchdog.queue_dlq") {
          await fanoutEvent(deps, { id, type: spec.type, notBefore, now });
        }
        return { id, created: true };
      } catch (err) {
        if (isUniqueError(err)) continue;
        throw err;
      }
    }
    throw new Error("id entropy exhausted");
  }

  async function listVisible(deps, now, { after, beforeOrEqual, expiredLeaseOnly, limit }) {
    const where = [
      "status = 'pending'",
      "not_before <= ?",
      "(leased_until IS NULL OR leased_until <= ?)",
    ];
    const params = [now, now];
    if (expiredLeaseOnly) where.push("leased_until IS NOT NULL");
    if (beforeOrEqual) {
      where.push("(created_at < ? OR (created_at = ? AND id <= ?))");
      params.push(beforeOrEqual.created_at, beforeOrEqual.created_at, beforeOrEqual.id);
    }
    if (after) {
      where.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(after.created_at, after.created_at, after.id);
    }
    params.push(limit);
    return queryAll(
      deps,
      `SELECT id, type, payload, dedupe_key, created_at, not_before, poll_count
FROM events
WHERE ${where.join(" AND ")}
ORDER BY created_at ASC, id ASC
LIMIT ?`,
      params,
    );
  }

  async function scanVisible(deps, now, cursor) {
    if (!cursor) {
      const fetched = await listVisible(deps, now, { limit: SCAN_LIMIT + 1 });
      return { scanned: fetched.slice(0, SCAN_LIMIT), moreUnseen: fetched.length > SCAN_LIMIT };
    }
    const before = await listVisible(deps, now, {
      beforeOrEqual: cursor,
      expiredLeaseOnly: true,
      limit: SCAN_LIMIT + 1,
    });
    if (before.length > SCAN_LIMIT) {
      return { scanned: before.slice(0, SCAN_LIMIT), moreUnseen: true };
    }
    if (before.length === SCAN_LIMIT) {
      const peek = await listVisible(deps, now, { after: cursor, limit: 1 });
      return { scanned: before, moreUnseen: peek.length > 0 };
    }
    const room = SCAN_LIMIT - before.length;
    const after = await listVisible(deps, now, { after: cursor, limit: room + 1 });
    return {
      scanned: before.concat(after.slice(0, room)),
      moreUnseen: after.length > room,
    };
  }

  async function existsMatchingAfter(deps, now, filters, tuple) {
    let after = tuple;
    for (let hop = 0; hop < 20; hop++) {
      const rows = await listVisible(deps, now, { after, limit: SCAN_LIMIT });
      if (!rows.length) return false;
      for (const row of rows) {
        if (eventTypeMatches(row.type, filters)) return true;
      }
      if (rows.length < SCAN_LIMIT) return false;
      const last = rows[rows.length - 1];
      after = { created_at: last.created_at, id: last.id };
    }
    return true;
  }

  async function retryAfterSeconds(deps, now, filters) {
    const rows = await queryAll(
      deps,
      `SELECT type, leased_until FROM events
WHERE status = 'pending' AND not_before <= ? AND leased_until IS NOT NULL AND leased_until > ?`,
      [now, now],
    );
    let best = null;
    for (const row of rows) {
      if (!eventTypeMatches(row.type, filters)) continue;
      const t = Date.parse(row.leased_until);
      if (Number.isNaN(t)) continue;
      if (best == null || t < best) best = t;
    }
    if (best == null) return 0;
    return Math.max(1, Math.ceil((best - Date.parse(now)) / 1000));
  }

  function subscriptionView(row) {
    let eventTypes = [];
    try {
      const parsed = JSON.parse(row.event_types);
      eventTypes = Array.isArray(parsed) ? parsed : [];
    } catch {
      eventTypes = [];
    }
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      url: row.url ?? null,
      event_types: eventTypes,
      has_secret: row.has_secret === 1 || row.has_secret === true,
      watch_heartbeat: row.watch_heartbeat === 1 || row.watch_heartbeat === true,
      agent_id: row.agent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  const SUB_VIEW_SQL = `SELECT id, mode, status, url, event_types,
  CASE WHEN secret_sealed IS NULL THEN 0 ELSE 1 END AS has_secret,
  watch_heartbeat, agent_id, created_at, updated_at
FROM subscriptions`;

  async function pollEvents(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["subscription_id", "cursor", "limit", "visibility_seconds"]));
    if (typeof args.subscription_id !== "string" || !/^sub_[a-z0-9]{12}$/.test(args.subscription_id)) {
      throw new RpcError(-32602, "subscription_id is required");
    }
    const limit = clampLimit(args.limit, 20, 100);
    const visibility = readVisibility(args.visibility_seconds);
    const cursor = decodeCursor(has(args, "cursor") ? args.cursor : null);
    const sub = await queryFirst(deps, `${SUB_VIEW_SQL} WHERE id = ?`, [args.subscription_id]);
    if (!sub) throw notFound();
    if (sub.status === "paused") throw new RpcError(-32602, "subscription paused");
    if (sub.mode !== "poll" && sub.mode !== "webhook") throw notFound();
    const filters = parseFilters(sub.event_types);
    const now = nowIso(deps);
    const scanned = await scanVisible(deps, now, cursor.value);
    const matches = [];
    let lastScanned = null;
    for (const row of scanned.scanned) {
      lastScanned = row;
      if (!eventTypeMatches(row.type, filters)) continue;
      matches.push(row);
      if (matches.length === limit) break;
    }
    const hitScanCap = matches.length < limit && scanned.moreUnseen && lastScanned;
    const leasedUntil = new Date(Date.parse(now) + visibility * 1000).toISOString();
    const tokens = matches.map(() => newLeaseToken());
    let won = [];
    if (matches.length) {
      if (!deps || typeof deps.batch !== "function") throw new Error("batch is not configured");
      const results = await deps.batch(
        matches.map((row, i) => ({
          sql: `UPDATE events
SET leased_until = ?, lease_token = ?, poll_count = poll_count + 1, updated_at = ?
WHERE id = ? AND status = 'pending' AND not_before <= ? AND (leased_until IS NULL OR leased_until <= ?)`,
          params: [leasedUntil, tokens[i], now, row.id, now, now],
        })),
      );
      for (let i = 0; i < matches.length; i++) {
        if (changesOf(results[i]) === 1) won.push({ row: matches[i], token: tokens[i] });
      }
    }
    const events = won.map(({ row, token }) => ({
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload),
      dedupe_key: row.dedupe_key,
      created_at: row.created_at,
      not_before: row.not_before,
      lease_token: token,
      leased_until: leasedUntil,
      poll_count: Number(row.poll_count) + 1,
    }));
    let hasMore = false;
    if (hitScanCap) hasMore = true;
    else if (events.length === limit) {
      const last = events[events.length - 1];
      hasMore = await existsMatchingAfter(deps, now, filters, { created_at: last.created_at, id: last.id });
    }
    let nextCursor = null;
    if (hitScanCap) nextCursor = encodeCursor(lastScanned.created_at, lastScanned.id);
    else if (events.length) nextCursor = encodeCursor(events[events.length - 1].created_at, events[events.length - 1].id);
    else nextCursor = cursor.raw;
    const retry = events.length === 0 && !hasMore ? await retryAfterSeconds(deps, now, filters) : 0;
    return { events, next_cursor: nextCursor, has_more: hasMore, retry_after_seconds: retry };
  }

  async function ackEvent(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id", "lease_token"]));
    const id = requireId(args.id, "evt_");
    if (!has(args, "lease_token") || args.lease_token == null || args.lease_token === "") {
      throw new RpcError(-32602, "lease_token is required");
    }
    if (typeof args.lease_token !== "string") throw new RpcError(-32602, "lease_token is required");
    const now = nowIso(deps);
    let changes = 0;
    if (LEASE_RE.test(args.lease_token)) {
      const result = await queryRun(
        deps,
        `UPDATE events
SET status = 'acked', acked_at = ?, leased_until = NULL, lease_token = NULL, updated_at = ?
WHERE id = ? AND status = 'pending' AND lease_token = ?`,
        [now, now, id, args.lease_token],
      );
      changes = changesOf(result);
    }
    if (changes === 1) {
      const row = await queryFirst(deps, "SELECT id, created_at, status FROM events WHERE id = ?", [id]);
      return { id, status: "acked", idempotent: false, ack_cursor: encodeCursor(row.created_at, row.id) };
    }
    const row = await queryFirst(deps, "SELECT id, status, created_at FROM events WHERE id = ?", [id]);
    if (!row) throw notFound();
    if (row.status === "acked") {
      return { id, status: "acked", idempotent: true, ack_cursor: encodeCursor(row.created_at, row.id) };
    }
    throw new RpcError(-32602, "lease mismatch");
  }

  async function heartbeat(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["agent_id", "ttl_seconds"]));
    const agentId = readAgent(has(args, "agent_id") ? args.agent_id : null, "bot:main");
    const ttl = readTtl(has(args, "ttl_seconds") ? args.ttl_seconds : null);
    const now = nowIso(deps);
    await queryRun(
      deps,
      `INSERT INTO heartbeats (agent_id, seen_at, ttl_seconds, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(agent_id) DO UPDATE SET
  seen_at = excluded.seen_at,
  ttl_seconds = excluded.ttl_seconds,
  updated_at = excluded.updated_at`,
      [agentId, now, ttl, now],
    );
    return { agent_id: agentId, seen_at: now, ttl_seconds: ttl };
  }

  async function emitEvent(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["type", "dedupe_key", "payload", "not_before"]));
    const type = assertEmitType(args.type);
    const dedupeKey = assertEmitDedupe(args.dedupe_key);
    const payloadText = serialize(has(args, "payload") ? args.payload : {});
    const notBefore = readNotBefore(has(args, "not_before") ? args.not_before : null, nowMsOf(deps));
    return insertBusEvent(deps, { type, dedupeKey, payloadText, notBefore, source: "emit" });
  }

  async function createSubscription(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["mode", "url", "event_types", "watch_heartbeat", "agent_id"]));
    if (!has(args, "mode")) throw new RpcError(-32602, "mode is required");
    if (args.mode !== "poll" && args.mode !== "webhook") throw new RpcError(-32602, "mode must be poll or webhook");
    const eventTypes = normalizeEventTypes(has(args, "event_types") ? args.event_types : null, { allowDefault: true });
    const watch = readWatch(has(args, "watch_heartbeat") ? args.watch_heartbeat : null, 1);
    const agentId = readAgent(has(args, "agent_id") ? args.agent_id : null, "bot:main");
    let url = null;
    if (args.mode === "poll") {
      if (has(args, "url")) throw new RpcError(-32602, "url is not allowed");
    } else {
      if (!has(args, "url") || args.url == null || args.url === "") throw new RpcError(-32602, "url is required");
      url = assertWebhookUrl(args.url);
    }
    const now = nowIso(deps);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId("sub_");
      let secret = null;
      let sealed = null;
      if (args.mode === "webhook") {
        const key = requireSeal(deps);
        secret = newWebhookSecret();
        sealed = await sealSecret(secret, id, key);
      }
      try {
        await queryRun(
          deps,
          `INSERT INTO subscriptions (
            id, mode, status, url, event_types, secret_sealed, watch_heartbeat, agent_id, created_at, updated_at
          ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
          [id, args.mode, url, eventTypes, sealed, watch, agentId, now, now],
        );
        const out = { id, mode: args.mode, status: "active" };
        if (secret) out.secret = secret;
        return out;
      } catch (err) {
        if (!isUniqueError(err)) throw err;
      }
    }
    throw new Error("id entropy exhausted");
  }

  async function getSubscription(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id"]));
    const id = requireId(args.id, "sub_");
    const row = await queryFirst(deps, `${SUB_VIEW_SQL} WHERE id = ?`, [id]);
    if (!row) throw notFound();
    return subscriptionView(row);
  }

  async function listSubscriptions(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["limit"]));
    const limit = clampLimit(args.limit, 20, 100);
    const rows = await queryAll(
      deps,
      `${SUB_VIEW_SQL}
ORDER BY created_at ASC, id ASC
LIMIT ?`,
      [limit],
    );
    return rows.map(subscriptionView);
  }

  async function updateSubscription(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id", "url", "event_types", "status", "watch_heartbeat", "agent_id"]));
    const id = requireId(args.id, "sub_");
    const existing = await queryFirst(deps, "SELECT id, mode, status FROM subscriptions WHERE id = ?", [id]);
    if (!existing) throw notFound();
    const sets = [];
    const params = [];
    if (has(args, "url")) {
      if (existing.mode !== "webhook") throw new RpcError(-32602, "url is not allowed");
      sets.push("url = ?");
      params.push(assertWebhookUrl(args.url));
    }
    if (has(args, "event_types")) {
      sets.push("event_types = ?");
      params.push(normalizeEventTypes(args.event_types, { allowDefault: false }));
    }
    let status = null;
    if (has(args, "status")) {
      if (args.status !== "active" && args.status !== "paused") {
        throw new RpcError(-32602, "status must be active or paused");
      }
      status = args.status;
      sets.push("status = ?");
      params.push(status);
    }
    if (has(args, "watch_heartbeat")) {
      sets.push("watch_heartbeat = ?");
      params.push(readWatch(args.watch_heartbeat, null));
    }
    if (has(args, "agent_id")) {
      sets.push("agent_id = ?");
      params.push(readAgent(args.agent_id, null));
    }
    if (sets.length === 0) throw new RpcError(-32602, "no fields to update");
    const now = nowIso(deps);
    sets.push("updated_at = ?");
    params.push(now, id);
    await queryRun(deps, `UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`, params);
    if (status === "paused") {
      await queryRun(
        deps,
        `UPDATE deliveries SET state = 'paused', updated_at = ?
WHERE subscription_id = ? AND state IN ('due', 'inflight')`,
        [now, id],
      );
    } else if (status === "active") {
      await queryRun(
        deps,
        `UPDATE deliveries SET state = 'due', next_attempt_at = NULL, queued_at = NULL, updated_at = ?
WHERE subscription_id = ? AND state = 'paused'`,
        [now, id],
      );
    }
    const row = await queryFirst(deps, `${SUB_VIEW_SQL} WHERE id = ?`, [id]);
    return subscriptionView(row);
  }

  async function deleteSubscription(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id"]));
    const id = requireId(args.id, "sub_");
    const existing = await queryFirst(deps, "SELECT id FROM subscriptions WHERE id = ?", [id]);
    if (!existing) throw notFound();
    const now = nowIso(deps);
    await queryRun(
      deps,
      `UPDATE deliveries SET state = 'dead', dead_reason = 'subscription_deleted', updated_at = ?
WHERE subscription_id = ? AND state IN ('due', 'inflight', 'paused')`,
      [now, id],
    );
    await queryRun(deps, "DELETE FROM subscriptions WHERE id = ?", [id]);
    return { id, deleted: true };
  }

  async function rotateSubscriptionSecret(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id"]));
    const id = requireId(args.id, "sub_");
    const existing = await queryFirst(deps, "SELECT id, mode FROM subscriptions WHERE id = ?", [id]);
    if (!existing) throw notFound();
    if (existing.mode !== "webhook") throw new RpcError(-32602, "subscription has no webhook secret");
    const key = requireSeal(deps);
    const secret = newWebhookSecret();
    const sealed = await sealSecret(secret, id, key);
    const now = nowIso(deps);
    await queryRun(deps, "UPDATE subscriptions SET secret_sealed = ?, updated_at = ? WHERE id = ?", [sealed, now, id]);
    return { id, secret };
  }

  async function detectCalendarDue(deps) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    const left = new Date(nowMs - 7 * DAY_MS).toISOString();
    const rows = await queryAll(
      deps,
      `SELECT id, title, start_utc, end_utc, timezone, all_day, location
FROM calendar_events
WHERE status = 'confirmed'
  AND start_utc <= ?
  AND start_utc >= ?
ORDER BY start_utc ASC, id ASC
LIMIT ?`,
      [now, left, DETECT_LIMIT],
    );
    for (const row of rows) {
      const payload = {
        all_day: row.all_day === 1 || row.all_day === true,
        calendar_event_id: row.id,
        end_utc: row.end_utc || "",
        location: row.location ?? null,
        path: `/cal/${row.id}`,
        start_utc: row.start_utc || "",
        timezone: row.timezone || "",
        title: row.title || "",
      };
      await insertBusEvent(deps, {
        type: "calendar.due",
        dedupeKey: `calendar.due:${row.id}:${row.start_utc}`,
        payloadText: stableStringify(payload),
        notBefore: now,
        source: "detector",
      });
    }
  }

  async function detectStaleHeartbeats(deps) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    const agents = await queryAll(
      deps,
      `SELECT agent_id FROM subscriptions
WHERE status = 'active' AND watch_heartbeat = 1
GROUP BY agent_id
ORDER BY agent_id ASC
LIMIT ?`,
      [DETECT_LIMIT],
    );
    for (const agent of agents) {
      const beat = await queryFirst(
        deps,
        "SELECT agent_id, seen_at, ttl_seconds FROM heartbeats WHERE agent_id = ?",
        [agent.agent_id],
      );
      if (!beat) continue;
      const seenMs = Date.parse(beat.seen_at);
      const ttl = Number(beat.ttl_seconds);
      if (Number.isNaN(seenMs) || !Number.isFinite(ttl)) continue;
      if (seenMs + ttl * 1000 >= nowMs) continue;
      const staleFor = Math.max(0, Math.floor((nowMs - seenMs) / 1000) - ttl);
      const payload = {
        agent_id: beat.agent_id,
        observed_at: now,
        seen_at: beat.seen_at,
        stale_for_seconds: staleFor,
        ttl_seconds: ttl,
      };
      await insertBusEvent(deps, {
        type: "watchdog.heartbeat_stale",
        dedupeKey: `watchdog.heartbeat_stale:${beat.agent_id}`,
        payloadText: stableStringify(payload),
        notBefore: now,
        source: "detector",
      });
    }
  }

  async function detectDeadDeliveries(deps) {
    const now = nowIso(deps);
    const rows = await queryAll(
      deps,
      `SELECT id, event_id, subscription_id, attempts, dead_reason, last_error
FROM deliveries
WHERE state = 'dead' AND dead_reason != 'subscription_deleted'
ORDER BY updated_at ASC, id ASC
LIMIT ?`,
      [DETECT_LIMIT],
    );
    for (const row of rows) {
      const event = await queryFirst(deps, "SELECT id, type FROM events WHERE id = ?", [row.event_id]);
      if (!event) continue;
      const payload = {
        attempts: Number(row.attempts) || 0,
        dead_reason: row.dead_reason || "",
        delivery_id: row.id,
        event_id: row.event_id,
        event_type: event.type || "",
        last_error: row.last_error || "",
        queue: DLQ_QUEUE_NAME,
        subscription_id: row.subscription_id,
      };
      await insertBusEvent(deps, {
        type: "watchdog.queue_dlq",
        dedupeKey: `watchdog.queue_dlq:${row.id}`,
        payloadText: stableStringify(payload),
        notBefore: now,
        source: "detector",
      });
    }
  }

  async function requeueDueDeliveries(deps) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    const cutoff = new Date(nowMs - 900 * 1000).toISOString();
    const rows = await queryAll(
      deps,
      `SELECT id FROM deliveries
WHERE state = 'due'
  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  AND (queued_at IS NULL OR queued_at <= ?)
LIMIT ?`,
      [now, cutoff, DETECT_LIMIT],
    );
    for (const row of rows) {
      await queryRun(
        deps,
        "UPDATE deliveries SET queued_at = ?, updated_at = ? WHERE id = ? AND state = 'due'",
        [now, now, row.id],
      );
      try {
        await sendDelivery(deps, row.id);
      } catch (err) {
        console.error(JSON.stringify({ msg: "deliver requeue failed", delivery_id: row.id, error: err && err.message }));
        await queryRun(deps, "UPDATE deliveries SET queued_at = NULL, updated_at = ? WHERE id = ?", [now, row.id]);
      }
    }
  }

  async function reclaimStuckInflight(deps) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    const stuckBefore = new Date(nowMs - 180 * 1000).toISOString();
    await queryRun(
      deps,
      `UPDATE deliveries
SET state = 'due', queued_at = NULL, updated_at = ?
WHERE state = 'inflight' AND inflight_at IS NOT NULL AND inflight_at <= ?`,
      [now, stuckBefore],
    );
  }

  async function loadDeliveryContext(env, deliveryId) {
    const db = d1Deps(env);
    const delivery = await db.queryFirst("SELECT * FROM deliveries WHERE id = ?", [deliveryId]);
    if (!delivery) return { db, delivery: null, event: null, subscription: null };
    const event = await db.queryFirst(
      "SELECT id, type, payload, dedupe_key, created_at, not_before, status FROM events WHERE id = ?",
      [delivery.event_id],
    );
    const subscription = await db.queryFirst(
      "SELECT id, mode, status, url, secret_sealed FROM subscriptions WHERE id = ?",
      [delivery.subscription_id],
    );
    return { db, delivery, event, subscription };
  }

  async function markDead(db, id, deadReason, lastError, attempts, now) {
    await db.queryRun(
      `UPDATE deliveries
SET state = 'dead', dead_reason = ?, last_error = ?, attempts = ?, updated_at = ?
WHERE id = ?`,
      [deadReason, lastError, attempts, now, id],
    );
  }

  async function failDelivery(db, delivery, lastError, nowMs) {
    const attempts = Number(delivery.attempts) + 1;
    const now = new Date(nowMs).toISOString();
    if (attempts >= 4) {
      await markDead(db, delivery.id, "retries_exhausted", lastError, attempts, now);
      console.log(
        JSON.stringify({
          msg: "deliver",
          delivery_id: delivery.id,
          event_id: delivery.event_id,
          state: "dead",
          last_error: lastError,
        }),
      );
      return { action: "ack" };
    }
    const delay = RETRY_DELAYS[attempts - 1];
    const next = new Date(nowMs + delay * 1000).toISOString();
    await db.queryRun(
      `UPDATE deliveries
SET state = 'due', attempts = ?, next_attempt_at = ?, last_error = ?, queued_at = ?, updated_at = ?
WHERE id = ?`,
      [attempts, next, lastError, now, now, delivery.id],
    );
    console.log(
      JSON.stringify({
        msg: "deliver",
        delivery_id: delivery.id,
        event_id: delivery.event_id,
        state: "due",
        last_error: lastError,
      }),
    );
    return { action: "retry", delaySeconds: delay };
  }

  async function consumeDelivery(message, env, deps = {}) {
    const body = message && message.body;
    const deliveryId = body && typeof body === "object" && !Array.isArray(body) ? body.delivery_id : null;
    if (typeof deliveryId !== "string" || !/^dlv_[a-z0-9]{12}$/.test(deliveryId)) return { action: "ack" };
    const ctx = await loadDeliveryContext(env, deliveryId);
    const { db, delivery } = ctx;
    if (!delivery || delivery.state === "succeeded" || delivery.state === "dead") return { action: "ack" };
    const sub = ctx.subscription;
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    if (!sub || sub.mode !== "webhook" || sub.status !== "active") {
      if (sub && sub.status === "paused" && delivery.state === "inflight") {
        await db.queryRun(
          "UPDATE deliveries SET state = 'paused', updated_at = ? WHERE id = ? AND state = 'inflight'",
          [now, delivery.id],
        );
      }
      return { action: "ack" };
    }
    const cas = await db.queryRun(
      `UPDATE deliveries SET state = 'inflight', inflight_at = ?, updated_at = ?
WHERE id = ? AND state IN ('due', 'inflight')`,
      [now, now, delivery.id],
    );
    if (changesOf(cas) !== 1) return { action: "ack" };
    if (!ctx.event) {
      await markDead(db, delivery.id, "retries_exhausted", delivery.last_error || "handler_crash", Number(delivery.attempts), now);
      return { action: "ack" };
    }
    let secret;
    try {
      const key = decodeSealKey(env);
      if (!key || typeof sub.secret_sealed !== "string" || sub.secret_sealed === "") throw new Error("seal");
      secret = await openSecret(sub.secret_sealed, sub.id, key);
    } catch (err) {
      console.error(JSON.stringify({ msg: "deliver", delivery_id: delivery.id, state: "dead", last_error: "seal_error" }));
      await db.queryRun(
        `UPDATE deliveries
SET state = 'dead', dead_reason = 'seal_error', last_error = 'seal_error', updated_at = ?
WHERE id = ?`,
        [now, delivery.id],
      );
      return { action: "ack" };
    }
    const bodyText = buildWebhookBody(ctx.event);
    const timestamp = String(Math.floor(nowMs / 1000));
    const signature = await signWebhook(secret, timestamp, bodyText);
    const fetchImpl = deps.fetch || fetch;
    let response;
    try {
      response = await fetchImpl(sub.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json; charset=utf-8",
          "user-agent": "botu-data-webhook/1",
          "x-botu-timestamp": timestamp,
          "x-botu-event-id": ctx.event.id,
          "x-botu-subscription-id": sub.id,
          "x-botu-signature": `v1=${signature}`,
        },
        body: bodyText,
      });
    } catch (err) {
      return failDelivery(db, delivery, fetchFailureToken(err), nowMs);
    }
    const status = response && Number(response.status);
    if (status >= 200 && status < 300) {
      await db.queryRun("UPDATE deliveries SET state = 'succeeded', updated_at = ? WHERE id = ?", [now, delivery.id]);
      console.log(
        JSON.stringify({
          msg: "deliver",
          delivery_id: delivery.id,
          event_id: ctx.event.id,
          type: ctx.event.type,
          state: "succeeded",
        }),
      );
      return { action: "ack" };
    }
    if (isRetryableStatus(status)) return failDelivery(db, delivery, httpErrorToken(status), nowMs);
    const token = httpErrorToken(status);
    await markDead(db, delivery.id, "http_status", token, Number(delivery.attempts) + 1, now);
    console.log(
      JSON.stringify({
        msg: "deliver",
        delivery_id: delivery.id,
        event_id: ctx.event.id,
        type: ctx.event.type,
        state: "dead",
        last_error: token,
      }),
    );
    return { action: "ack" };
  }

  async function consumeDeadDelivery(message, env, deps = {}) {
    const body = message && message.body;
    const deliveryId = body && typeof body === "object" && !Array.isArray(body) ? body.delivery_id : null;
    if (typeof deliveryId !== "string") return { action: "ack" };
    const db = d1Deps(env);
    const delivery = await db.queryFirst("SELECT id, state, last_error FROM deliveries WHERE id = ?", [deliveryId]);
    if (!delivery || delivery.state === "succeeded" || delivery.state === "dead") return { action: "ack" };
    const now = new Date(nowMsOf(deps)).toISOString();
    const lastError = delivery.last_error || "handler_crash";
    await db.queryRun(
      `UPDATE deliveries
SET state = 'dead', dead_reason = 'retries_exhausted', last_error = ?, updated_at = ?
WHERE id = ? AND state NOT IN ('succeeded', 'dead')`,
      [lastError, now, delivery.id],
    );
    console.log(
      JSON.stringify({
        msg: "deliver",
        delivery_id: delivery.id,
        state: "dead",
        last_error: lastError,
      }),
    );
    return { action: "ack" };
  }

  async function handleScheduled(_event, env, deps = {}) {
    const ctx = bindRuntime(env, deps);
    await detectCalendarDue(ctx);
    await detectStaleHeartbeats(ctx);
    await detectDeadDeliveries(ctx);
    await requeueDueDeliveries(ctx);
    await reclaimStuckInflight(ctx);
  }

  async function handleQueue(batch, env, deps = {}) {
    const dead = batch && batch.queue === DLQ_QUEUE_NAME;
    for (const message of (batch && batch.messages) || []) {
      try {
        const decision = dead
          ? await consumeDeadDelivery(message, env, deps)
          : await consumeDelivery(message, env, deps);
        if (decision.action === "retry") message.retry({ delaySeconds: decision.delaySeconds });
        else message.ack();
      } catch (err) {
        console.error(JSON.stringify({ msg: "deliver failed", error: err && err.message }));
        throw err;
      }
    }
  }

  function bindRuntime(env, deps) {
    const db = d1Deps(env);
    return {
      queryAll: (sql, params) => db.queryAll(sql, params),
      queryFirst: (sql, params) => db.queryFirst(sql, params),
      queryRun: (sql, params) => db.queryRun(sql, params),
      batch: (statements) => db.batch(statements),
      nowMs: deps && deps.nowMs,
      origin: deps && deps.origin,
      sealKey: decodeSealKey(env),
      async sendDelivery(deliveryId) {
        const queue = env && env.DELIVER_QUEUE;
        if (!queue || typeof queue.send !== "function") throw new Error("deliver queue is not configured");
        await queue.send({ delivery_id: deliveryId });
      },
    };
  }

  const tools = [
    {
      name: "poll_events",
      description:
        "按订阅认领可见的 pending 事件。cursor 只翻页，不表示完成。返回 events、next_cursor、has_more、retry_after_seconds。",
      inputSchema: {
        type: "object",
        properties: {
          subscription_id: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          visibility_seconds: { type: "integer", minimum: 30, maximum: 900, default: 120 },
        },
        required: ["subscription_id"],
        additionalProperties: false,
      },
    },
    {
      name: "ack_event",
      description: "用 poll 返回的 lease_token 完成一条事件。重复 ack 返回 idempotent true。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          lease_token: { type: "string" },
        },
        required: ["id", "lease_token"],
        additionalProperties: false,
      },
    },
    {
      name: "heartbeat",
      description: "agent 报到。默认 agent_id 为 bot:main，ttl_seconds 默认 600。不修改事件。",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          ttl_seconds: { type: "integer", minimum: 120, maximum: 86400, default: 600 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "emit_event",
      description: "写入一条总线事件。拒绝 watchdog.* 和 calendar.due。新插入成功才扇出 webhook。",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          dedupe_key: { type: "string" },
          payload: { type: "object" },
          not_before: { type: "string" },
        },
        required: ["type", "dedupe_key"],
        additionalProperties: false,
      },
    },
    {
      name: "create_subscription",
      description: "创建 poll 或 webhook 订阅。webhook 的 secret 只在这次响应里出现。",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["poll", "webhook"] },
          url: { type: "string" },
          event_types: { type: "array", items: { type: "string" } },
          watch_heartbeat: { type: "boolean" },
          agent_id: { type: "string" },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    },
    {
      name: "get_subscription",
      description: "读取一条订阅。不含密钥。未找到是 not found。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "list_subscriptions",
      description: "按 created_at、id 升序列出订阅。limit 默认 20，最大 100。不含密钥。",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "update_subscription",
      description: "更新订阅的 url、过滤器、status、心跳监视或 agent_id。不能改 mode。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          event_types: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["active", "paused"] },
          watch_heartbeat: { type: "boolean" },
          agent_id: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_subscription",
      description: "硬删除订阅，并把未终态投递标成 dead，dead_reason 为 subscription_deleted。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "rotate_subscription_secret",
      description: "轮换 webhook 订阅密钥。新密钥只在这次响应里出现。poll 订阅会拒绝。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];

  const handlers = {
    poll_events: pollEvents,
    ack_event: ackEvent,
    heartbeat,
    emit_event: emitEvent,
    create_subscription: createSubscription,
    get_subscription: getSubscription,
    list_subscriptions: listSubscriptions,
    update_subscription: updateSubscription,
    delete_subscription: deleteSubscription,
    rotate_subscription_secret: rotateSubscriptionSecret,
  };

  return {
    tools,
    handlers,
    handleScheduled,
    handleQueue,
    consumeDelivery,
    consumeDeadDelivery,
    bindRuntime,
    DELIVER_QUEUE_NAME,
    DLQ_QUEUE_NAME,
  };
}
