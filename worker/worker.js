/**
 * abot.run mail archive.
 * POST /      Resend webhook (Svix): verify, enqueue, return
 * queue       mail-ingest consumer: Resend API → D1 + R2
 * POST /mcp   MCP (Streamable HTTP, JSON-RPC), Bearer MCP_TOKEN
 *             reads may use the Cache API after auth; HTTP responses stay no-store
 *             search/list/stats/get_email keys include a D1 revision bumped on insert
 * GET /health public counts only (never cached)
 *
 * Secrets come from the Worker env: WEBHOOK_SECRET, RESEND_API_KEY, MCP_TOKEN.
 */

const TIMESTAMP_TOLERANCE_SEC = 5 * 60;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1_000_000;
/** Deliveries after this many attempts are recorded and acknowledged. */
export const INGEST_MAX_RETRIES = 3;
/** First retry waits this long; each later retry doubles it. */
export const INGEST_RETRY_BASE_SEC = 60;

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

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const normalized = String(b64).replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const bin = atob(normalized + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function decodeWebhookSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) {
    throw new Error("invalid webhook secret");
  }
  return base64ToBytes(secret.slice("whsec_".length));
}

function concatBytes(prefix, body) {
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

async function hmacSha256Base64(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, messageBytes);
  return bytesToBase64(new Uint8Array(sig));
}

/**
 * Verify a Svix webhook signature.
 * rawBody is the exact request bytes (or a UTF-8 string of those bytes).
 * Returns { ok, reason }.
 */
export async function verifySvixSignature({
  secret,
  svixId,
  svixTimestamp,
  svixSignature,
  rawBody,
  nowMs = Date.now(),
}) {
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, reason: "missing_header" };
  }
  if (!/^\d+$/.test(String(svixTimestamp))) {
    return { ok: false, reason: "bad_timestamp" };
  }
  const ts = Number(svixTimestamp);
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - ts) > TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  let keyBytes;
  try {
    keyBytes = decodeWebhookSecret(secret);
  } catch {
    return { ok: false, reason: "bad_secret" };
  }

  const bodyBytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : new Uint8Array(rawBody);
  const prefix = new TextEncoder().encode(`${svixId}.${svixTimestamp}.`);
  const expected = await hmacSha256Base64(keyBytes, concatBytes(prefix, bodyBytes));

  const parts = String(svixSignature).split(/\s+/).filter(Boolean).slice(0, 10);
  let matched = false;
  for (const part of parts) {
    const comma = part.indexOf(",");
    if (comma <= 0) {
      matched = matched || false;
      continue;
    }
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    const same = version === "v1" && timingSafeEqual(sig, expected);
    matched = matched || same;
  }
  return matched ? { ok: true } : { ok: false, reason: "bad_signature" };
}

export function isSafeResendId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");
}

export function rawObjectKey(resendId) {
  return `raw/${resendId}.eml`;
}

export function buildAttachmentKey(resendId, filename, used) {
  const rawName = String(filename ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
  let base = rawName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  if (!base) base = "attachment";
  let name = base;
  let key = `attachments/${resendId}/${name}`;
  let n = 2;
  while (used.has(key)) {
    name = `${n}-${base}`;
    key = `attachments/${resendId}/${name}`;
    n += 1;
  }
  used.add(key);
  return key;
}

export function assertAllowedDownloadUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid download url");
  }
  if (parsed.protocol !== "https:") throw new Error("refusing non-https download");
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "resend.com" ||
    host.endsWith(".resend.com") ||
    host === "resend.app" ||
    host.endsWith(".resend.app") ||
    host === "resend.dev" ||
    host.endsWith(".resend.dev");
  if (!allowed) throw new Error("refusing unexpected download host");
  return parsed.toString();
}

export function safeContentType(value) {
  if (typeof value !== "string") return "application/octet-stream";
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(trimmed)) {
    return "application/octet-stream";
  }
  return trimmed;
}

