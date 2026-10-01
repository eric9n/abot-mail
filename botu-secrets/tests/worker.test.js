import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, {
  DEFAULT_SECRET_ALPHABET,
  TOOLS,
  KekError,
  d1Deps,
  decryptValue,
  handleFetch,
  isLeaseActive,
  loadKek,
  openValue,
  randomFromAlphabet,
  rotationDue,
  sealValue,
  sha256Hex,
  unwrapDek,
} from "../src/worker.js";

const KEK = Buffer.alloc(32, 9).toString("base64");
const OPS = "ops-token-test-value-0123456789abcdef";
const READER = "reader-token-test-value-0123456789ab";
const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const NOW_ISO = "2026-10-01T00:00:00.000Z";
const DAY = 86_400_000;
const NAME = "stripe-live-key";
const VALUE = "sk_live_PLAINTEXT_9f3c1a";
const TOOL_NAMES = [
  "put_secret",
  "generate_secret",
  "get_secret",
  "rotate_secret",
  "revoke_secret",
  "list_secrets",
  "create_bot",
  "grant_access",
  "revoke_bot",
  "revoke_lease",
  "audit_log",
];
const OPS_TOOL_NAMES = [
  "put_secret",
  "generate_secret",
  "rotate_secret",
  "revoke_secret",
  "create_bot",
  "grant_access",
  "revoke_bot",
  "revoke_lease",
  "audit_log",
];

function schemaSql() {
  return readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
}

function memoryDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(schemaSql());
  const DB = {
    prepare(sql) {
      const make = (params) => ({
        all: async () => ({ results: raw.prepare(sql).all(...params) }),
        first: async () => raw.prepare(sql).get(...params) ?? null,
        run: async () => {
          const info = raw.prepare(sql).run(...params);
          return { success: true, meta: { changes: info.changes } };
        },
      });
      return { ...make([]), bind: (...params) => make(params) };
    },
  };
  return { raw, DB };
}

