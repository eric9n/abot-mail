/**
 * abot.run mail relay without an archive.
 * POST /      Resend webhook (Svix): verify, then ignore. Nothing is queued or stored.
 * POST /mcp   MCP (Streamable HTTP, JSON-RPC) via Service Bindings only.
 *             host must be INTERNAL_MCP_HOST; public hosts get 404.
 *             requires x-abot-owner-email; does not check any token.
 * GET /health liveness only. No mail counts.
 *
 * Tools: get_account, send_email. send_email calls Resend and counts recipients
 * in D1 table rate_limits. It does not write an emails row.
 *
 * Secrets come from the Worker env: WEBHOOK_SECRET, RESEND_API_KEY.
 * Both are Worker secrets (`wrangler secret put`), never plain vars.
 * Historical D1 mail rows and R2 objects are not read or deleted here.
 */

const TIMESTAMP_TOLERANCE_SEC = 5 * 60;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1_000_000;
/**
 * abot-gateway calls POST /mcp through a Service Binding at https://backend.internal/.
 * Public traffic arrives as mail.abot.run, so it can never present this host and
 * therefore cannot vouch for itself with x-abot-owner-email.
 */
export const INTERNAL_MCP_HOST = "backend.internal";
/** POST /mcp fixed window. Counted in this isolate, per presented credential or client IP. */
export const MCP_RATE_LIMIT = 120;
export const MCP_RATE_WINDOW_MS = 60_000;
/** POST /mcp per-mailbox calls per minute, counted in D1 across isolates. */
export const MCP_D1_RATE_LIMIT = 100;
export const SEND_MAX_RECIPIENTS = 10;
/** RFC 5322 line limit; the subject must also be a single line. */
export const SEND_MAX_SUBJECT_CHARS = 998;
export const SEND_MAX_BODY_CHARS = 100_000;
/** Recipients per mailbox per clock hour. Override with env.SEND_HOURLY_LIMIT. */
export const SEND_HOURLY_LIMIT = 50;
export const RATE_LIMITS_DDL =
  "CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)";
const BUMP_COUNTER_SQL =
  "INSERT INTO rate_limits (k, window, count) VALUES (?, ?, ?) " +
  "ON CONFLICT(k) DO UPDATE SET count = count + excluded.count RETURNING count";
const mcpRateStore = new Map();
const MCP_TOOL_NAMES = new Set(["get_account", "send_email"]);
const SAFE_LOG_ERRORS = new Set([
  "missing_header",
  "bad_timestamp",
  "timestamp_out_of_range",
  "bad_secret",
  "bad_signature",
  "unhandled",
]);

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
    if (comma <= 0) continue;
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    matched = matched || (version === "v1" && timingSafeEqual(sig, expected));
  }
  return matched ? { ok: true } : { ok: false, reason: "bad_signature" };
}

function assertOnlyKeys(obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new RpcError(-32602, `unexpected argument: ${key}`);
  }
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
  };
}

export const TOOLS = [
  {
    name: "get_account",
    description: "Return the mailbox address bound to this call. No arguments.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "send_email",
    description: "Send an email via Resend from your bound @abot.run address. Recipients count against an hourly quota. Nothing is stored.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address, or up to 10 addresses separated by commas." },
        subject: { type: "string", description: "Email subject. One line, at most 998 characters." },
        body: { type: "string", description: "Email body (plain text), at most 100000 characters." },
        from: { type: "string", description: "Sender address. Defaults to your bound email. Must be @abot.run." },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
];

function toolText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function noteTool(trace, name, args) {
  if (!trace) return;
  if (MCP_TOOL_NAMES.has(name)) trace.tool = name;
  if (args && args.fresh === true) trace.fresh = true;
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
    return { type: "error", id, error: { code: -32603, message: "internal error" } };
  }
}

