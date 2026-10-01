/**
 * botu-secrets: a personal vault for bot credentials.
 * POST /mcp    JSON-RPC 2.0 MCP. Bearer token, SHA-256 hex looked up in bots.
 * GET  /health {ok:true, service:"botu-secrets"} — no auth.
 * Served at the zone root on secrets.abot.run. There is no /secrets prefix.
 *
 * Crypto (AES-256-GCM via global WebCrypto). Fail closed: a missing or illegal
 * KEK throws KekError before any authenticated MCP work.
 *
 *   KEK = 32 bytes, standard base64 in env.KEK_B64.
 *   Each secret gets a fresh random 32-byte DEK.
 *   dek_wrapped_b64 = base64( wrapNonce[12] || AES-GCM(KEK, DEK) )
 *     AAD = utf8("botu-secrets.dek.v1"). WebCrypto appends the 16-byte tag.
 *   nonce_b64       = base64( valueNonce[12] )
 *   ciphertext_b64  = base64( AES-GCM(DEK, utf8(value)) )
 *     AAD = utf8("botu-secrets.val.v1\n" + secretId). Tag is included.
 *   Audit stores sha256(secret name) only. Never the name, the value, the token, or a key.
 *   generate_secret draws the value with crypto.getRandomValues. The plaintext is
 *   returned once and is not written to logs or to the audit row.
 *
 * Leases are an accountability window, not a second credential. get_secret returns
 * the plaintext in that same response. Revoke / rotate flip related leases to revoked=1.
 * An expired lease (expires_at <= now) is inactive even when revoked=0.
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1_000_000;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_PREFIXES = new Set(["bot_", "sec_", "lse_", "aud_"]);
const LABEL_MAX = 200;
const VALUE_MAX = 65_536;
const TTL_DEFAULT = 900;
const TTL_MAX = 86_400;
const ROTATE_DAYS_MAX = 3_650;
const GENERATE_LENGTH_DEFAULT = 32;
const GENERATE_LENGTH_MAX = 512;
/** Unambiguous paste-safe default. Callers can pass another unique alphabet. */
export const DEFAULT_SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const AUDIT_LIMIT = 500;
const DAY_MS = 86_400_000;
const DEK_AAD = "botu-secrets.dek.v1";

const OPS_TOOLS = new Set([
  "put_secret",
  "generate_secret",
  "rotate_secret",
  "revoke_secret",
  "create_bot",
  "grant_access",
  "revoke_bot",
  "revoke_lease",
  "audit_log",
]);

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RpcError";
  }
}

export class KekError extends Error {
  constructor(message) {
    super(message);
    this.name = "KekError";
  }
}

export function encodeB64(bytes) {
  const chunk = 0x4000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(bin);
}

export function decodeB64(b64) {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  let bin;
  try {
    bin = atob(b64);
  } catch {
    throw new Error("invalid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** 32-byte KEK or KekError. Does not cache. */
export function loadKek(env) {
  const raw = env && env.KEK_B64;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new KekError("KEK_B64 is missing");
  }
  let bytes;
  try {
    bytes = decodeB64(raw);
  } catch {
    throw new KekError("KEK_B64 is not valid base64");
  }
  if (bytes.length !== 32) {
    throw new KekError("KEK_B64 must decode to 32 bytes");
  }
  return bytes;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function aad(text) {
  return new TextEncoder().encode(text);
}

function valueAad(secretId) {
  return `botu-secrets.val.v1\n${secretId}`;
}

async function importAes(raw) {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptAes(keyRaw, plaintext, aadText) {
  const key = await importAes(keyRaw);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(aadText) }, key, plaintext),
  );
  return { nonce, ciphertext: cipher };
}

async function decryptAes(keyRaw, nonce, ciphertext, aadText) {
  const key = await importAes(keyRaw);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: aad(aadText) },
    key,
    new Uint8Array(ciphertext),
  );
  return new Uint8Array(plain);
}

/** base64(nonce || ciphertext+tag) of the 32-byte DEK under the KEK. */
export async function wrapDek(kekBytes, dek) {
  if (!(dek instanceof Uint8Array) || dek.length !== 32) throw new Error("dek must be 32 bytes");
  const sealed = await encryptAes(kekBytes, dek, DEK_AAD);
  const blob = new Uint8Array(sealed.nonce.length + sealed.ciphertext.length);
  blob.set(sealed.nonce, 0);
  blob.set(sealed.ciphertext, sealed.nonce.length);
  return encodeB64(blob);
}