async function seedBot(raw, { id, name, token, isOps = 0, revoked = 0 }) {
  const tokenHash = await sha256Hex(token);
  raw
    .prepare("INSERT INTO bots (id, name, token_hash, is_ops, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, tokenHash, isOps, revoked, NOW_ISO);
  return tokenHash;
}

async function fresh() {
  const { raw, DB } = memoryDb();
  await seedBot(raw, { id: "bot_ops000000000", name: "ops", token: OPS, isOps: 1 });
  await seedBot(raw, { id: "bot_reader000000", name: "reader", token: READER, isOps: 0 });
  return { raw, env: { KEK_B64: KEK, DB } };
}

async function mcp(env, name, args, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token === undefined ? OPS : opts.token}`;
  const method = opts.method ?? "tools/call";
  const body = {
    jsonrpc: "2.0",
    id: opts.id ?? 1,
    method,
  };
  if (method === "tools/call") body.params = { name, arguments: args ?? {} };
  else if (opts.params !== undefined) body.params = opts.params;
  const res = await handleFetch(
    new Request(opts.url ?? "https://mcp.abot.run/secrets/mcp", {
      method: "POST",
      headers,
      body: opts.rawBody ?? JSON.stringify(body),
    }),
    env,
    { nowMs: opts.nowMs ?? NOW, db: opts.db },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function unwrap(rpc) {
  assert.equal(rpc.status, 200, JSON.stringify(rpc.body));
  assert.equal(rpc.body.error, undefined, JSON.stringify(rpc.body));
  return JSON.parse(rpc.body.result.content[0].text);
}

function rpcError(rpc) {
  assert.equal(rpc.status, 200, JSON.stringify(rpc.body));
  assert.ok(rpc.body.error, JSON.stringify(rpc.body));
  return rpc.body.error;
}

function countOf(raw, table) {
  return raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function auditBlob(raw) {
  return JSON.stringify(raw.prepare("SELECT * FROM audit").all());
}

test("schema.sql is idempotent and matches the vault tables", () => {
  const sql = schemaSql();
  assert.equal(/drop\s+table/i.test(sql), false);
  assert.equal(/\balter\s+table\b/i.test(sql), false);
  for (const table of ["bots", "secrets", "grants", "leases", "audit"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.exec(sql);
  db.prepare(
    "INSERT INTO bots (id, name, token_hash, is_ops, revoked, created_at) VALUES (?, ?, ?, 1, 0, ?)",
  ).run("bot_ops000000000", "ops", "ab".repeat(32), NOW_ISO);
  db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bots").get().n, 1);
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('bots')").all().map((row) => row.name),
    ["id", "name", "token_hash", "is_ops", "revoked", "created_at"],
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('secrets')").all().map((row) => row.name),
    [
      "id",
      "name",
      "scope",
      "dek_wrapped_b64",
      "nonce_b64",
      "ciphertext_b64",
      "version",
      "rotate_every_days",
      "last_rotated_at",
      "created_at",
      "updated_at",
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('grants')").all().map((row) => row.name),
    ["bot_id", "scope"],
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('leases')").all().map((row) => row.name),
    ["id", "secret_id", "bot_id", "issued_at", "expires_at", "revoked"],
  );
  assert.deepEqual(
    db.prepare("SELECT name FROM pragma_table_info('audit')").all().map((row) => row.name),
    ["id", "ts", "bot_id", "action", "secret_name_hash", "lease_id", "detail"],
  );
});

test("readme and env docs describe the ten tools, -32003, and the KEK", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const envDoc = readFileSync(new URL("../deploy/ENV.md", import.meta.url), "utf8");
  const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  for (const name of TOOL_NAMES) assert.equal(readme.includes(name), true, name);
  assert.equal(readme.includes("-32003"), true);
  assert.equal(readme.includes("dek_wrapped_b64"), true);
  assert.equal(readme.includes("botu-secrets.dek.v1"), true);
  assert.equal(readme.includes("botu-secrets.val.v1"), true);
  assert.equal(envDoc.includes("KEK_B64"), true);
  assert.equal(envDoc.includes("DB"), true);
  assert.match(src, /KEK_B64/);
  assert.match(src, /env && env\.DB/);
  assert.equal(src.includes("DATA_MCP_TOKEN"), false);
});

test("health is public and only /secrets/mcp and /secrets/health exist", async () => {
  const { env } = await fresh();
  const health = await worker.fetch(new Request("https://mcp.abot.run/secrets/health"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "botu-secrets" });

  const slashed = await handleFetch(new Request("https://mcp.abot.run/secrets/health/"), {});
  assert.equal(slashed.status, 200);
  assert.deepEqual(await slashed.json(), { ok: true, service: "botu-secrets" });

  const posted = await handleFetch(new Request("https://mcp.abot.run/secrets/health", { method: "POST" }), env);
  assert.equal(posted.status, 405);

  const getMcp = await handleFetch(new Request("https://mcp.abot.run/secrets/mcp"), env);
  assert.equal(getMcp.status, 405);

  for (const url of ["https://mcp.abot.run/secrets", "https://mcp.abot.run/mcp", "https://mcp.abot.run/secrets/nope"]) {
    const res = await handleFetch(new Request(url), env);
    assert.equal(res.status, 404, url);
    assert.deepEqual(await res.json(), { ok: false, error: "not found" });
  }
});

test("unauthenticated MCP is 401 before the database, and a revoked bot is 401", async () => {
  let touched = false;
  const closed = {
    KEK_B64: KEK,
    DB: {
      prepare() {
        touched = true;
        throw new Error("db touched");
      },
    },
  };
  const missing = await handleFetch(
    new Request("https://mcp.abot.run/secrets/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    {},
  );
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, error: "unauthorized" });

  const malformed = await handleFetch(
    new Request("https://mcp.abot.run/secrets/mcp", {
      method: "POST",
      headers: { authorization: "Token nope", "content-type": "application/json" },
      body: "{}",
    }),
    closed,
  );
  assert.equal(malformed.status, 401);
  assert.equal(touched, false);

  const { env } = await fresh();
  const wrong = await mcp(env, "list_secrets", {}, { token: "not-a-real-token" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { ok: false, error: "unauthorized" });

  const { raw, DB } = memoryDb();
  await seedBot(raw, {
    id: "bot_revoked00000",
    name: "gone",
    token: "revoked-token-0123456789abcdef0123",
    revoked: 1,
  });
  const revoked = await handleFetch(
    new Request("https://mcp.abot.run/secrets/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer revoked-token-0123456789abcdef0123",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    { KEK_B64: KEK, DB },
    { nowMs: NOW },
  );
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), { ok: false, error: "unauthorized" });
});

test("a missing, illegal, or non-32-byte KEK throws before any database call", async () => {
  assert.throws(() => loadKek(undefined), KekError);
  assert.throws(() => loadKek({}), /KEK_B64 is missing/);
  assert.throws(() => loadKek({ KEK_B64: "" }), /KEK_B64 is missing/);
  assert.throws(() => loadKek({ KEK_B64: "!!!!" }), /not valid base64/);
  assert.throws(() => loadKek({ KEK_B64: "abc" }), /not valid base64/);
  assert.throws(() => loadKek({ KEK_B64: "YQ==" }), /32 bytes/);
  assert.throws(() => loadKek({ KEK_B64: Buffer.alloc(16, 1).toString("base64") }), /32 bytes/);
  assert.throws(() => loadKek({ KEK_B64: Buffer.alloc(31, 1).toString("base64") }), /32 bytes/);
  assert.throws(() => loadKek({ KEK_B64: Buffer.alloc(33, 1).toString("base64") }), /32 bytes/);
  assert.throws(() => loadKek({ KEK_B64: Buffer.alloc(64, 2).toString("base64") }), /32 bytes/);
  assert.equal(loadKek({ KEK_B64: KEK }).length, 32);

  let touched = false;
  const closed = {
    KEK_B64: "YQ==",
    DB: {
      prepare() {
        touched = true;
        throw new Error("db touched");
      },
    },
  };
  await assert.rejects(
    () =>
      handleFetch(
        new Request("https://mcp.abot.run/secrets/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
        closed,
      ),
    (err) => err instanceof KekError && /32 bytes/.test(err.message),
  );
  await assert.rejects(
    () =>
      handleFetch(
        new Request("https://mcp.abot.run/secrets/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
          body: "{}",
        }),
        { DB: closed.DB },
      ),
    (err) => err instanceof KekError && /missing/.test(err.message),
  );
  assert.equal(touched, false);

  const health = await handleFetch(new Request("https://mcp.abot.run/secrets/health"), {});
  assert.equal(health.status, 200);
});

test("initialize, tools/list, unknown tools, and bad params follow JSON-RPC", async () => {
  const { env } = await fresh();
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    TOOL_NAMES,
  );
  const listed = await mcp(env, null, null, { method: "tools/list" });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.result.tools.map((tool) => tool.name),
    TOOL_NAMES,
  );
  for (const tool of listed.body.result.tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  const init = await mcp(env, null, null, { method: "initialize", id: 7 });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.name, "botu-secrets");
  assert.equal(init.body.result.serverInfo.version, "1.0.0");

  const note = await handleFetch(
    new Request("https://mcp.abot.run/secrets/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
    env,
    { nowMs: NOW },
  );
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");

  const unknown = rpcError(await mcp(env, "drop_table", {}));
  assert.equal(unknown.code, -32601);

  const method = rpcError(await mcp(env, null, null, { method: "nope" }));
  assert.equal(method.code, -32601);

  const missingName = rpcError(await mcp(env, "put_secret", { scope: "llm", value: "x" }));
  assert.equal(missingName.code, -32602);

  const extra = rpcError(await mcp(env, "list_secrets", { limit: 1 }));
  assert.equal(extra.code, -32602);

  const badType = await handleFetch(
    new Request("https://mcp.abot.run/secrets/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${OPS}`, "content-type": "text/plain" },
      body: "{}",
    }),
    env,
  );
  assert.equal(badType.status, 415);

  const badJson = await handleFetch(
    new Request("https://mcp.abot.run/secrets/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
      body: "{",
    }),
    env,
  );
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, -32700);
});