function headerValue(email, name) {
  const headers = email && email.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function unwrapHeader(value) {
  if (Array.isArray(value)) return unwrapHeader(value[0]);
  if (value == null) return "";
  let s = String(value).trim();
  while (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/** Parse a Date header or ISO string into UTC ISO8601, or null. */
export function parseEmailDate(value) {
  const s = unwrapHeader(value);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

export function pickEmailDate(email, eventCreatedAt, nowMs = Date.now()) {
  return (
    parseEmailDate(headerValue(email, "date")) ||
    parseEmailDate(email && email.created_at) ||
    parseEmailDate(eventCreatedAt) ||
    new Date(nowMs).toISOString()
  );
}

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
  }
  if (typeof value === "string") return [value];
  return [JSON.stringify(value)];
}

export function mapEmailForStorage(email, { direction, eventCreatedAt, attachments, nowMs }) {
  const auth =
    direction === "in" && email && email.authentication
      ? {
          spf: email.authentication.spf ?? null,
          dkim: email.authentication.dkim ?? null,
          dmarc: email.authentication.dmarc ?? null,
        }
      : null;
  return {
    resend_id: email.id,
    direction,
    msg_from: email.from ?? null,
    msg_to: JSON.stringify(asArray(email.to)),
    cc: JSON.stringify(asArray(email.cc)),
    subject: email.subject ?? null,
    date: pickEmailDate(email, eventCreatedAt, nowMs),
    text_body: email.text ?? null,
    html_body: email.html ?? null,
    message_id: email.message_id || unwrapHeader(headerValue(email, "message-id")) || null,
    auth: auth ? JSON.stringify(auth) : null,
    attachments: JSON.stringify(attachments),
  };
}

export function likeContains(value) {
  const escaped = String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

export function canonicalBound(value, edge) {
  if (typeof value !== "string") throw new RpcError(-32602, "date must be a string");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === "end" ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new RpcError(-32602, "date must be ISO8601");
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new RpcError(-32602, "date must be ISO8601");
  return new Date(t).toISOString();
}

function clampLimit(limit) {
  if (limit == null) return 20;
  if (!Number.isInteger(limit)) throw new RpcError(-32602, "limit must be an integer");
  if (limit < 1) throw new RpcError(-32602, "limit must be >= 1");
  return Math.min(limit, 100);
}

function assertDirection(direction) {
  if (direction == null) return;
  if (direction !== "in" && direction !== "out") {
    throw new RpcError(-32602, "direction must be in or out");
  }
}

function assertOnlyKeys(obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new RpcError(-32602, `unexpected argument: ${key}`);
  }
}

function assertOptionalFresh(args) {
  if (!Object.prototype.hasOwnProperty.call(args, "fresh") || args.fresh == null) return;
  if (typeof args.fresh !== "boolean") throw new RpcError(-32602, "fresh must be a boolean");
}

const METADATA_SELECT = `
  resend_id,
  direction,
  msg_from,
  msg_to,
  cc,
  subject,
  date,
  message_id,
  attachments,
  created_at,
  CASE WHEN text_body IS NOT NULL AND text_body != '' THEN 1 ELSE 0 END AS has_text,
  CASE WHEN html_body IS NOT NULL AND html_body != '' THEN 1 ELSE 0 END AS has_html`.trim();

export function buildExistsQuery(resendId) {
  return {
    sql: "SELECT resend_id FROM emails WHERE resend_id = ?",
    params: [resendId],
  };
}

export function buildInsertQuery(row) {
  return {
    sql: `INSERT OR IGNORE INTO emails (
      resend_id, direction, msg_from, msg_to, cc, subject, date,
      text_body, html_body, message_id, auth, attachments
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.resend_id,
      row.direction,
      row.msg_from,
      row.msg_to,
      row.cc,
      row.subject,
      row.date,
      row.text_body,
      row.html_body,
      row.message_id,
      row.auth,
      row.attachments,
    ],
  };
}

export function buildSearchQuery(input) {
  const args = input || {};
  assertOnlyKeys(args, new Set(["query", "from", "to", "since", "until", "direction", "limit", "fresh"]));
  assertOptionalFresh(args);
  if (typeof args.query !== "string" || args.query.trim() === "") {
    throw new RpcError(-32602, "query is required");
  }
  if (args.query.length > 500) throw new RpcError(-32602, "query is too long");
  if (args.from != null && typeof args.from !== "string") throw new RpcError(-32602, "from must be a string");
  if (args.to != null && typeof args.to !== "string") throw new RpcError(-32602, "to must be a string");
  assertDirection(args.direction);
  const limit = clampLimit(args.limit);
  const pattern = likeContains(args.query);
  const where = ["(subject LIKE ? ESCAPE '\\' OR msg_from LIKE ? ESCAPE '\\' OR text_body LIKE ? ESCAPE '\\')"];
  const params = [pattern, pattern, pattern];
  if (args.from != null && args.from !== "") {
    where.push("msg_from LIKE ? ESCAPE '\\'");
    params.push(likeContains(args.from));
  }
  if (args.to != null && args.to !== "") {
    where.push("msg_to LIKE ? ESCAPE '\\'");
    params.push(likeContains(args.to));
  }
  if (args.since != null) {
    where.push("date >= ?");
    params.push(canonicalBound(args.since, "start"));
  }
  if (args.until != null) {
    where.push("date <= ?");
    params.push(canonicalBound(args.until, "end"));
  }
  if (args.direction != null) {
    where.push("direction = ?");
    params.push(args.direction);
  }
  params.push(limit);
  return {
    sql: `SELECT ${METADATA_SELECT}
FROM emails
WHERE ${where.join("\n  AND ")}
ORDER BY date DESC, resend_id DESC
LIMIT ?`,
    params,
  };
}

export function buildListQuery(input) {
  const args = input || {};
  assertOnlyKeys(args, new Set(["limit", "direction", "since", "fresh"]));
  assertOptionalFresh(args);
  assertDirection(args.direction);
  const limit = clampLimit(args.limit);
  const where = [];
  const params = [];
  if (args.direction != null) {
    where.push("direction = ?");
    params.push(args.direction);
  }
  if (args.since != null) {
    where.push("date >= ?");
    params.push(canonicalBound(args.since, "start"));
  }
  params.push(limit);
  const whereSql = where.length ? `WHERE ${where.join("\n  AND ")}\n` : "";
  return {
    sql: `SELECT ${METADATA_SELECT}
FROM emails
${whereSql}ORDER BY date DESC, resend_id DESC
LIMIT ?`,
    params,
  };
}

export function buildGetQuery(input, options = {}) {
  const args = input || {};
  assertOnlyKeys(args, new Set(["resend_id", "include_html", "include_raw_eml", "fresh"]));
  assertOptionalFresh(args);
  if (!isSafeResendId(args.resend_id)) throw new RpcError(-32602, "resend_id is required");
  if (args.include_html != null && typeof args.include_html !== "boolean") {
    throw new RpcError(-32602, "include_html must be a boolean");
  }
  if (args.include_raw_eml != null && typeof args.include_raw_eml !== "boolean") {
    throw new RpcError(-32602, "include_raw_eml must be a boolean");
  }
  const includeHtml = args.include_html === true;
  const aiSql = options.includeAiStatus ? ",\n  ai_status" : "";
  const columns = `${METADATA_SELECT},
  text_body${includeHtml ? ",\n  html_body" : ""}${aiSql}`;
  return {
    sql: `SELECT ${columns}
FROM emails
WHERE resend_id = ?`,
    params: [args.resend_id],
    includeHtml,
    includeRaw: args.include_raw_eml === true,
  };
}

export function buildStatsQueries(nowMs = Date.now()) {
  const since = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    total: { sql: "SELECT COUNT(*) AS total FROM emails", params: [] },
    byDirection: {
      sql: "SELECT direction, COUNT(*) AS count FROM emails GROUP BY direction",
      params: [],
    },
    byDay: {
      sql: `SELECT substr(date, 1, 10) AS day, COUNT(*) AS count
FROM emails
WHERE date >= ?
GROUP BY day
ORDER BY day ASC`,
      params: [since],
    },
    topSenders: {
      sql: `SELECT msg_from AS sender, COUNT(*) AS count
FROM emails
WHERE msg_from IS NOT NULL AND msg_from != ''
GROUP BY msg_from
ORDER BY count DESC, msg_from ASC
LIMIT 10`,
      params: [],
    },
  };
}

export function buildHealthQuery(nowMs = Date.now()) {
  const cutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  return {
    sql: `SELECT
  (SELECT created_at FROM emails WHERE direction = 'in' ORDER BY created_at DESC LIMIT 1) AS last_received_at,
  (SELECT COUNT(*) FROM emails WHERE created_at >= ?) AS count_24h`,
    params: [cutoff],
  };
}

export function assembleStats(totalRows, directionRows, dayRows, senderRows) {
  const by = { in: 0, out: 0 };
  for (const row of directionRows || []) {
    if (row.direction === "in" || row.direction === "out") by[row.direction] = Number(row.count) || 0;
  }
  return {
    total: Number(totalRows && totalRows[0] ? totalRows[0].total : 0) || 0,
    by_direction: by,
    by_day: (dayRows || []).map((row) => ({ day: row.day, count: Number(row.count) || 0 })),
    top_senders: (senderRows || []).map((row) => ({
      from: row.sender ?? row.from ?? row.msg_from ?? null,
      count: Number(row.count) || 0,
    })),
  };
}

function parseJsonField(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function flag(value) {
  return value === true || value === 1 || value === "1";
}

export function toMetadata(row) {
  return {
    resend_id: row.resend_id,
    direction: row.direction,
    from: row.msg_from ?? null,
    to: parseJsonField(row.msg_to, []),
    cc: parseJsonField(row.cc, []),
    subject: row.subject ?? null,
    date: row.date ?? null,
    message_id: row.message_id ?? null,
    has_text: flag(row.has_text),
    has_html: flag(row.has_html),
    attachments: parseJsonField(row.attachments, []),
    created_at: row.created_at ?? null,
  };
}

export function toEmailDetail(row, options = {}) {
  const detail = { ...toMetadata(row), text_body: row.text_body ?? null };
  if (options.includeHtml) detail.html_body = row.html_body ?? null;
  if (options.includeRaw) {
    if (options.rawEml == null) {
      detail.raw_eml = null;
      detail.raw_eml_note = `${rawObjectKey(row.resend_id)} not found in R2`;
    } else {
      detail.raw_eml = options.rawEml;
    }
  }
  return detail;
}

/** TTLs from the phase-2 cache table. */
export const CACHE_TTL = {
  getEmail: 24 * 60 * 60,
  r2: 7 * 24 * 60 * 60,
  search: 10,
  list: 10,
  stats: 120,
};

export const STATS_CACHE_URL = "https://cache.internal/mcp/stats";
/** Point read. Fetch and the consumer share this row; they do not share caches.default. */
export const READ_REVISION_SQL = "SELECT rev FROM cache_revision WHERE id = 1";

const TERMINAL_AI = ["ok", "failed", "skipped", "deferred"];
const GET_AI_VARIANTS = ["none", ...TERMINAL_AI];

export function emailCacheDecision(columnPresent, aiStatus) {
  if (!columnPresent) return { cache: true, ai: "none" };
  if (typeof aiStatus === "string" && TERMINAL_AI.includes(aiStatus)) return { cache: true, ai: aiStatus };
  return { cache: false };
}

export function getEmailCacheUrl(resendId, includeHtml, includeRaw, ai, rev) {
  return (
    "https://cache.internal/mcp/get?id=" +
    encodeURIComponent(resendId) +
    "&html=" +
    (includeHtml ? "1" : "0") +
    "&raw=" +
    (includeRaw ? "1" : "0") +
    "&ai=" +
    encodeURIComponent(ai) +
    "&rev=" +
    encodeURIComponent(String(rev))
  );
}

export function statsCacheUrl(rev) {
  return `${STATS_CACHE_URL}?rev=${encodeURIComponent(String(rev))}`;
}

export function r2CacheUrl(r2Key) {
  return `https://cache.internal/r2/${r2Key}`;
}

export function searchCacheFields(args) {
  return {
    direction: args.direction ?? null,
    from: args.from ? args.from : null,
    limit: clampLimit(args.limit),
    query: args.query,
    since: args.since == null ? null : canonicalBound(args.since, "start"),
    to: args.to ? args.to : null,
    until: args.until == null ? null : canonicalBound(args.until, "end"),
  };
}

export function listCacheFields(args) {
  return {
    direction: args.direction ?? null,
    limit: clampLimit(args.limit),
    since: args.since == null ? null : canonicalBound(args.since, "start"),
  };
}

export function canonicalCacheRecord(fields) {
  return Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key] == null ? "" : String(fields[key])}`)
    .join("\n");
}

export async function hashCacheFields(fields) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalCacheRecord(fields)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function searchCacheUrl(hash, rev) {
  return `https://cache.internal/mcp/search?h=${hash}&rev=${rev}`;
}

export function listCacheUrl(hash, rev) {
  return `https://cache.internal/mcp/list?h=${hash}&rev=${rev}`;
}

export function resolveCache(deps) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, "cache")) return deps.cache || null;
  const globalCache = globalThis.caches;
  if (globalCache && globalCache.default) return globalCache.default;
  return null;
}