async function callTool(name, args, deps) {
  noteTool(deps && deps.trace, name, args);
  const ownerEmail = deps && deps.ownerEmail ? deps.ownerEmail : null;
  if (name === "get_account") {
    assertOnlyKeys(args, new Set());
    if (!ownerEmail) throw new RpcError(-32001, "agent email not bound");
    const at = ownerEmail.lastIndexOf("@");
    return {
      email: ownerEmail,
      domain: at >= 0 ? ownerEmail.slice(at + 1) : "abot.run",
    };
  }
  if (name === "send_email") {
    const to = args.to;
    const subject = args.subject;
    const body = args.body;
    if (!ownerEmail) {
      throw new RpcError(-32001, "agent email not bound");
    }
    if (typeof to !== "string" || !to || typeof subject !== "string" || !subject || typeof body !== "string" || !body) {
      throw new RpcError(-32602, "to, subject, body are required");
    }
    const recipients = parseRecipients(to);
    if (subject.length > SEND_MAX_SUBJECT_CHARS || /[\r\n]/.test(subject)) {
      throw new RpcError(-32602, `subject must be one line of at most ${SEND_MAX_SUBJECT_CHARS} characters`);
    }
    if (body.length > SEND_MAX_BODY_CHARS) {
      throw new RpcError(-32602, `body must be at most ${SEND_MAX_BODY_CHARS} characters`);
    }
    if (args.from != null && typeof args.from !== "string") {
      throw new RpcError(-32602, "from must be a string");
    }
    // 发件人永远是绑定邮箱。调用方传了别人的地址就拒绝，不能冒充。
    if (args.from && args.from.trim().toLowerCase() !== ownerEmail) {
      throw new RpcError(-32602, "cannot send as another agent");
    }
    if (!ownerEmail.endsWith("@abot.run")) {
      throw new RpcError(-32602, "from must be @abot.run address");
    }
    const from = ownerEmail;
    const apiKey = deps.env && deps.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new RpcError(-32603, "RESEND_API_KEY not configured");
    }
    const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
    const hour = Math.floor(nowMs / 3_600_000);
    const limit = sendHourlyLimit(deps.env);
    const quotaKey = `send:${ownerEmail}:${hour}`;
    const nowMinute = Math.floor(nowMs / 60_000);
    const refund = () => bumpCounter(deps, quotaKey, (hour + 1) * 60, -recipients.length, nowMinute).catch(() => {});
    let sentThisHour;
    try {
      sentThisHour = await bumpCounter(deps, quotaKey, (hour + 1) * 60, recipients.length, nowMinute);
    } catch {
      throw new RpcError(-32603, "send quota unavailable");
    }
    if (sentThisHour > limit) {
      await refund();
      throw new RpcError(-32003, `send limit reached: at most ${limit} recipients per hour`);
    }
    const toField = recipients.length === 1 ? recipients[0] : recipients;
    const doFetch = (deps && deps.fetchImpl) || fetch;
    let resp;
    try {
      resp = await doFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: toField, subject, text: body }),
      });
    } catch {
      await refund();
      throw new RpcError(-32603, "Resend unreachable");
    }
    let data = {};
    try {
      data = await resp.json();
    } catch {
      data = {};
    }
    if (!resp.ok) {
      await refund();
      const reason = data && typeof data.message === "string" ? `: ${data.message.slice(0, 200)}` : "";
      throw new RpcError(-32603, `Resend rejected the message (HTTP ${resp.status})${reason}`);
    }
    return { id: data.id, from, to: toField, subject };
  }
  throw new RpcError(-32601, `unknown tool: ${name}`);
}

function json(body, status = 200, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(extraHeaders || {}),
    },
  });
}

function mcpLimit(env) {
  if (!env || env.MCP_RATE_LIMIT == null || env.MCP_RATE_LIMIT === "") return MCP_RATE_LIMIT;
  const n = Number(env.MCP_RATE_LIMIT);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) return MCP_RATE_LIMIT;
  return n;
}

export function sendHourlyLimit(env) {
  if (!env || env.SEND_HOURLY_LIMIT == null || env.SEND_HOURLY_LIMIT === "") return SEND_HOURLY_LIMIT;
  const n = Number(env.SEND_HOURLY_LIMIT);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) return SEND_HOURLY_LIMIT;
  return n;
}