test("AES-GCM round trip, rotation_due, and lease expiry are pure functions", async () => {
  const kek = loadKek({ KEK_B64: KEK });
  const sealed = await sealValue(kek, "sec_abcdefghijkl", "hello 密钥");
  assert.equal(await openValue(kek, "sec_abcdefghijkl", sealed), "hello 密钥");
  await assert.rejects(() => openValue(kek, "sec_other0000000", sealed));
  const dek = await unwrapDek(kek, sealed.dek_wrapped_b64);
  assert.equal(dek.length, 32);
  await assert.rejects(() => decryptValue(crypto.getRandomValues(new Uint8Array(32)), "sec_abcdefghijkl", sealed.nonce_b64, sealed.ciphertext_b64));
  assert.equal(sealed.dek_wrapped_b64.includes("hello"), false);

  assert.equal(rotationDue(null, NOW_ISO, NOW + 10 * DAY), false);
  assert.equal(rotationDue(1, NOW_ISO, NOW + DAY), false);
  assert.equal(rotationDue(1, NOW_ISO, NOW + DAY + 1), true);
  assert.equal(rotationDue(30, NOW_ISO, NOW + 30 * DAY), false);
  assert.equal(rotationDue(30, NOW_ISO, NOW + 30 * DAY + 1), true);

  const lease = { revoked: 0, expires_at: new Date(NOW + 1000).toISOString() };
  assert.equal(isLeaseActive(lease, NOW), true);
  assert.equal(isLeaseActive(lease, NOW + 999), true);
  assert.equal(isLeaseActive(lease, NOW + 1000), false);
  assert.equal(isLeaseActive(lease, NOW + 1001), false);
  assert.equal(isLeaseActive({ ...lease, revoked: 1 }, NOW), false);
  assert.equal(isLeaseActive(null, NOW), false);
  assert.equal(isLeaseActive({ revoked: 0, expires_at: "not-a-date" }, NOW), false);
});