export async function unwrapDek(kekBytes, dekWrappedB64) {
  const blob = decodeB64(dekWrappedB64);
  if (blob.length < 12 + 32 + 16) throw new Error("dek wrap too short");
  const dek = await decryptAes(kekBytes, blob.subarray(0, 12), blob.subarray(12), DEK_AAD);
  if (dek.length !== 32) throw new Error("dek length");
  return dek;
}

export async function sealValue(kekBytes, secretId, value) {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const dekWrapped = await wrapDek(kekBytes, dek);
  const sealed = await encryptAes(dek, new TextEncoder().encode(value), valueAad(secretId));
  return {
    dek_wrapped_b64: dekWrapped,
    nonce_b64: encodeB64(sealed.nonce),
    ciphertext_b64: encodeB64(sealed.ciphertext),
  };
}

export async function openValue(kekBytes, secretId, row) {
  const dek = await unwrapDek(kekBytes, row.dek_wrapped_b64);
  return decryptValue(dek, secretId, row.nonce_b64, row.ciphertext_b64);
}

export async function decryptValue(dek, secretId, nonceB64, ciphertextB64) {
  const plain = await decryptAes(dek, decodeB64(nonceB64), decodeB64(ciphertextB64), valueAad(secretId));
  return new TextDecoder().decode(plain);
}

/** Active only when not revoked and expires_at is strictly after nowMs. */
export function isLeaseActive(lease, nowMs) {
  if (!lease || typeof lease !== "object") return false;
  if (Number(lease.revoked) === 1) return false;
  const exp = Date.parse(lease.expires_at);
  if (!Number.isFinite(exp)) return false;
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  return exp > now;
}

/** True when a schedule is set and now is strictly past last_rotated_at + N days. */
export function rotationDue(rotateEveryDays, lastRotatedAt, nowMs) {
  if (rotateEveryDays == null) return false;
  const days = Number(rotateEveryDays);
  if (!Number.isInteger(days) || days <= 0) return false;
  const last = Date.parse(lastRotatedAt);
  if (!Number.isFinite(last)) return false;
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  return now - last > days * DAY_MS;
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

function notFound() {
  return new RpcError(-32602, "not found");
}

function forbidden() {
  return new RpcError(-32003, "forbidden");
}

function readLabel(value, key) {
  if (typeof value !== "string") throw new RpcError(-32602, `${key} must be a string`);
  const label = value.trim();
  if (label.length === 0) throw new RpcError(-32602, `${key} is required`);
  if (label.length > LABEL_MAX) throw new RpcError(-32602, `${key} is too long`);
  if (/[\u0000-\u001f\u007f]/.test(label)) throw new RpcError(-32602, `${key} is invalid`);
  return label;
}

function readSecretValue(value, key) {
  if (typeof value !== "string") throw new RpcError(-32602, `${key} must be a string`);
  if (value.length === 0) throw new RpcError(-32602, `${key} is required`);
  if (value.length > VALUE_MAX) throw new RpcError(-32602, `${key} is too long`);
  return value;
}

function readInt(value, key, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new RpcError(-32602, `${key} must be an integer`);
  }
  if (value < min || value > max) throw new RpcError(-32602, `${key} is out of range`);
  return value;
}

function readRotateDays(args) {
  if (!has(args, "rotate_every_days") || args.rotate_every_days == null) return null;
  return readInt(args.rotate_every_days, "rotate_every_days", 1, ROTATE_DAYS_MAX);
}

function readAlphabet(value) {
  if (typeof value !== "string") throw new RpcError(-32602, "alphabet must be a string");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new RpcError(-32602, "alphabet is invalid");
  const chars = Array.from(value);
  if (chars.length < 2 || chars.length > 256) throw new RpcError(-32602, "alphabet is out of range");
  if (new Set(chars).size !== chars.length) throw new RpcError(-32602, "alphabet must not repeat characters");
  return value;
}

function nowMsOf(ctx) {
  if (ctx && typeof ctx.nowMs === "number" && Number.isFinite(ctx.nowMs)) return ctx.nowMs;
  return Date.now();
}

function nowIso(ctx) {
  return new Date(nowMsOf(ctx)).toISOString();
}