const RECIPIENT_RE = /^[^\s@<>,;:"()[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** "a@x.com, b@y.com" -> ["a@x.com", "b@y.com"]; duplicates (case-insensitive) dropped. */
export function parseRecipients(value) {
  const parts = String(value).split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > SEND_MAX_RECIPIENTS) {
    throw new RpcError(-32602, `to must list 1 to ${SEND_MAX_RECIPIENTS} addresses`);
  }
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (part.length > 254 || !RECIPIENT_RE.test(part)) {
      throw new RpcError(-32602, "invalid recipient address");
    }
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

/**
 * Atomically adds `by` to counter `key` and returns the new total.
 * `expiresMinute` is stored in `window`; rows whose window is before `nowMinute`
 * are swept whenever a new key is created.
 */
export async function bumpCounter(deps, key, expiresMinute, by, nowMinute) {
  const bump = () => deps.queryFirst(BUMP_COUNTER_SQL, [key, expiresMinute, by]);
  let row;
  try {
    row = await bump();
  } catch (err) {
    if (!/no such table: rate_limits/i.test(String(err && err.message))) throw err;
    await deps.queryRun(RATE_LIMITS_DDL, []);
    row = await bump();
  }
  const count = Number(row && row.count);
  if (!Number.isFinite(count)) throw new Error("rate counter returned no count");
  if (count === by) {
    try {
      await deps.queryRun("DELETE FROM rate_limits WHERE window < ?", [nowMinute]);
    } catch {
      // Sweeping is best effort; stale rows only cost storage.
    }
  }
  return count;
}

/** Per mailbox when the gateway sent one, otherwise the client IP. Not logged. */
export function mcpClientKey(request) {
  const owner = request.headers.get("x-abot-owner-email");
  if (typeof owner === "string" && owner.trim()) return `owner:${owner.trim().toLowerCase()}`;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return `ip:${ip}`;
}

export function consumeMcpRate(key, nowMs, limit = MCP_RATE_LIMIT, store = mcpRateStore) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cap = Number.isInteger(limit) && limit > 0 ? limit : MCP_RATE_LIMIT;
  const windowMs = MCP_RATE_WINDOW_MS;
  let bucket = store.get(key);
  if (!bucket || now < bucket.start || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
    store.set(key, bucket);
  }
  bucket.count += 1;
  if (store.size > 2000) {
    for (const [storedKey, stored] of store) {
      if (now - stored.start >= windowMs) store.delete(storedKey);
    }
  }
  const retryAfterSec = Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000));
  return { allowed: bucket.count <= cap, retryAfterSec };
}

function pathOf(url) {
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) return url.pathname.slice(0, -1);
  return url.pathname;
}

function jsonContentType(header) {
  if (!header) return false;
  const media = header.split(";", 1)[0].trim().toLowerCase();
  return media === "application/json";
}

const METRIC_STAGES = ["webhook", "mcp", "health"];
const METRIC_OUTCOMES = ["ok", "ignored", "rejected", "unauthorized", "rate_limited", "error"];

export function buildInvocationLog(fields) {
  const stage = METRIC_STAGES.includes(fields && fields.stage) ? fields.stage : "webhook";
  const outcome = METRIC_OUTCOMES.includes(fields && fields.outcome) ? fields.outcome : "error";
  const wall = fields && Number.isFinite(fields.wall_ms) && fields.wall_ms >= 0 ? fields.wall_ms : 0;
  const log = { msg: "invoke", stage, outcome, wall_ms: wall };
  if (fields && MCP_TOOL_NAMES.has(fields.tool)) log.tool = fields.tool;
  if (fields && SAFE_LOG_ERRORS.has(fields.error)) log.error = fields.error;
  return log;
}

export function emitObservation(env, fields) {
  console.log(JSON.stringify(buildInvocationLog(fields)));
  const metrics = env && env.METRICS;
  if (!metrics || typeof metrics.writeDataPoint !== "function") return;
  try {
    const stage = METRIC_STAGES.includes(fields && fields.stage) ? fields.stage : "webhook";
    const outcome = METRIC_OUTCOMES.includes(fields && fields.outcome) ? fields.outcome : "error";
    metrics.writeDataPoint({
      indexes: [stage],
      blobs: [stage, outcome, fields && MCP_TOOL_NAMES.has(fields.tool) ? fields.tool : ""],
      doubles: [fields && Number.isFinite(fields.wall_ms) ? fields.wall_ms : 0],
    });
  } catch {
    // A metric write must not change the response.
  }
}