test("put_secret stores ciphertext under a new DEK and rejects a duplicate name", async () => {
  const { raw, DB } = memoryDb();
  await seedBot(raw, { id: "bot_ops000000000", name: "ops", token: OPS, isOps: 1 });
  const injected = d1Deps(DB);
  const env = { KEK_B64: KEK };
  const put = unwrap(
    await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE, rotate_every_days: 30 }, { db: injected }),
  );
  assert.deepEqual(put, { name: NAME, scope: "payments", version: 1, last_rotated_at: NOW_ISO });
  assert.equal(JSON.stringify(put).includes(VALUE), false);

  const row = raw.prepare("SELECT * FROM secrets WHERE name = ?").get(NAME);
  assert.equal(row.version, 1);
  assert.equal(row.scope, "payments");
  assert.equal(row.rotate_every_days, 30);
  assert.equal(row.ciphertext_b64.includes(VALUE), false);
  assert.equal(row.dek_wrapped_b64.includes(VALUE), false);
  assert.equal(await openValue(loadKek({ KEK_B64: KEK }), row.id, row), VALUE);
  assert.equal(countOf(raw, "secrets"), 1);
  const blob = JSON.stringify(raw.prepare("SELECT * FROM secrets").all());
  assert.equal(blob.includes(VALUE), false);

  const again = rpcError(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: "other" }, { db: injected }));
  assert.equal(again.code, -32602);
  assert.equal(again.message, "secret already exists");
  assert.equal(countOf(raw, "secrets"), 1);

  const poison = unwrap(await mcp(env, "put_secret", { name: "'; DROP TABLE secrets; --", scope: "x", value: "y" }, { db: injected }));
  assert.equal(poison.name, "'; DROP TABLE secrets; --");
  assert.equal(countOf(raw, "secrets"), 2);
});

test("get_secret returns the value, a lease, and an audit row", async () => {
  const { raw, env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE }));
  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));

  const got = unwrap(await mcp(env, "get_secret", { name: NAME }, { token: READER }));
  assert.equal(got.value, VALUE);
  assert.equal(got.version, 1);
  assert.match(got.lease_id, /^lse_[a-z0-9]{12}$/);
  assert.equal(got.expires_at, new Date(NOW + 900 * 1000).toISOString());
  assert.deepEqual(Object.keys(got).sort(), ["expires_at", "lease_id", "value", "version"]);

  const lease = raw.prepare("SELECT * FROM leases WHERE id = ?").get(got.lease_id);
  assert.equal(lease.bot_id, "bot_reader000000");
  assert.equal(lease.revoked, 0);
  assert.equal(lease.issued_at, NOW_ISO);
  assert.equal(lease.expires_at, got.expires_at);
  assert.equal(isLeaseActive(lease, NOW), true);
  assert.equal(isLeaseActive(lease, Date.parse(lease.expires_at)), false);

  const short = unwrap(await mcp(env, "get_secret", { name: NAME, ttl_seconds: 60 }, { token: READER }));
  assert.equal(short.expires_at, new Date(NOW + 60 * 1000).toISOString());
  assert.equal(countOf(raw, "leases"), 2);

  const hash = await sha256Hex(NAME);
  const audits = raw.prepare("SELECT * FROM audit WHERE action = 'get_secret'").all();
  assert.equal(audits.length, 2);
  for (const row of audits) {
    assert.equal(row.secret_name_hash, hash);
    assert.equal(row.bot_id, "bot_reader000000");
    assert.match(row.lease_id, /^lse_[a-z0-9]{12}$/);
  }
  assert.equal(auditBlob(raw).includes(NAME), false);
  assert.equal(auditBlob(raw).includes(VALUE), false);

  const badTtl = rpcError(await mcp(env, "get_secret", { name: NAME, ttl_seconds: 0 }, { token: READER }));
  assert.equal(badTtl.code, -32602);
  const missing = rpcError(await mcp(env, "get_secret", { name: "missing-secret" }, { token: READER }));
  assert.equal(missing.code, -32602);
  assert.equal(missing.message, "not found");
});

test("get without a grant and ops tools from a normal bot return -32003", async () => {
  const { raw, env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE }));

  const reader = rpcError(await mcp(env, "get_secret", { name: NAME }, { token: READER }));
  assert.equal(reader.code, -32003);
  assert.equal(reader.message, "forbidden");

  const ops = rpcError(await mcp(env, "get_secret", { name: NAME }));
  assert.equal(ops.code, -32003);
  assert.equal(countOf(raw, "leases"), 0);

  for (const name of OPS_TOOL_NAMES) {
    const err = rpcError(await mcp(env, name, {}, { token: READER }));
    assert.equal(err.code, -32003, name);
    assert.equal(err.message, "forbidden");
  }
  assert.equal(countOf(raw, "secrets"), 1);
  assert.equal(countOf(raw, "bots"), 2);

  unwrap(await mcp(env, "grant_access", { bot_name: "ops", scope: "payments" }));
  const allowed = unwrap(await mcp(env, "get_secret", { name: NAME }));
  assert.equal(allowed.value, VALUE);
});