function isOps(bot) {
  return !!bot && Number(bot.is_ops) === 1;
}

function requireOps(bot) {
  if (!isOps(bot)) throw forbidden();
}

export function idFromBytes(prefix, bytes) {
  if (!ID_PREFIXES.has(prefix)) throw new Error("bad id prefix");
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

/** 32 bytes of entropy, base64url, no padding. Shown to the caller once. */
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * `length` characters, each chosen uniformly from `alphabet` (unique code points).
 * Bytes at or above the largest multiple of the alphabet size are discarded so
 * `byte % n` is not biased. Uses crypto.getRandomValues only.
 */
export function randomFromAlphabet(length, alphabet) {
  const chars = Array.from(alphabet);
  const n = chars.length;
  if (!Number.isInteger(length) || length < 1) throw new Error("length");
  if (n < 2 || n > 256) throw new Error("alphabet size");
  const limit = 256 - (256 % n);
  const out = [];
  let spins = 0;
  while (out.length < length) {
    if (++spins > 10000) throw new Error("entropy exhausted");
    const buf = crypto.getRandomValues(new Uint8Array(Math.max((length - out.length) * 2, 32)));
    for (let i = 0; i < buf.length && out.length < length; i++) {
      if (buf[i] >= limit) continue;
      out.push(chars[buf[i] % n]);
    }
  }
  return out.join("");
}

function isUniqueError(err) {
  return /unique/i.test(String(err && err.message));
}

function uniqueTarget(err) {
  const match = /UNIQUE constraint failed: ([^\s]+)/i.exec(String(err && err.message));
  return match ? match[1] : "";
}

async function queryAll(ctx, sql, params) {
  if (!ctx || !ctx.db || typeof ctx.db.queryAll !== "function") throw new Error("queryAll is not configured");
  const rows = await ctx.db.queryAll(sql, params);
  return Array.isArray(rows) ? rows : [];
}

async function queryFirst(ctx, sql, params) {
  if (!ctx || !ctx.db || typeof ctx.db.queryFirst !== "function") throw new Error("queryFirst is not configured");
  const row = await ctx.db.queryFirst(sql, params);
  return row ?? null;
}

async function queryRun(ctx, sql, params) {
  if (!ctx || !ctx.db || typeof ctx.db.queryRun !== "function") throw new Error("queryRun is not configured");
  return ctx.db.queryRun(sql, params);
}

async function writeAudit(ctx, { action, secretName, leaseId, detail }) {
  const id = newId("aud_");
  const secretHash = secretName == null ? null : await sha256Hex(secretName);
  await queryRun(
    ctx,
    `INSERT INTO audit (id, ts, bot_id, action, secret_name_hash, lease_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, nowIso(ctx), ctx.bot.id, action, secretHash, leaseId ?? null, detail == null ? null : JSON.stringify(detail)],
  );
  return id;
}

function secretMeta(row, nowMs) {
  return {
    name: row.name,
    scope: row.scope,
    version: row.version,
    last_rotated_at: row.last_rotated_at,
    rotation_due: rotationDue(row.rotate_every_days, row.last_rotated_at, nowMs),
  };
}

async function insertFreshSecret(ctx, { name, scope, value, rotateEveryDays }) {
  const kek = loadKek(ctx.env);
  const now = nowIso(ctx);
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId("sec_");
    const sealed = await sealValue(kek, id, value);
    try {
      await queryRun(
        ctx,
        `INSERT INTO secrets (
          id, name, scope, dek_wrapped_b64, nonce_b64, ciphertext_b64,
          version, rotate_every_days, last_rotated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [id, name, scope, sealed.dek_wrapped_b64, sealed.nonce_b64, sealed.ciphertext_b64, rotateEveryDays, now, now, now],
      );
      return { name, scope, version: 1, last_rotated_at: now };
    } catch (err) {
      lastErr = err;
      if (!isUniqueError(err)) throw err;
      const target = uniqueTarget(err);
      if (target.endsWith(".name") || target === "name") {
        throw new RpcError(-32602, "secret already exists");
      }
    }
  }
  throw lastErr;
}

async function putSecret(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["name", "scope", "value", "rotate_every_days"]));
  const name = readLabel(args.name, "name");
  const scope = readLabel(args.scope, "scope");
  if (!has(args, "value")) throw new RpcError(-32602, "value is required");
  const value = readSecretValue(args.value, "value");
  const rotateEveryDays = readRotateDays(args);
  const stored = await insertFreshSecret(ctx, { name, scope, value, rotateEveryDays });
  await writeAudit(ctx, { action: "put_secret", secretName: name, detail: { version: 1 } });
  return stored;
}