function cacheResponse(body, ttl, contentType) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": `max-age=${ttl}`,
    },
  });
}

async function matchCache(cache, request) {
  if (!cache || typeof cache.match !== "function") return null;
  try {
    const hit = await cache.match(request);
    return hit || null;
  } catch (err) {
    console.error(JSON.stringify({ msg: "cache match failed", error: err && err.message }));
    return null;
  }
}

async function scheduleCachePut(cache, ctx, request, response) {
  if (!cache || typeof cache.put !== "function") return;
  const op = Promise.resolve()
    .then(() => cache.put(request, response))
    .catch((err) => {
      console.error(JSON.stringify({ msg: "cache put failed", error: err && err.message }));
    });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(op);
    return;
  }
  await op;
}

function revisionFromRow(row) {
  const n = row == null ? NaN : Number(row.rev);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Current cache generation from D1, not from caches.default.
 * Callers must use the same session as the archive read that follows, so a
 * replica cannot pair a new generation with an older result set.
 */
async function readRevision(deps) {
  if (!deps) return 0;
  if (typeof deps.queryFirst === "function") {
    return revisionFromRow(await deps.queryFirst(READ_REVISION_SQL, []));
  }
  if (typeof deps.queryAll === "function") {
    const rows = await deps.queryAll(READ_REVISION_SQL, []);
    return revisionFromRow(Array.isArray(rows) ? rows[0] : null);
  }
  return 0;
}

async function readThrough(deps, { fresh, url, ttl, load, store }) {
  const cache = deps && deps.cache;
  if (cache && !fresh) {
    const hit = await matchCache(cache, new Request(url));
    if (hit) {
      try {
        return JSON.parse(await hit.text());
      } catch {
        // A damaged entry is a miss. The next put replaces it.
      }
    }
  }
  const value = await load();
  if (cache && store(value)) {
    await scheduleCachePut(
      cache,
      deps.ctx,
      new Request(url),
      cacheResponse(JSON.stringify(value), ttl, "application/json; charset=utf-8"),
    );
  }
  return value;
}

async function emailsHaveAiStatus(deps) {
  try {
    const rows = await queryAll(deps, {
      sql: "SELECT name FROM pragma_table_info('emails') WHERE name = 'ai_status'",
      params: [],
    });
    return Array.isArray(rows) && rows.some((row) => row && row.name === "ai_status");
  } catch {
    return false;
  }
}

async function cachedObjectText(deps, key, fresh) {
  const cache = deps && deps.cache;
  const url = r2CacheUrl(key);
  if (cache && !fresh) {
    const hit = await matchCache(cache, new Request(url));
    if (hit) return hit.text();
  }
  if (!deps || typeof deps.getObjectText !== "function") throw new Error("object store is not configured");
  const text = await deps.getObjectText(key);
  if (cache && text != null) {
    await scheduleCachePut(
      cache,
      deps.ctx,
      new Request(url),
      cacheResponse(text, CACHE_TTL.r2, "application/octet-stream"),
    );
  }
  return text;
}

async function rememberR2(cache, key, bytes) {
  if (!cache || bytes == null || typeof cache.put !== "function") return;
  try {
    await cache.put(
      new Request(r2CacheUrl(key)),
      cacheResponse(bytes, CACHE_TTL.r2, "application/octet-stream"),
    );
  } catch (err) {
    console.error(JSON.stringify({ msg: "cache put failed", error: err && err.message }));
  }
}

export const TOOLS = [
  {
    name: "search_emails",
    description:
      "Search archived mail. query is matched with SQL LIKE against subject, sender, and plain-text body. Results are metadata only (has_text / has_html, no bodies).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring matched against subject, from, and text body." },
        from: { type: "string", description: "Optional substring of the sender." },
        to: { type: "string", description: "Optional substring of the JSON to list." },
        since: { type: "string", description: "Inclusive ISO8601 lower bound on date. YYYY-MM-DD is allowed." },
        until: { type: "string", description: "Inclusive ISO8601 upper bound on date. YYYY-MM-DD is allowed." },
        direction: { type: "string", enum: ["in", "out"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        fresh: { type: "boolean", description: "Skip the cache and read the archive again." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_email",
    description:
      "Fetch one archived email by resend_id, including text_body. html_body and the raw RFC822 message are included only when requested.",
    inputSchema: {
      type: "object",
      properties: {
        resend_id: { type: "string" },
        include_html: { type: "boolean", default: false },
        include_raw_eml: { type: "boolean", default: false },
        fresh: { type: "boolean", description: "Skip the cache and read the archive again." },
      },
      required: ["resend_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_emails",
    description: "List archived mail metadata, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        direction: { type: "string", enum: ["in", "out"] },
        since: { type: "string", description: "Inclusive ISO8601 lower bound on date." },
        fresh: { type: "boolean", description: "Skip the cache and read the archive again." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "email_stats",
    description: "Archive counts: total, inbound vs outbound, daily counts for the last 30 days, and the top 10 senders.",
    inputSchema: {
      type: "object",
      properties: {
        fresh: { type: "boolean", description: "Skip the cache and read the archive again." },
      },
      additionalProperties: false,
    },
  },
];

function toolText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function queryAll(deps, query) {
  if (!deps || typeof deps.queryAll !== "function") throw new Error("queryAll is not configured");
  return deps.queryAll(query.sql, query.params);
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
          serverInfo: { name: "abot-mail-mcp", version: "1.0.0" },
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

async function callTool(name, args, deps) {
  if (name === "search_emails") {
    const query = buildSearchQuery(args);
    const [hash, rev] = await Promise.all([
      hashCacheFields(searchCacheFields(args)),
      readRevision(deps),
    ]);
    return readThrough(deps, {
      fresh: args.fresh === true,
      url: searchCacheUrl(hash, rev),
      ttl: CACHE_TTL.search,
      load: async () => (await queryAll(deps, query)).map(toMetadata),
      store: () => true,
    });
  }
  if (name === "list_emails") {
    const query = buildListQuery(args);
    const [hash, rev] = await Promise.all([
      hashCacheFields(listCacheFields(args)),
      readRevision(deps),
    ]);
    return readThrough(deps, {
      fresh: args.fresh === true,
      url: listCacheUrl(hash, rev),
      ttl: CACHE_TTL.list,
      load: async () => (await queryAll(deps, query)).map(toMetadata),
      store: () => true,
    });
  }
  if (name === "get_email") {
    const parsed = buildGetQuery(args);
    const fresh = args.fresh === true;
    const id = args.resend_id;
    const rev = await readRevision(deps);
    if (deps && deps.cache && !fresh) {
      for (const ai of GET_AI_VARIANTS) {
        const hit = await matchCache(
          deps.cache,
          new Request(getEmailCacheUrl(id, parsed.includeHtml, parsed.includeRaw, ai, rev)),
        );
        if (!hit) continue;
        try {
          return JSON.parse(await hit.text());
        } catch {
          // Keep looking. A later variant, or D1, still answers.
        }
      }
    }
    const columnPresent = await emailsHaveAiStatus(deps);
    const query = columnPresent ? buildGetQuery(args, { includeAiStatus: true }) : parsed;
    const rows = await queryAll(deps, query);
    if (!rows.length) return { found: false, resend_id: id };
    let rawEml;
    if (query.includeRaw) rawEml = await cachedObjectText(deps, rawObjectKey(id), fresh);
    const value = {
      found: true,
      ...toEmailDetail(rows[0], {
        includeHtml: query.includeHtml,
        includeRaw: query.includeRaw,
        rawEml,
      }),
    };
    const decision = emailCacheDecision(columnPresent, columnPresent ? rows[0].ai_status : undefined);
    if (deps && deps.cache && decision.cache) {
      await scheduleCachePut(
        deps.cache,
        deps.ctx,
        new Request(getEmailCacheUrl(id, query.includeHtml, query.includeRaw, decision.ai, rev)),
        cacheResponse(JSON.stringify(value), CACHE_TTL.getEmail, "application/json; charset=utf-8"),
      );
    }
    return value;
  }
  if (name === "email_stats") {
    assertOnlyKeys(args, new Set(["fresh"]));
    assertOptionalFresh(args);
    const rev = await readRevision(deps);
    return readThrough(deps, {
      fresh: args.fresh === true,
      url: statsCacheUrl(rev),
      ttl: CACHE_TTL.stats,
      load: async () => {
        const queries = buildStatsQueries(deps && deps.nowMs);
        const [totalRows, directionRows, dayRows, senderRows] = await Promise.all([
          queryAll(deps, queries.total),
          queryAll(deps, queries.byDirection),
          queryAll(deps, queries.byDay),
          queryAll(deps, queries.topSenders),
        ]);
        return assembleStats(totalRows, directionRows, dayRows, senderRows);
      },
      store: () => true,
    });
  }
  throw new RpcError(-32601, `unknown tool: ${name}`);
}

function bindStmt(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length) return stmt.bind(...params);
  return stmt;
}

function d1Session(db) {
  if (db && typeof db.withSession === "function") return db.withSession("first-primary");
  return db;
}

function d1Deps(env) {
  const source = d1Session(env && env.DB);
  return {
    async queryAll(sql, params) {
      const out = await bindStmt(source, sql, params).all();
      return out.results || [];
    },
    async queryFirst(sql, params) {
      return bindStmt(source, sql, params).first();
    },
    async queryRun(sql, params) {
      return bindStmt(source, sql, params).run();
    },
    async getObjectText(key) {
      const obj = await env.ARCHIVE_BUCKET.get(key);
      if (!obj) return null;
      return obj.text();
    },
  };
}

async function resendJson(doFetch, apiKey, path) {
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const res = await doFetch(`https://api.resend.com${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`resend ${res.status}`);
    err.status = res.status;
    err.source = "resend";
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

function unwrapEmail(body) {
  if (body && typeof body === "object" && body.id) return body;
  if (body && body.data && body.data.id) return body.data;
  throw new Error("unexpected email payload");
}

function listItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && body.data && Array.isArray(body.data.data)) return body.data.data;
  return [];
}

async function listAllAttachments(doFetch, apiKey, direction, emailId) {
  const base =
    direction === "in"
      ? `/emails/receiving/${encodeURIComponent(emailId)}/attachments`
      : `/emails/${encodeURIComponent(emailId)}/attachments`;
  const all = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (after) params.set("after", after);
    const body = await resendJson(doFetch, apiKey, `${base}?${params.toString()}`);
    const batch = listItems(body);
    all.push(...batch);
    if (!body || body.has_more !== true || batch.length === 0 || !batch[batch.length - 1].id) break;
    after = batch[batch.length - 1].id;
  }
  return all;
}

async function fetchAllowedBytes(url, doFetch, redirectsLeft = 3) {
  const allowed = assertAllowedDownloadUrl(url);
  const res = await doFetch(allowed, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    if (redirectsLeft <= 0) throw new Error("too many download redirects");
    const loc = res.headers.get("location");
    if (!loc) throw new Error("download redirect missing location");
    return fetchAllowedBytes(new URL(loc, allowed).toString(), doFetch, redirectsLeft - 1);
  }
  if (!res.ok) {
    const err = new Error(`download ${res.status}`);
    err.status = res.status;
    err.source = "download";
    throw err;
  }
  return res.arrayBuffer();
}

export async function archiveEvent({ event, env, fetchImpl, nowMs = Date.now(), cache = null }) {
  const type = event && event.type;
  if (type !== "email.received" && type !== "email.sent") {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const emailId = event.data && event.data.email_id;
  if (!isSafeResendId(emailId)) {
    return { status: 400, body: { ok: false, error: "invalid email_id" } };
  }
  const db = d1Deps(env);
  const exists = buildExistsQuery(emailId);
  const existing = await db.queryFirst(exists.sql, exists.params);
  if (existing) return { status: 200, body: { ok: true, duplicate: true } };

  const direction = type === "email.received" ? "in" : "out";
  const doFetch = fetchImpl || fetch;
  const path =
    direction === "in"
      ? `/emails/receiving/${encodeURIComponent(emailId)}`
      : `/emails/${encodeURIComponent(emailId)}`;
  // Idempotency key is the webhook email_id, which is what Resend retries.
  const email = { ...unwrapEmail(await resendJson(doFetch, env.RESEND_API_KEY, path)), id: emailId };
  const storedId = emailId;

  const downloadUrl = email.raw && email.raw.download_url;
  if (downloadUrl) {
    const bytes = await fetchAllowedBytes(downloadUrl, doFetch);
    await env.ARCHIVE_BUCKET.put(rawObjectKey(storedId), bytes, {
      httpMetadata: { contentType: "message/rfc822" },
    });
    await rememberR2(cache, rawObjectKey(storedId), bytes);
  }

  const listed = await listAllAttachments(doFetch, env.RESEND_API_KEY, direction, emailId);
  const used = new Set();
  const attachments = [];
  for (const att of listed) {
    if (!att || !att.download_url) throw new Error("attachment missing download_url");
    const filename = typeof att.filename === "string" && att.filename ? att.filename : "attachment";
    const key = buildAttachmentKey(storedId, filename, used);
    const bytes = await fetchAllowedBytes(att.download_url, doFetch);
    await env.ARCHIVE_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: safeContentType(att.content_type) },
    });
    await rememberR2(cache, key, bytes);
    attachments.push({
      filename,
      content_type: att.content_type || "application/octet-stream",
      size: Number.isFinite(att.size) ? att.size : bytes.byteLength,
      r2_key: key,
    });
  }

  const row = mapEmailForStorage(
    { ...email, id: storedId },
    { direction, eventCreatedAt: event.created_at, attachments, nowMs },
  );
  const insert = buildInsertQuery(row);
  // cache_revision advances in this commit via AFTER INSERT. Readers fold that
  // value into cache keys. A caches.default delete here would stay in this
  // colo; queue consumers and fetch handlers do not share one.
  await db.queryRun(insert.sql, insert.params);
  console.log(JSON.stringify({ msg: "archived", direction, email_id: storedId }));
  return { status: 200, body: { ok: true } };
}

export function retryDelaySeconds(attempts) {
  const n = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  const exp = Math.min(n - 1, 6);
  return INGEST_RETRY_BASE_SEC * 2 ** exp;
}

/** 4xx from Resend or a download (except 429) and local refusals do not get another try. */
export function isRetryableIngestError(err) {
  if (!err || typeof err !== "object") return true;
  const status = Number(err.status);
  if (err.source === "resend" && Number.isFinite(status)) {
    return status === 429 || status >= 500;
  }
  if (err.source === "download" && Number.isFinite(status)) {
    return status === 429 || status >= 500;
  }
  const message = String(err.message || "");
  const resendStatus = /^resend (\d+)$/.exec(message);
  if (resendStatus) {
    const code = Number(resendStatus[1]);
    return code === 429 || code >= 500;
  }
  if (
    message.startsWith("invalid download url") ||
    message.startsWith("refusing ") ||
    message.startsWith("unexpected email payload") ||
    message.startsWith("attachment missing download_url") ||
    message.startsWith("too many download redirects") ||
    message.startsWith("download redirect missing location")
  ) {
    return false;
  }
  return true;
}

function clipStored(value, max) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : String(value);
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, max);
}

export function buildFailureInsert(row) {
  const attempts = Number.isInteger(row.attempts) && row.attempts > 0 ? row.attempts : 1;
  return {
    sql: `INSERT INTO ingest_failures (resend_id, event_type, error, attempts, failed_at)
VALUES (?, ?, ?, ?, ?)`,
    params: [
      clipStored(row.resend_id, 200),
      clipStored(row.event_type, 80),
      clipStored(row.error, 500),
      attempts,
      row.failed_at,
    ],
  };
}

function failedAtIso(nowMs) {
  return new Date(nowMs ?? Date.now()).toISOString();
}

async function recordIngestFailure(env, row) {
  const db = d1Deps(env);
  const insert = buildFailureInsert(row);
  await db.queryRun(insert.sql, insert.params);
}

function messageAttempts(message) {
  return Number.isInteger(message && message.attempts) && message.attempts > 0 ? message.attempts : 1;
}

function queueEventType(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (typeof body.event_type === "string") return body.event_type;
  if (typeof body.type === "string") return body.type;
  return null;
}

function queueResendId(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return typeof body.resend_id === "string" ? body.resend_id : null;
}

/**
 * Verify-and-enqueue. Does not call Resend or touch D1/R2.
 * send() failure throws so the caller can return 500 and let Svix retry.
 */
export async function enqueueWebhook({ event, env, svixId }) {
  const type = event && event.type;
  if (type !== "email.received" && type !== "email.sent") {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const emailId = event.data && event.data.email_id;
  if (!isSafeResendId(emailId)) {
    return { status: 400, body: { ok: false, error: "invalid email_id" } };
  }
  const queue = env && env.INGEST_QUEUE;
  if (!queue || typeof queue.send !== "function") {
    throw new Error("ingest queue is not configured");
  }
  const message = {
    resend_id: emailId,
    event_type: type,
    received_at: typeof event.created_at === "string" ? event.created_at.slice(0, 80) : null,
    svix_id: typeof svixId === "string" && svixId ? svixId.slice(0, 200) : null,
  };
  await queue.send(message);
  console.log(JSON.stringify({ msg: "queued", resend_id: emailId, event_type: type }));
  return { status: 200, body: { ok: true, queued: true } };
}

/**
 * One queue message. Idempotent on emails.resend_id.
 * Returns { action: "ack" } or { action: "retry", delaySeconds }.
 * Permanent failures are written to ingest_failures before ack.
 */
export async function consumeIngestMessage(message, env, deps = {}) {
  const attempts = messageAttempts(message);
  const body = message && message.body;
  const eventType = queueEventType(body);
  const resendId = queueResendId(body);
  const nowMs = deps.nowMs;

  const permanent = async (error, id = resendId, type = eventType) => {
    await recordIngestFailure(env, {
      resend_id: typeof id === "string" ? id : null,
      event_type: typeof type === "string" ? type : null,
      error,
      attempts,
      failed_at: failedAtIso(nowMs),
    });
    const loggedId = typeof id === "string" ? id.slice(0, 200) : null;
    console.log(JSON.stringify({ msg: "ingest", outcome: "dead", resend_id: loggedId, attempts }));
    return { action: "ack", recorded: true };
  };

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return permanent("invalid queue payload", null, null);
  }
  if (eventType !== "email.received" && eventType !== "email.sent") {
    return permanent("unsupported event_type");
  }
  if (!isSafeResendId(resendId)) {
    return permanent("invalid email_id");
  }

  try {
    const result = await archiveEvent({
      event: {
        type: eventType,
        created_at: typeof body.received_at === "string" ? body.received_at : body.event_created_at,
        data: { email_id: resendId },
      },
      env,
      fetchImpl: deps.fetch,
      nowMs,
      cache: deps.cache || null,
    });
    if (result.status >= 400 && result.status < 500) {
      return permanent((result.body && result.body.error) || "rejected");
    }
    if (result.status >= 500) {
      const err = new Error("archive failed");
      err.status = result.status;
      err.source = "archive";
      throw err;
    }
    console.log(
      JSON.stringify({
        msg: "ingest",
        outcome: result.body && result.body.duplicate ? "duplicate" : "ok",
        resend_id: resendId,
        attempts,
      }),
    );
    return { action: "ack", duplicate: !!(result.body && result.body.duplicate) };
  } catch (err) {
    const retryable = isRetryableIngestError(err);
    if (!retryable || attempts > INGEST_MAX_RETRIES) {
      return permanent((err && err.message) || "ingest failed");
    }
    const delaySeconds = retryDelaySeconds(attempts);
    console.log(
      JSON.stringify({
        msg: "ingest",
        outcome: "retry",
        resend_id: resendId,
        attempts,
        delay_seconds: delaySeconds,
      }),
    );
    return { action: "retry", delaySeconds };
  }
}

export function isDeadLetterQueue(name) {
  return typeof name === "string" && name.endsWith("-dlq");
}

/** DLQ consumer only records the payload. It does not call Resend. */
export async function consumeDeadLetter(message, env, deps = {}) {
  const body = message && message.body;
  const attempts = messageAttempts(message);
  await recordIngestFailure(env, {
    resend_id: queueResendId(body),
    event_type: queueEventType(body),
    error: "retries exhausted",
    attempts,
    failed_at: failedAtIso(deps.nowMs),
  });
  console.log(JSON.stringify({ msg: "ingest", outcome: "dlq", resend_id: queueResendId(body), attempts }));
  return { action: "ack", recorded: true };
}

export async function handleQueue(batch, env, deps = {}) {
  const dead = isDeadLetterQueue(batch && batch.queue);
  const nextDeps = { ...deps, cache: resolveCache(deps) };
  for (const message of (batch && batch.messages) || []) {
    try {
      const decision = dead
        ? await consumeDeadLetter(message, env, nextDeps)
        : await consumeIngestMessage(message, env, nextDeps);
      if (decision.action === "retry") message.retry({ delaySeconds: decision.delaySeconds });
      else message.ack();
    } catch (err) {
      console.error(JSON.stringify({ msg: "ingest failed", error: err && err.message }));
      message.retry({ delaySeconds: retryDelaySeconds(messageAttempts(message)) });
    }
  }
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

export async function handleFetch(request, env, deps = {}) {
  const path = pathOf(request);
  const fetchImpl = deps.fetch || fetch;

  if (path === "/health") {
    if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
    try {
      const q = buildHealthQuery(deps.nowMs);
      const row = await d1Deps(env).queryFirst(q.sql, q.params);
      return json({
        ok: true,
        last_received_at: row && row.last_received_at ? row.last_received_at : null,
        count_24h: row ? Number(row.count_24h) || 0 : 0,
      });
    } catch (err) {
      console.error(JSON.stringify({ msg: "health failed", error: err && err.message }));
      return json({ ok: false, last_received_at: null, count_24h: null }, 503);
    }
  }

  if (path === "/mcp") {
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    if (!bearerOk(request.headers.get("authorization"), env && env.MCP_TOKEN)) {
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
    const db = d1Deps(env);
    const rpc = await handleMcpRpc(message, {
      queryAll: (sql, params) => db.queryAll(sql, params),
      queryFirst: (sql, params) => db.queryFirst(sql, params),
      getObjectText: (key) => db.getObjectText(key),
      nowMs: deps.nowMs,
      cache: resolveCache(deps),
      ctx: deps.ctx || null,
    });
    if (rpc.type === "notification") return new Response(null, { status: 202 });
    if (rpc.type === "error") {
      return json({ jsonrpc: "2.0", id: rpc.id ?? null, error: rpc.error });
    }
    return json({ jsonrpc: "2.0", id: rpc.id, result: rpc.result });
  }

  if (path === "/") {
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    const rawBuf = new Uint8Array(await request.arrayBuffer());
    if (rawBuf.byteLength > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);
    const verdict = await verifySvixSignature({
      secret: env && env.WEBHOOK_SECRET,
      svixId: request.headers.get("svix-id"),
      svixTimestamp: request.headers.get("svix-timestamp"),
      svixSignature: request.headers.get("svix-signature"),
      rawBody: rawBuf,
      nowMs: deps.nowMs,
    });
    if (!verdict.ok) {
      console.log(JSON.stringify({ msg: "webhook rejected", reason: verdict.reason }));
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    let event;
    try {
      event = JSON.parse(new TextDecoder("utf-8").decode(rawBuf));
    } catch {
      return json({ ok: false, error: "invalid json" }, 400);
    }
    try {
      const result = await enqueueWebhook({
        event,
        env,
        svixId: request.headers.get("svix-id"),
      });
      return json(result.body, result.status);
    } catch (err) {
      console.error(JSON.stringify({ msg: "webhook failed", error: err && err.message }));
      return json({ ok: false }, 500);
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

export default {
  fetch(request, env, ctx) {
    return handleFetch(request, env, { ctx });
  },
  queue(batch, env, ctx) {
    return handleQueue(batch, env, { ctx });
  },
};