test("list_secrets hides values and sets rotation_due from the injected clock", async () => {
  const { env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: "b-key", scope: "staging", value: VALUE }));
  unwrap(await mcp(env, "put_secret", { name: "a-key", scope: "payments", value: "other-value", rotate_every_days: 1 }));
  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));

  const none = unwrap(await mcp(env, "list_secrets", {}, { token: READER, nowMs: NOW }));
  assert.deepEqual(
    none.map((row) => row.name),
    ["a-key"],
  );
  assert.deepEqual(Object.keys(none[0]).sort(), ["last_rotated_at", "name", "rotation_due", "scope", "version"]);
  assert.equal(none[0].rotation_due, false);
  assert.equal(none[0].scope, "payments");
  assert.equal(JSON.stringify(none).includes("other-value"), false);
  assert.equal(JSON.stringify(none).includes("dek_wrapped"), false);

  const due = unwrap(await mcp(env, "list_secrets", {}, { token: READER, nowMs: NOW + DAY }));
  assert.equal(due[0].rotation_due, false);
  const over = unwrap(await mcp(env, "list_secrets", {}, { token: READER, nowMs: NOW + DAY + 1 }));
  assert.equal(over[0].rotation_due, true);

  const all = unwrap(await mcp(env, "list_secrets", {}, { nowMs: NOW + 40 * DAY }));
  assert.deepEqual(
    all.map((row) => row.name),
    ["a-key", "b-key"],
  );
  assert.equal(all[0].rotation_due, true);
  assert.equal(all[1].rotation_due, false);
  assert.equal(JSON.stringify(all).includes(VALUE), false);
});

test("rotate_secret bumps version, swaps the DEK, and revokes unexpired leases", async () => {
  const { raw, env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE }));
  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));
  const first = unwrap(await mcp(env, "get_secret", { name: NAME, ttl_seconds: 900 }, { token: READER }));
  const before = raw.prepare("SELECT * FROM secrets WHERE name = ?").get(NAME);
  const secretId = before.id;
  raw.prepare(
    "INSERT INTO leases (id, secret_id, bot_id, issued_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)",
  ).run("lse_expired00000", secretId, "bot_reader000000", NOW_ISO, new Date(NOW - 1000).toISOString());

  const later = NOW + 5000;
  const laterIso = new Date(later).toISOString();
  const nextValue = "sk_live_ROTATED_VALUE_22aa";
  const rotated = unwrap(await mcp(env, "rotate_secret", { name: NAME, new_value: nextValue }, { nowMs: later }));
  assert.deepEqual(rotated, { name: NAME, version: 2, last_rotated_at: laterIso });
  assert.equal(JSON.stringify(rotated).includes(nextValue), false);

  const after = raw.prepare("SELECT * FROM secrets WHERE name = ?").get(NAME);
  assert.equal(after.version, 2);
  assert.equal(after.last_rotated_at, laterIso);
  assert.equal(after.created_at, NOW_ISO);
  assert.notEqual(after.ciphertext_b64, before.ciphertext_b64);
  assert.notEqual(after.dek_wrapped_b64, before.dek_wrapped_b64);
  assert.equal(await openValue(loadKek({ KEK_B64: KEK }), after.id, before), VALUE);
  assert.equal(await openValue(loadKek({ KEK_B64: KEK }), after.id, after), nextValue);
  const newDek = await unwrapDek(loadKek({ KEK_B64: KEK }), after.dek_wrapped_b64);
  await assert.rejects(() => decryptValue(newDek, after.id, before.nonce_b64, before.ciphertext_b64));

  assert.equal(raw.prepare("SELECT revoked FROM leases WHERE id = ?").get(first.lease_id).revoked, 1);
  assert.equal(raw.prepare("SELECT revoked FROM leases WHERE id = 'lse_expired00000'").get().revoked, 0);
  assert.equal(isLeaseActive(raw.prepare("SELECT * FROM leases WHERE id = 'lse_expired00000'").get(), later), false);

  const got = unwrap(await mcp(env, "get_secret", { name: NAME }, { token: READER, nowMs: later }));
  assert.equal(got.value, nextValue);
  assert.equal(got.version, 2);
  assert.equal(auditBlob(raw).includes(NAME), false);
  assert.equal(auditBlob(raw).includes(VALUE), false);
  assert.equal(auditBlob(raw).includes(nextValue), false);
  assert.equal(raw.prepare("SELECT secret_name_hash FROM audit WHERE action = 'rotate_secret'").get().secret_name_hash, await sha256Hex(NAME));

  const missing = rpcError(await mcp(env, "rotate_secret", { name: "nope", new_value: "z" }));
  assert.equal(missing.code, -32602);
  assert.equal(missing.message, "not found");
});