async function generateSecret(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["name", "scope", "length", "alphabet"]));
  const name = readLabel(args.name, "name");
  const scope = readLabel(args.scope, "scope");
  const length = has(args, "length") ? readInt(args.length, "length", 1, GENERATE_LENGTH_MAX) : GENERATE_LENGTH_DEFAULT;
  const alphabet = has(args, "alphabet") ? readAlphabet(args.alphabet) : DEFAULT_SECRET_ALPHABET;
  const value = randomFromAlphabet(length, alphabet);
  const stored = await insertFreshSecret(ctx, { name, scope, value, rotateEveryDays: null });
  await writeAudit(ctx, { action: "generate_secret", secretName: name, detail: { version: 1, length } });
  return { ...stored, value };
}

async function getSecret(args, ctx) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["name", "ttl_seconds"]));
  const name = readLabel(args.name, "name");
  const ttl = has(args, "ttl_seconds") ? readInt(args.ttl_seconds, "ttl_seconds", 1, TTL_MAX) : TTL_DEFAULT;
  const row = await queryFirst(
    ctx,
    `SELECT id, name, scope, dek_wrapped_b64, nonce_b64, ciphertext_b64, version
     FROM secrets WHERE name = ?`,
    [name],
  );
  if (!row) throw notFound();
  const grant = await queryFirst(ctx, "SELECT scope FROM grants WHERE bot_id = ? AND scope = ?", [ctx.bot.id, row.scope]);
  if (!grant) throw forbidden();
  const value = await openValue(loadKek(ctx.env), row.id, row);
  const nowMs = nowMsOf(ctx);
  const issued = new Date(nowMs).toISOString();
  const expires = new Date(nowMs + ttl * 1000).toISOString();
  const leaseId = newId("lse_");
  await queryRun(
    ctx,
    `INSERT INTO leases (id, secret_id, bot_id, issued_at, expires_at, revoked)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [leaseId, row.id, ctx.bot.id, issued, expires],
  );
  await writeAudit(ctx, {
    action: "get_secret",
    secretName: name,
    leaseId,
    detail: { version: row.version, ttl_seconds: ttl },
  });
  return { value, lease_id: leaseId, expires_at: expires, version: row.version };
}

async function rotateSecret(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["name", "new_value"]));
  const name = readLabel(args.name, "name");
  if (!has(args, "new_value")) throw new RpcError(-32602, "new_value is required");
  const newValue = readSecretValue(args.new_value, "new_value");
  const row = await queryFirst(ctx, "SELECT id, version FROM secrets WHERE name = ?", [name]);
  if (!row) throw notFound();
  const sealed = await sealValue(loadKek(ctx.env), row.id, newValue);
  const now = nowIso(ctx);
  const next = Number(row.version) + 1;
  await queryRun(
    ctx,
    `UPDATE secrets
     SET dek_wrapped_b64 = ?, nonce_b64 = ?, ciphertext_b64 = ?, version = ?, last_rotated_at = ?, updated_at = ?
     WHERE id = ?`,
    [sealed.dek_wrapped_b64, sealed.nonce_b64, sealed.ciphertext_b64, next, now, now, row.id],
  );
  await queryRun(ctx, "UPDATE leases SET revoked = 1 WHERE secret_id = ? AND revoked = 0 AND expires_at > ?", [
    row.id,
    now,
  ]);
  await writeAudit(ctx, { action: "rotate_secret", secretName: name, detail: { version: next } });
  return { name, version: next, last_rotated_at: now };
}

async function revokeSecret(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["name"]));
  const name = readLabel(args.name, "name");
  const row = await queryFirst(ctx, "SELECT id FROM secrets WHERE name = ?", [name]);
  if (!row) throw notFound();
  await queryRun(ctx, "UPDATE leases SET revoked = 1 WHERE secret_id = ?", [row.id]);
  await queryRun(ctx, "DELETE FROM secrets WHERE id = ?", [row.id]);
  await writeAudit(ctx, { action: "revoke_secret", secretName: name, detail: { deleted: true } });
  return { name, deleted: true };
}

async function listSecrets(args, ctx) {
  requireArgs(args);
  assertOnlyKeys(args, new Set([]));
  const nowMs = nowMsOf(ctx);
  const rows = isOps(ctx.bot)
    ? await queryAll(
        ctx,
        `SELECT name, scope, version, last_rotated_at, rotate_every_days
         FROM secrets
         ORDER BY name ASC`,
        [],
      )
    : await queryAll(
        ctx,
        `SELECT name, scope, version, last_rotated_at, rotate_every_days
         FROM secrets
         WHERE scope IN (SELECT scope FROM grants WHERE bot_id = ?)
         ORDER BY name ASC`,
        [ctx.bot.id],
      );
  return rows.map((row) => secretMeta(row, nowMs));
}

async function createBot(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["name"]));
  const name = readLabel(args.name, "name");
  const now = nowIso(ctx);
  let created = null;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId("bot_");
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    try {
      await queryRun(
        ctx,
        `INSERT INTO bots (id, name, token_hash, is_ops, revoked, created_at)
         VALUES (?, ?, ?, 0, 0, ?)`,
        [id, name, tokenHash, now],
      );
      created = { id, name, token, is_ops: false };
      break;
    } catch (err) {
      lastErr = err;
      if (!isUniqueError(err)) throw err;
      const target = uniqueTarget(err);
      if (target.endsWith(".name") || target === "name") throw new RpcError(-32602, "bot already exists");
    }
  }
  if (!created) throw lastErr;
  await writeAudit(ctx, { action: "create_bot", detail: { created_bot_id: created.id } });
  return created;
}

async function grantAccess(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["bot_name", "scope"]));
  const botName = readLabel(args.bot_name, "bot_name");
  const scope = readLabel(args.scope, "scope");
  const bot = await queryFirst(ctx, "SELECT id, name FROM bots WHERE name = ?", [botName]);
  if (!bot) throw notFound();
  await queryRun(ctx, "INSERT OR IGNORE INTO grants (bot_id, scope) VALUES (?, ?)", [bot.id, scope]);
  await writeAudit(ctx, {
    action: "grant_access",
    detail: { grantee_id: bot.id, scope_hash: await sha256Hex(scope) },
  });
  return { bot_name: bot.name, scope, granted: true };
}

async function revokeBot(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["bot_name"]));
  const botName = readLabel(args.bot_name, "bot_name");
  const bot = await queryFirst(ctx, "SELECT id, name FROM bots WHERE name = ?", [botName]);
  if (!bot) throw notFound();
  const now = nowIso(ctx);
  await queryRun(ctx, "UPDATE bots SET revoked = 1 WHERE id = ?", [bot.id]);
  await queryRun(ctx, "UPDATE leases SET revoked = 1 WHERE bot_id = ? AND revoked = 0 AND expires_at > ?", [
    bot.id,
    now,
  ]);
  await writeAudit(ctx, { action: "revoke_bot", detail: { target_bot_id: bot.id } });
  return { id: bot.id, name: bot.name, revoked: true };
}

async function revokeLease(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["lease_id"]));
  if (typeof args.lease_id !== "string" || !/^lse_[a-z0-9]{12}$/.test(args.lease_id)) {
    throw new RpcError(-32602, "lease_id is required");
  }
  const row = await queryFirst(ctx, "SELECT id FROM leases WHERE id = ?", [args.lease_id]);
  if (!row) throw notFound();
  await queryRun(ctx, "UPDATE leases SET revoked = 1 WHERE id = ?", [args.lease_id]);
  await writeAudit(ctx, { action: "revoke_lease", leaseId: args.lease_id, detail: {} });
  return { lease_id: args.lease_id, revoked: true };
}

async function auditLog(args, ctx) {
  requireOps(ctx.bot);
  requireArgs(args);
  assertOnlyKeys(args, new Set(["bot_name", "secret_name", "action"]));
  let botId = null;
  if (has(args, "bot_name") && args.bot_name != null && args.bot_name !== "") {
    const botName = readLabel(args.bot_name, "bot_name");
    const bot = await queryFirst(ctx, "SELECT id FROM bots WHERE name = ?", [botName]);
    if (!bot) return { entries: [] };
    botId = bot.id;
  }
  let nameHash = null;
  if (has(args, "secret_name") && args.secret_name != null && args.secret_name !== "") {
    nameHash = await sha256Hex(readLabel(args.secret_name, "secret_name"));
  }
  let action = null;
  if (has(args, "action") && args.action != null && args.action !== "") {
    action = readLabel(args.action, "action");
  }
  const rows = await queryAll(
    ctx,
    `SELECT id, ts, bot_id, action, secret_name_hash, lease_id, detail
     FROM audit
     WHERE (? IS NULL OR bot_id = ?)
       AND (? IS NULL OR secret_name_hash = ?)
       AND (? IS NULL OR action = ?)
     ORDER BY ts DESC, id DESC
     LIMIT ?`,
    [botId, botId, nameHash, nameHash, action, action, AUDIT_LIMIT],
  );
  return {
    entries: rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      bot_id: row.bot_id,
      action: row.action,
      secret_name_hash: row.secret_name_hash ?? null,
      lease_id: row.lease_id ?? null,
      detail: row.detail ?? null,
    })),
  };
}

const HANDLERS = {
  put_secret: putSecret,
  generate_secret: generateSecret,
  get_secret: getSecret,
  rotate_secret: rotateSecret,
  revoke_secret: revokeSecret,
  list_secrets: listSecrets,
  create_bot: createBot,
  grant_access: grantAccess,
  revoke_bot: revokeBot,
  revoke_lease: revokeLease,
  audit_log: auditLog,
};

export const TOOLS = [
  {
    name: "put_secret",
    description: "运维写入一条新 secret。name 已存在时拒绝，改值用 rotate_secret。value 只在入库前出现，响应和审计都不带回。version 从 1 开始。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        scope: { type: "string" },
        value: { type: "string" },
        rotate_every_days: { type: "integer", minimum: 1, maximum: ROTATE_DAYS_MAX },
      },
      required: ["name", "scope", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_secret",
    description:
      "运维让服务端用 WebCrypto getRandomValues 生成随机 secret 并按 put_secret 的信封入库（新 DEK，version=1）。length 默认 32，最大 512。alphabet 省略时为 A-Z a-z 0-9，字符必须唯一。明文 value 只在这次响应里返回一次，不写日志，审计里也没有明文。bot 不要自己编造随机密钥。name 已存在时拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        scope: { type: "string" },
        length: { type: "integer", minimum: 1, maximum: GENERATE_LENGTH_MAX, default: GENERATE_LENGTH_DEFAULT },
        alphabet: { type: "string" },
      },
      required: ["name", "scope"],
      additionalProperties: false,
    },
  },
  {
    name: "get_secret",
    description:
      "按 name 解密 secret。调用者（含 ops）必须在 grants 里拥有该 secret 的 scope，否则 -32003。签发 lease 并在同一次响应里返回明文。ttl_seconds 默认 900，最大 86400。lease 不是二次取密凭证。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        ttl_seconds: { type: "integer", minimum: 1, maximum: TTL_MAX, default: TTL_DEFAULT },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "rotate_secret",
    description: "运维更换 secret 的值。新 DEK，version+1，last_rotated_at 更新，并吊销该 secret 所有未过期 lease。旧密文无法再用新 DEK 解开。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        new_value: { type: "string" },
      },
      required: ["name", "new_value"],
      additionalProperties: false,
    },
  },
  {
    name: "revoke_secret",
    description: "运维删除 secret 行（含密文）并吊销它的全部 lease。之后 get_secret 为 not found。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "list_secrets",
    description:
      "列出元数据。ops 看全部；普通 bot 只看自己被授权的 scope。字段只有 name、scope、version、last_rotated_at、rotation_due。没有值，也没有密文。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_bot",
    description: "运维创建一个 is_ops=0 的 bot。响应里的 token 只此一次，库里只存 SHA-256 hex。不能用这个工具制造 ops。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "grant_access",
    description: "运维把某个 scope 授给 bot_name。重复授予是幂等的。scope 可以先于 secret 存在。",
    inputSchema: {
      type: "object",
      properties: {
        bot_name: { type: "string" },
        scope: { type: "string" },
      },
      required: ["bot_name", "scope"],
      additionalProperties: false,
    },
  },
  {
    name: "revoke_bot",
    description: "运维把 bot 标为 revoked=1，并吊销该 bot 所有未过期 lease。之后这个 token 返回 401。",
    inputSchema: {
      type: "object",
      properties: { bot_name: { type: "string" } },
      required: ["bot_name"],
      additionalProperties: false,
    },
  },
  {
    name: "revoke_lease",
    description: "运维把一条 lease 标为 revoked=1。过期或已吊销的 lease 不能再当作有效窗口。",
    inputSchema: {
      type: "object",
      properties: { lease_id: { type: "string" } },
      required: ["lease_id"],
      additionalProperties: false,
    },
  },
  {
    name: "audit_log",
    description:
      "运维查询审计。bot_name、secret_name、action 都可选，同时给出时按与关系过滤。secret_name 传明文，服务端自行 SHA-256 后再查。返回行里只有 secret_name_hash，没有明文名，也没有 value。最多 500 行。",
    inputSchema: {
      type: "object",
      properties: {
        bot_name: { type: "string" },
        secret_name: { type: "string" },
        action: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

function toolText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function callTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) throw new RpcError(-32601, `unknown tool: ${name}`);
  if (!ctx || !ctx.bot) throw forbidden();
  if (OPS_TOOLS.has(name) && !isOps(ctx.bot)) throw forbidden();
  return handler(args, ctx);
}

export async function handleMcpRpc(message, ctx) {
  try {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { type: "error", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
      return { type: "error", id, error: { code: -32600, message: "Invalid Request" } };
    }
    if (message.method.startsWith("notifications/")) return { type: "notification" };
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
          serverInfo: { name: "botu-secrets", version: "1.0.0" },
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
      const value = await callTool(params.name, args, ctx);
      return { type: "result", id, result: toolText(value) };
    }
    return { type: "error", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  } catch (err) {
    if (err instanceof KekError) throw err;
    const id = message && typeof message === "object" && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
    if (err instanceof RpcError) return { type: "error", id, error: { code: err.code, message: err.message } };
    console.error(JSON.stringify({ msg: "mcp failed", error: err && err.name }));
    return { type: "error", id, error: { code: -32603, message: "internal error" } };
  }
}

function bindStmt(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length) return stmt.bind(...params);
  return stmt;
}

export function d1Deps(source) {
  if (!source || typeof source.prepare !== "function") {
    const missing = async () => {
      throw new Error("DB is not configured");
    };
    return { queryAll: missing, queryFirst: missing, queryRun: missing };
  }
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
  };
}

function resolveDb(env, deps) {
  if (deps && deps.db && typeof deps.db.queryAll === "function") return deps.db;
  return d1Deps(env && env.DB);
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

function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return null;
  if (match[1].length === 0 || /\s/.test(match[1])) return null;
  return match[1];
}

function jsonContentType(header) {
  if (!header) return false;
  const media = header.split(";", 1)[0].trim().toLowerCase();
  return media === "application/json";
}

export async function handleFetch(request, env, deps = {}) {
  const path = pathOf(request);

  if (path === "/health") {
    if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
    return json({ ok: true, service: "botu-secrets" });
  }

  if (path === "/mcp") {
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    const token = bearerToken(request.headers.get("authorization"));
    if (token == null) return json({ ok: false, error: "unauthorized" }, 401);
    loadKek(env);
    const db = resolveDb(env, deps);
    let bot;
    try {
      const tokenHash = await sha256Hex(token);
      bot = await db.queryFirst(
        "SELECT id, name, token_hash, is_ops, revoked, created_at FROM bots WHERE token_hash = ?",
        [tokenHash],
      );
    } catch (err) {
      console.error(JSON.stringify({ msg: "auth lookup failed", error: err && err.name }));
      return json({ ok: false, error: "internal error" }, 500);
    }
    if (!bot || Number(bot.revoked) === 1) return json({ ok: false, error: "unauthorized" }, 401);
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
    const rpc = await handleMcpRpc(message, {
      env,
      db,
      bot: { id: bot.id, name: bot.name, is_ops: Number(bot.is_ops), revoked: Number(bot.revoked) },
      nowMs: deps.nowMs,
    });
    if (rpc.type === "notification") return new Response(null, { status: 202 });
    if (rpc.type === "error") return json({ jsonrpc: "2.0", id: rpc.id ?? null, error: rpc.error });
    return json({ jsonrpc: "2.0", id: rpc.id, result: rpc.result });
  }

  return json({ ok: false, error: "not found" }, 404);
}

export default {
  fetch(request, env, ctx) {
    return handleFetch(request, env, { ctx });
  },
};