export async function handleFetch(request, env, deps = {}) {
  const started = Date.now();
  const trace = {};
  deps = { ...deps, trace };
  const url = new URL(request.url);
  const path = pathOf(url);
  trace.stage = path === "/health" ? "health" : path === "/mcp" ? "mcp" : "webhook";
  try {
    if (path === "/health") {
      if (request.method !== "GET") {
        trace.outcome = "rejected";
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      trace.outcome = "ok";
      return json({ ok: true });
    }

    if (path === "/mcp") {
      if (url.hostname !== INTERNAL_MCP_HOST) {
        trace.outcome = "rejected";
        return json({ ok: false, error: "not found" }, 404);
      }
      const rate = consumeMcpRate(mcpClientKey(request), deps.nowMs ?? Date.now(), mcpLimit(env));
      if (!rate.allowed) {
        trace.outcome = "rejected";
        return json({ ok: false, error: "rate limited" }, 429, { "retry-after": String(rate.retryAfterSec) });
      }
      if (request.method !== "POST") {
        trace.outcome = "rejected";
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      const ownerEmail = (request.headers.get("x-abot-owner-email") || "").trim().toLowerCase() || null;
      if (!ownerEmail || !/^[a-z0-9._-]+@abot\.run$/.test(ownerEmail)) {
        trace.outcome = "unauthorized";
        return json({ ok: false, error: "x-abot-owner-email required" }, 401);
      }
      const db = d1Deps(env);
      const minute = Math.floor((deps.nowMs ?? Date.now()) / 60_000);
      let callsThisMinute = 0;
      try {
        callsThisMinute = await bumpCounter(db, `mcp:${ownerEmail}:${minute}`, minute + 1, 1, minute);
      } catch {
        // Fails open: the in-isolate limiter above still applies.
      }
      if (callsThisMinute > MCP_D1_RATE_LIMIT) {
        trace.outcome = "rate_limited";
        return json(
          { ok: false, error: "rate_limited", message: `每分钟最多${MCP_D1_RATE_LIMIT}次` },
          429,
          { "retry-after": String(60 - Math.floor(((deps.nowMs ?? Date.now()) % 60_000) / 1000)) },
        );
      }
      if (!jsonContentType(request.headers.get("content-type"))) {
        trace.outcome = "rejected";
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Content-Type must be application/json" } },
          415,
        );
      }
      const raw = await request.arrayBuffer();
      if (raw.byteLength > MAX_BODY_BYTES) {
        trace.outcome = "rejected";
        return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "payload too large" } }, 413);
      }
      let message;
      try {
        message = JSON.parse(new TextDecoder("utf-8").decode(raw));
      } catch {
        trace.outcome = "rejected";
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      const rpc = await handleMcpRpc(message, {
        queryAll: (sql, params) => db.queryAll(sql, params),
        queryFirst: (sql, params) => db.queryFirst(sql, params),
        queryRun: (sql, params) => db.queryRun(sql, params),
        fetchImpl: deps.fetch,
        nowMs: deps.nowMs,
        trace,
        ownerEmail,
        env,
      });
      if (rpc.type === "notification") {
        trace.outcome = "ok";
        return new Response(null, { status: 202 });
      }
      if (rpc.type === "error") {
        trace.outcome = rpc.error && rpc.error.code === -32603 ? "error" : "rejected";
        if (trace.outcome === "error") trace.error = "unhandled";
        return json({ jsonrpc: "2.0", id: rpc.id ?? null, error: rpc.error });
      }
      trace.outcome = "ok";
      return json({ jsonrpc: "2.0", id: rpc.id, result: rpc.result });
    }

    if (path === "/") {
      if (request.method !== "POST") {
        trace.outcome = "rejected";
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      const rawBuf = new Uint8Array(await request.arrayBuffer());
      if (rawBuf.byteLength > MAX_BODY_BYTES) {
        trace.outcome = "rejected";
        return json({ ok: false, error: "payload too large" }, 413);
      }
      const verdict = await verifySvixSignature({
        secret: env && env.WEBHOOK_SECRET,
        svixId: request.headers.get("svix-id"),
        svixTimestamp: request.headers.get("svix-timestamp"),
        svixSignature: request.headers.get("svix-signature"),
        rawBody: rawBuf,
        nowMs: deps.nowMs,
      });
      if (!verdict.ok) {
        trace.outcome = "unauthorized";
        if (SAFE_LOG_ERRORS.has(verdict.reason)) trace.error = verdict.reason;
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      try {
        JSON.parse(new TextDecoder("utf-8").decode(rawBuf));
      } catch {
        trace.outcome = "rejected";
        return json({ ok: false, error: "invalid json" }, 400);
      }
      // Verified events are acknowledged and dropped. No queue, no Resend fetch, no D1/R2.
      trace.outcome = "ignored";
      return json({ ok: true, ignored: true });
    }

    trace.outcome = "rejected";
    return json({ ok: false, error: "not found" }, 404);
  } catch (err) {
    if (!trace.outcome) trace.outcome = "error";
    if (!trace.error) trace.error = "unhandled";
    throw err;
  } finally {
    trace.wall_ms = Date.now() - started;
    if (!trace.outcome) trace.outcome = "ok";
    emitObservation(env, trace);
  }
}

const worker = {
  fetch(request, env, ctx) {
    return handleFetch(request, env, { ctx });
  },
};

export default worker;