test("revoke_secret deletes the ciphertext row and get becomes not found", async () => {
  const { raw, env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE }));
  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));
  const got = unwrap(await mcp(env, "get_secret", { name: NAME }, { token: READER }));
  const secretId = raw.prepare("SELECT id FROM secrets WHERE name = ?").get(NAME).id;
  raw.prepare(
    "INSERT INTO leases (id, secret_id, bot_id, issued_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)",
  ).run("lse_expired00000", secretId, "bot_reader000000", NOW_ISO, new Date(NOW - 1000).toISOString());

  const removed = unwrap(await mcp(env, "revoke_secret", { name: NAME }));
  assert.deepEqual(removed, { name: NAME, deleted: true });
  assert.equal(countOf(raw, "secrets"), 0);
  assert.equal(raw.prepare("SELECT revoked FROM leases WHERE id = ?").get(got.lease_id).revoked, 1);
  assert.equal(raw.prepare("SELECT revoked FROM leases WHERE id = 'lse_expired00000'").get().revoked, 1);
  const again = rpcError(await mcp(env, "get_secret", { name: NAME }, { token: READER }));
  assert.equal(again.code, -32602);
  assert.equal(again.message, "not found");
  assert.equal(auditBlob(raw).includes(VALUE), false);
  assert.equal(auditBlob(raw).includes(NAME), false);
});

test("create_bot returns a one-time token and stores only the sha256", async () => {
  const { raw, env } = await fresh();
  const created = unwrap(await mcp(env, "create_bot", { name: "helper" }));
  assert.match(created.id, /^bot_[a-z0-9]{12}$/);
  assert.equal(created.name, "helper");
  assert.equal(created.is_ops, false);
  assert.match(created.token, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(created.token, "base64url").length, 32);

  const row = raw.prepare("SELECT * FROM bots WHERE name = 'helper'").get();
  assert.equal(row.token_hash, await sha256Hex(created.token));
  assert.equal(row.is_ops, 0);
  assert.equal(row.revoked, 0);
  assert.equal(JSON.stringify(row).includes(created.token), false);
  assert.equal(auditBlob(raw).includes(created.token), false);
  assert.equal(raw.prepare("SELECT action, secret_name_hash FROM audit WHERE action = 'create_bot'").get().secret_name_hash, null);

  const listed = unwrap(await mcp(env, "list_secrets", {}, { token: created.token }));
  assert.deepEqual(listed, []);
  const denied = rpcError(await mcp(env, "put_secret", { name: "n", scope: "s", value: "v" }, { token: created.token }));
  assert.equal(denied.code, -32003);

  const dup = rpcError(await mcp(env, "create_bot", { name: "helper" }));
  assert.equal(dup.code, -32602);
  assert.equal(dup.message, "bot already exists");
  const second = unwrap(await mcp(env, "create_bot", { name: "helper-2" }));
  assert.notEqual(second.token, created.token);
});

test("grant_access is idempotent and scopes the later get", async () => {
  const { raw, env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE }));
  const granted = unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));
  assert.deepEqual(granted, { bot_name: "reader", scope: "payments", granted: true });
  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));
  assert.equal(countOf(raw, "grants"), 1);
  const got = unwrap(await mcp(env, "get_secret", { name: NAME }, { token: READER }));
  assert.equal(got.value, VALUE);

  const missing = rpcError(await mcp(env, "grant_access", { bot_name: "nobody", scope: "payments" }));
  assert.equal(missing.code, -32602);
  assert.equal(missing.message, "not found");
  assert.equal(auditBlob(raw).includes(VALUE), false);
});

test("revoke_bot disables the token and revokes that bot's unexpired leases", async () => {
  const { raw, env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE }));
  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));
  const got = unwrap(await mcp(env, "get_secret", { name: NAME, ttl_seconds: 30 }, { token: READER }));
  const secretId = raw.prepare("SELECT id FROM secrets WHERE name = ?").get(NAME).id;
  raw.prepare(
    "INSERT INTO leases (id, secret_id, bot_id, issued_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)",
  ).run("lse_expired00000", secretId, "bot_reader000000", NOW_ISO, new Date(NOW - 1000).toISOString());

  const revoked = unwrap(await mcp(env, "revoke_bot", { bot_name: "reader" }));
  assert.deepEqual(revoked, { id: "bot_reader000000", name: "reader", revoked: true });
  assert.equal(raw.prepare("SELECT revoked FROM bots WHERE name = 'reader'").get().revoked, 1);
  assert.equal(raw.prepare("SELECT revoked FROM leases WHERE id = ?").get(got.lease_id).revoked, 1);
  assert.equal(raw.prepare("SELECT revoked FROM leases WHERE id = 'lse_expired00000'").get().revoked, 0);

  const later = await mcp(env, "list_secrets", {}, { token: READER });
  assert.equal(later.status, 401);
  assert.deepEqual(later.body, { ok: false, error: "unauthorized" });
  const audit = raw.prepare("SELECT * FROM audit WHERE action = 'revoke_bot'").get();
  assert.equal(audit.bot_id, "bot_ops000000000");
  assert.equal(audit.secret_name_hash, null);
  assert.equal(audit.detail.includes(READER), false);
});

test("revoke_lease marks one lease revoked", async () => {
  const { raw, env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE }));
  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));
  const got = unwrap(await mcp(env, "get_secret", { name: NAME }, { token: READER }));
  const result = unwrap(await mcp(env, "revoke_lease", { lease_id: got.lease_id }));
  assert.deepEqual(result, { lease_id: got.lease_id, revoked: true });
  const row = raw.prepare("SELECT * FROM leases WHERE id = ?").get(got.lease_id);
  assert.equal(row.revoked, 1);
  assert.equal(isLeaseActive(row, NOW), false);
  unwrap(await mcp(env, "revoke_lease", { lease_id: got.lease_id }));
  assert.equal(raw.prepare("SELECT revoked FROM leases WHERE id = ?").get(got.lease_id).revoked, 1);

  const bad = rpcError(await mcp(env, "revoke_lease", { lease_id: "nope" }));
  assert.equal(bad.code, -32602);
  const missing = rpcError(await mcp(env, "revoke_lease", { lease_id: "lse_abcdefghijkl" }));
  assert.equal(missing.code, -32602);
  assert.equal(missing.message, "not found");
  const audit = raw.prepare("SELECT * FROM audit WHERE action = 'revoke_lease' ORDER BY ts, id").all();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].lease_id, got.lease_id);
  assert.equal(audit[0].secret_name_hash, null);
  assert.equal(JSON.stringify(audit).includes(VALUE), false);
  assert.equal(JSON.stringify(audit).includes(NAME), false);
});

test("audit_log filters by bot, secret name hash, and action without plaintext", async () => {
  const { raw, env } = await fresh();
  unwrap(await mcp(env, "put_secret", { name: NAME, scope: "payments", value: VALUE }));
  unwrap(await mcp(env, "create_bot", { name: "helper" }));
  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));
  unwrap(await mcp(env, "get_secret", { name: NAME }, { token: READER }));
  unwrap(await mcp(env, "rotate_secret", { name: NAME, new_value: "sk_live_ROTATED_VALUE_22aa" }));
  unwrap(await mcp(env, "revoke_secret", { name: NAME }));
  const hash = await sha256Hex(NAME);

  const all = unwrap(await mcp(env, "audit_log", {}));
  const actions = all.entries.map((row) => row.action);
  for (const action of ["put_secret", "get_secret", "rotate_secret", "revoke_secret", "create_bot", "grant_access"]) {
    assert.equal(actions.includes(action), true, action);
  }
  for (const row of all.entries) {
    assert.equal(Object.hasOwn(row, "secret_name_hash"), true);
    assert.equal(JSON.stringify(row).includes(NAME), false);
    assert.equal(JSON.stringify(row).includes(VALUE), false);
    assert.equal(JSON.stringify(row).includes("sk_live_ROTATED_VALUE_22aa"), false);
    if (row.secret_name_hash != null) assert.equal(row.secret_name_hash, hash);
  }
  assert.equal(auditBlob(raw).includes(NAME), false);
  assert.equal(auditBlob(raw).includes(VALUE), false);

  const byAction = unwrap(await mcp(env, "audit_log", { action: "get_secret" }));
  assert.equal(byAction.entries.length, 1);
  assert.equal(byAction.entries[0].action, "get_secret");
  assert.equal(byAction.entries[0].secret_name_hash, hash);
  assert.equal(byAction.entries[0].bot_id, "bot_reader000000");

  const byName = unwrap(await mcp(env, "audit_log", { secret_name: NAME }));
  assert.deepEqual(
    byName.entries.map((row) => row.action).sort(),
    ["get_secret", "put_secret", "revoke_secret", "rotate_secret"],
  );
  const byBot = unwrap(await mcp(env, "audit_log", { bot_name: "reader", secret_name: NAME, action: "get_secret" }));
  assert.equal(byBot.entries.length, 1);
  assert.equal(byBot.entries[0].lease_id, byAction.entries[0].lease_id);

  const nobody = unwrap(await mcp(env, "audit_log", { bot_name: "missing-bot" }));
  assert.deepEqual(nobody, { entries: [] });
  const created = unwrap(await mcp(env, "audit_log", { action: "create_bot" }));
  assert.equal(created.entries.length, 1);
  assert.equal(created.entries[0].secret_name_hash, null);
  assert.equal(created.entries[0].detail.includes("token"), false);
});

test("generate_secret draws a server-side value once and stores it like put_secret", async () => {
  assert.equal(DEFAULT_SECRET_ALPHABET.length, 62);
  assert.equal(new Set(DEFAULT_SECRET_ALPHABET).size, 62);
  const drawn = randomFromAlphabet(64, "abc");
  assert.equal(drawn.length, 64);
  assert.match(drawn, /^[abc]+$/);
  assert.equal(drawn.includes("a") && drawn.includes("b") && drawn.includes("c"), true);

  const { raw, env } = await fresh();
  const secretName = "generated-api-key";
  const made = unwrap(await mcp(env, "generate_secret", { name: secretName, scope: "payments" }));
  assert.equal(made.name, secretName);
  assert.equal(made.scope, "payments");
  assert.equal(made.version, 1);
  assert.equal(made.last_rotated_at, NOW_ISO);
  assert.equal(made.value.length, 32);
  assert.match(made.value, /^[A-Za-z0-9]+$/);
  assert.deepEqual(Object.keys(made).sort(), ["last_rotated_at", "name", "scope", "value", "version"]);

  const custom = unwrap(
    await mcp(env, "generate_secret", { name: "generated-pin", scope: "payments", length: 24, alphabet: "xyz" }),
  );
  assert.equal(custom.value.length, 24);
  assert.match(custom.value, /^[xyz]+$/);
  assert.notEqual(custom.value, made.value);

  const row = raw.prepare("SELECT * FROM secrets WHERE name = ?").get(secretName);
  assert.equal(row.version, 1);
  assert.equal(row.rotate_every_days, null);
  assert.equal(await openValue(loadKek({ KEK_B64: KEK }), row.id, row), made.value);
  const stored = JSON.stringify(raw.prepare("SELECT * FROM secrets").all());
  assert.equal(stored.includes(made.value), false);
  assert.equal(stored.includes(custom.value), false);

  const listed = unwrap(await mcp(env, "list_secrets", {}));
  assert.equal(JSON.stringify(listed).includes(made.value), false);
  assert.deepEqual(
    listed.map((item) => item.name),
    ["generated-api-key", "generated-pin"],
  );

  const denied = rpcError(await mcp(env, "get_secret", { name: secretName }));
  assert.equal(denied.code, -32003);
  assert.equal(JSON.stringify(denied).includes(made.value), false);
  const readerDenied = rpcError(await mcp(env, "generate_secret", { name: "other", scope: "payments" }, { token: READER }));
  assert.equal(readerDenied.code, -32003);

  unwrap(await mcp(env, "grant_access", { bot_name: "reader", scope: "payments" }));
  const got = unwrap(await mcp(env, "get_secret", { name: secretName }, { token: READER }));
  assert.equal(got.value, made.value);

  const again = rpcError(await mcp(env, "generate_secret", { name: secretName, scope: "payments" }));
  assert.equal(again.code, -32602);
  assert.equal(again.message, "secret already exists");
  assert.equal(JSON.stringify(again).includes(made.value), false);
  const collided = rpcError(await mcp(env, "put_secret", { name: secretName, scope: "payments", value: "user-supplied" }));
  assert.equal(collided.code, -32602);

  const hash = await sha256Hex(secretName);
  const audits = raw.prepare("SELECT * FROM audit WHERE action = 'generate_secret'").all();
  assert.equal(audits.length, 2);
  const firstAudit = audits.find((item) => item.secret_name_hash === hash);
  assert.ok(firstAudit);
  assert.equal(firstAudit.detail, JSON.stringify({ version: 1, length: 32 }));
  assert.equal(auditBlob(raw).includes(made.value), false);
  assert.equal(auditBlob(raw).includes(custom.value), false);
  assert.equal(auditBlob(raw).includes(secretName), false);
  const logged = unwrap(await mcp(env, "audit_log", { action: "generate_secret", secret_name: secretName }));
  assert.equal(logged.entries.length, 1);
  assert.equal(logged.entries[0].secret_name_hash, hash);
  assert.equal(JSON.stringify(logged).includes(made.value), false);

  for (const args of [
    { name: "n", scope: "s", length: 0 },
    { name: "n", scope: "s", length: 1.5 },
    { name: "n", scope: "s", length: 513 },
    { name: "n", scope: "s", alphabet: "a" },
    { name: "n", scope: "s", alphabet: "aba" },
    { name: "n", scope: "s", alphabet: "ab\n" },
    { scope: "s" },
  ]) {
    const err = rpcError(await mcp(env, "generate_secret", args));
    assert.equal(err.code, -32602, JSON.stringify(args));
  }
  assert.equal(countOf(raw, "secrets"), 2);
});
