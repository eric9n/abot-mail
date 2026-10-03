/**
 * Local end-to-end coverage for every MCP tool.
 * Drives worker handleFetch with an in-memory D1 (node:sqlite + schema.sql)
 * and an in-memory R2. No network and no production deploy.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildInsertQuery, handleFetch, mapEmailForStorage } from "../worker/worker.js";

const MCP_TOKEN = "e2e-mcp-token";
const INTERNAL_TOKEN = "e2e-internal-token";
const RESEND_API_KEY = "e2e-resend-key";
const ALICE = "alice@abot.run";
const BOB = "bob@abot.run";
const WILD = "a_b@abot.run";
const WILD_OTHER = "axb@abot.run";

const ALICE_IN = "alice-in-001";
const ALICE_OUT = "alice-out-001";
const BOB_IN = "bob-in-001";
const ATTACH_ID = "alice-attach-001";
const ATTACH_NAME = "a b.png";
const ATTACH_KEY = `attachments/${ATTACH_ID}/a_b.png`;
const ATTACH_BYTES = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x41, 0x0a]);

function schemaSql() {
  return readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");
}

function seedEmail(db, { id, direction, from, to, subject, text, html = null, attachments = [], date }) {
  const row = mapEmailForStorage(
    {
      id,
      from,
      to,
      subject,
      text,
      html,
      message_id: `<${id}@e2e.test>`,
      created_at: date,
    },
    { direction, eventCreatedAt: date, attachments, nowMs: Date.parse(date) },
  );
  const query = buildInsertQuery(row);
  db.prepare(query.sql).run(...query.params);
}

function rowOf(db, id) {
  return db.prepare(
    "SELECT resend_id, is_read, is_archived, deleted_at, msg_from, msg_to, text_body FROM emails WHERE resend_id = ?",
  ).get(id);
}

function makeEnv(db, bucket) {
  return {
    WEBHOOK_SECRET: "whsec_e2e",
    RESEND_API_KEY,
    MCP_TOKEN,
    INTERNAL_TOKEN,
    DB: {
      prepare(sql) {
        const make = (params) => ({
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          first: async () => db.prepare(sql).get(...params) ?? null,
          run: async () => {
            const info = db.prepare(sql).run(...params);
            return { success: true, meta: { changes: info.changes } };
          },
        });
        return { ...make([]), bind: (...params) => make(params) };
      },
    },
    ARCHIVE_BUCKET: {
      async get(key) {
        const hit = bucket.get(key);
        if (!hit) return null;
        const copy = Uint8Array.from(hit);
        return {
          async text() {
            return new TextDecoder().decode(copy);
          },
          async arrayBuffer() {
            return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
          },
        };
      },
    },
  };
}

function setup({ withAttachment = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql());
  const bucket = new Map();
  const now = new Date().toISOString();
  seedEmail(db, {
    id: ALICE_IN,
    direction: "in",
    from: "vendor@example.com",
    to: [ALICE],
    subject: "Alice invoice",
    text: "alice secret body",
    html: "<p>alice secret</p>",
    date: now,
  });
  seedEmail(db, {
    id: ALICE_OUT,
    direction: "out",
    from: ALICE,
    to: ["outsider@example.com"],
    subject: "Alice outbound",
    text: "alice outbound body",
    date: now,
  });
  seedEmail(db, {
    id: BOB_IN,
    direction: "in",
    from: "vendor@example.com",
    to: [BOB],
    subject: "Bob invoice",
    text: "bob secret body",
    date: now,
  });
  if (withAttachment) {
    seedEmail(db, {
      id: ATTACH_ID,
      direction: "in",
      from: "files@example.com",
      to: [ALICE],
      subject: "Alice file",
      text: "see attachment",
      date: now,
      attachments: [
        {
          filename: ATTACH_NAME,
          content_type: "image/png",
          size: ATTACH_BYTES.byteLength,
          r2_key: ATTACH_KEY,
        },
      ],
    });
    bucket.set(ATTACH_KEY, ATTACH_BYTES);
  }
  const env = makeEnv(db, bucket);
  return { db, bucket, env, call: (owner, name, args, deps) => callTool(env, owner, name, args, deps) };
}

function mcpRequest({ token, internal, owner, message }) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (internal) headers["x-internal-token"] = internal;
  if (owner) headers["x-abot-owner-email"] = owner;
  return new Request("https://mail.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
}

async function postMcp(env, request, deps) {
  const res = await handleFetch(request, env, deps);
  const json = await res.json();
  return { status: res.status, json };
}

async function callTool(env, owner, name, args, deps) {
  return postMcp(
    env,
    mcpRequest({
      internal: INTERNAL_TOKEN,
      owner,
      message: { jsonrpc: "2.0", id: "e2e", method: "tools/call", params: { name, arguments: args } },
    }),
    deps,
  );
}

function payload(http) {
  assert.equal(http.status, 200, JSON.stringify(http.json));
  assert.equal(http.json.error, undefined, JSON.stringify(http.json.error));
  const text = http.json.result && http.json.result.content && http.json.result.content[0] && http.json.result.content[0].text;
  assert.equal(typeof text, "string", JSON.stringify(http.json));
  const parsed = JSON.parse(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    assert.equal(parsed.content, undefined, `tool result wrapped twice: ${text}`);
  }
  return parsed;
}

function rpcError(http) {
  assert.equal(http.status, 200, JSON.stringify(http.json));
  assert.ok(http.json.error, JSON.stringify(http.json));
  return http.json.error;
}

test("tools/list exposes every mail tool", async () => {
  const { env } = setup();
  const http = await postMcp(
    env,
    mcpRequest({
      internal: INTERNAL_TOKEN,
      owner: ALICE,
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }),
  );
  assert.equal(http.status, 200);
  const names = http.json.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "search_emails",
    "get_email",
    "list_emails",
    "email_stats",
    "get_account",
    "send_email",
    "set_email_read_status",
    "delete_email",
    "set_email_archived_status",
    "list_attachments",
    "get_attachment",
  ]);
});

test("service binding calls omit X-Internal-Token and still isolate owners", async () => {
  const { env } = setup();
  const http = await postMcp(
    env,
    mcpRequest({
      owner: ALICE,
      message: {
        jsonrpc: "2.0",
        id: "binding",
        method: "tools/call",
        params: { name: "search_emails", arguments: { query: "invoice", fresh: true } },
      },
    }),
  );
  const rows = payload(http);
  assert.deepEqual(rows.map((row) => row.resend_id), [ALICE_IN]);
  assert.equal(JSON.stringify(rows).includes("bob secret"), false);
});

test("search_emails returns only this owner's metadata", async () => {
  const { call } = setup();
  const rows = payload(await call(ALICE, "search_emails", { query: "invoice", fresh: true }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resend_id, ALICE_IN);
  assert.equal(rows[0].subject, "Alice invoice");
  assert.equal(rows[0].has_text, true);
  assert.equal("text_body" in rows[0], false);
  assert.equal(JSON.stringify(rows).includes("bob secret"), false);
  assert.equal(JSON.stringify(rows).includes("alice secret body"), false);
});

test("get_email returns the body and html only when asked", async () => {
  const { call } = setup();
  const plain = payload(await call(ALICE, "get_email", { resend_id: ALICE_IN, fresh: true }));
  assert.equal(plain.found, true);
  assert.equal(plain.text_body, "alice secret body");
  assert.equal("html_body" in plain, false);

  const html = payload(await call(ALICE, "get_email", { resend_id: ALICE_IN, include_html: true, fresh: true }));
  assert.equal(html.html_body, "<p>alice secret</p>");
});

test("list_emails is newest-first metadata for this owner", async () => {
  const { call } = setup();
  const rows = payload(await call(ALICE, "list_emails", { fresh: true }));
  const ids = rows.map((row) => row.resend_id);
  assert.deepEqual(ids.sort(), [ALICE_IN, ALICE_OUT].sort());
  assert.equal(ids.includes(BOB_IN), false);
  assert.equal("text_body" in rows[0], false);

  const inbound = payload(await call(ALICE, "list_emails", { direction: "in", fresh: true }));
  assert.deepEqual(inbound.map((row) => row.resend_id), [ALICE_IN]);
});

test("get_account returns only the bound owner", async () => {
  const { call } = setup();
  const alice = payload(await call(ALICE, "get_account", {}));
  assert.deepEqual(alice, { email: ALICE, domain: "abot.run" });
  assert.equal(JSON.stringify(alice).includes(BOB), false);
  assert.equal(JSON.stringify(alice).includes("bob secret"), false);
  assert.equal(JSON.stringify(alice).includes(BOB_IN), false);

  const bob = payload(await call(BOB, "get_account", {}));
  assert.deepEqual(bob, { email: BOB, domain: "abot.run" });
  assert.equal(JSON.stringify(bob).includes(ALICE), false);
  assert.equal(JSON.stringify(bob).includes("alice secret"), false);
  assert.equal(JSON.stringify(bob).includes(ALICE_IN), false);
});

test("email_stats counts only this owner's mail", async () => {
  const { call } = setup();
  const stats = payload(await call(ALICE, "email_stats", { fresh: true }));
  assert.equal(stats.total, 2);
  assert.equal(stats.by_direction.in, 1);
  assert.equal(stats.by_direction.out, 1);
  assert.ok(Array.isArray(stats.by_day));
  assert.ok(Array.isArray(stats.top_senders));
  assert.equal(stats.top_senders.some((row) => row.from === "vendor@example.com"), true);

  const bob = payload(await call(BOB, "email_stats", { fresh: true }));
  assert.equal(bob.total, 1);
  assert.equal(bob.by_direction.in, 1);
  assert.equal(bob.by_direction.out, 0);
});

test("send_email sends as the bound mailbox and rejects spoofing", async () => {
  const { env, call } = setup();
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "re_sent_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const sent = payload(await call(ALICE, "send_email", {
      to: "bob@example.com",
      subject: "hello",
      body: "body text",
    }, { fetch: globalThis.fetch }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.from, ALICE);
    assert.equal(body.to, "bob@example.com");
    assert.equal(body.subject, "hello");
    assert.equal(body.text, "body text");
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${RESEND_API_KEY}`);
    assert.equal(sent.id, "re_sent_1");
    assert.equal(sent.from, ALICE);

    calls.length = 0;
    const spoof = await call(ALICE, "send_email", {
      to: "bob@example.com",
      subject: "x",
      body: "y",
      from: BOB,
    });
    const err = rpcError(spoof);
    assert.equal(err.code, -32602);
    assert.equal(calls.length, 0);

    const unbound = await postMcp(
      env,
      mcpRequest({
        message: {
          jsonrpc: "2.0",
          id: "e2e",
          method: "tools/call",
          params: { name: "send_email", arguments: { to: "a@b.c", subject: "s", body: "b" } },
        },
      }),
    );
    assert.equal(unbound.status, 401);
    assert.equal(unbound.json.error, "x-abot-owner-email required");
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = prev;
  }
});

test("set_email_read_status persists read and unread in the database", async () => {
  const { db, call } = setup();
  assert.equal(rowOf(db, ALICE_IN).is_read, 0);

  const read = payload(await call(ALICE, "set_email_read_status", { resend_id: ALICE_IN, is_read: true }));
  assert.equal(read.resend_id, ALICE_IN);
  assert.equal(read.is_read, true);
  assert.equal(rowOf(db, ALICE_IN).is_read, 1);

  const unread = payload(await call(ALICE, "set_email_read_status", { resend_id: ALICE_IN, is_read: false }));
  assert.equal(unread.is_read, false);
  assert.equal(rowOf(db, ALICE_IN).is_read, 0);

  const still = payload(await call(ALICE, "get_email", { resend_id: ALICE_IN, fresh: true }));
  assert.equal(still.found, true);
  assert.equal(still.text_body, "alice secret body");
});

test("delete_email soft-deletes the row and hides it from reads", async () => {
  const { db, call } = setup();
  const deleted = payload(await call(ALICE, "delete_email", { resend_id: ALICE_IN }));
  assert.equal(deleted.deleted, true);
  const row = rowOf(db, ALICE_IN);
  assert.ok(row.deleted_at != null);

  const got = payload(await call(ALICE, "get_email", { resend_id: ALICE_IN, fresh: true }));
  assert.equal(got.found, false);
  const listed = payload(await call(ALICE, "list_emails", { fresh: true }));
  assert.equal(listed.some((item) => item.resend_id === ALICE_IN), false);
  const found = payload(await call(ALICE, "search_emails", { query: "Alice invoice", fresh: true }));
  assert.equal(found.length, 0);
  const stats = payload(await call(ALICE, "email_stats", { fresh: true }));
  assert.equal(stats.total, 1);

  const again = rpcError(await call(ALICE, "set_email_read_status", { resend_id: ALICE_IN, is_read: true }));
  assert.equal(again.code, -32602);
  assert.equal(rowOf(db, ALICE_IN).is_read, 0);
});

test("archive hides mail from default queries and unarchive restores it", async () => {
  const { db, call } = setup();
  const archived = payload(await call(ALICE, "set_email_archived_status", { resend_id: ALICE_IN, is_archived: true }));
  assert.equal(archived.is_archived, true);
  assert.equal(rowOf(db, ALICE_IN).is_archived, 1);

  const listed = payload(await call(ALICE, "list_emails", { fresh: true }));
  assert.equal(listed.some((item) => item.resend_id === ALICE_IN), false);
  const found = payload(await call(ALICE, "search_emails", { query: "invoice", fresh: true }));
  assert.equal(found.some((item) => item.resend_id === ALICE_IN), false);

  const included = payload(await call(ALICE, "list_emails", { include_archived: true, fresh: true }));
  assert.equal(included.some((item) => item.resend_id === ALICE_IN), true);
  const onlyArchived = payload(await call(ALICE, "search_emails", { query: "invoice", is_archived: true, fresh: true }));
  assert.deepEqual(onlyArchived.map((item) => item.resend_id), [ALICE_IN]);

  const restored = payload(await call(ALICE, "set_email_archived_status", { resend_id: ALICE_IN, is_archived: false }));
  assert.equal(restored.is_archived, false);
  assert.equal(rowOf(db, ALICE_IN).is_archived, 0);
  const back = payload(await call(ALICE, "list_emails", { fresh: true }));
  assert.equal(back.some((item) => item.resend_id === ALICE_IN), true);
});

test("list_attachments and get_attachment return the stored bytes as base64", async () => {
  const { call } = setup({ withAttachment: true });
  const listed = payload(await call(ALICE, "list_attachments", { resend_id: ATTACH_ID }));
  assert.equal(listed.resend_id, ATTACH_ID);
  assert.equal(listed.attachments.length, 1);
  assert.equal(listed.attachments[0].filename, ATTACH_NAME);
  assert.equal(listed.attachments[0].content_type, "image/png");
  assert.equal(listed.attachments[0].size, ATTACH_BYTES.byteLength);
  assert.equal(listed.attachments[0].r2_key, undefined);

  const file = payload(await call(ALICE, "get_attachment", { resend_id: ATTACH_ID, filename: ATTACH_NAME }));
  assert.equal(file.filename, ATTACH_NAME);
  const decoded = Buffer.from(file.content_base64, "base64");
  assert.deepEqual(Uint8Array.from(decoded), ATTACH_BYTES);

  const missing = rpcError(await call(ALICE, "get_attachment", { resend_id: ATTACH_ID, filename: "nope.bin" }));
  assert.equal(missing.code, -32602);
});

test("two owners cannot read or modify each other's mail", async () => {
  const { db, call } = setup({ withAttachment: true });
  const before = rowOf(db, ALICE_IN);

  const got = payload(await call(BOB, "get_email", { resend_id: ALICE_IN, include_html: true, fresh: true }));
  assert.equal(got.found, false);
  assert.equal(JSON.stringify(got).includes("alice secret"), false);

  const searched = payload(await call(BOB, "search_emails", { query: "Alice", fresh: true }));
  assert.deepEqual(searched, []);
  const listed = payload(await call(BOB, "list_emails", { include_archived: true, fresh: true }));
  assert.equal(listed.some((item) => item.resend_id === ALICE_IN || item.resend_id === ATTACH_ID), false);

  for (const callArgs of [
    ["set_email_read_status", { resend_id: ALICE_IN, is_read: true }],
    ["set_email_archived_status", { resend_id: ALICE_IN, is_archived: true }],
    ["delete_email", { resend_id: ALICE_IN }],
  ]) {
    const err = rpcError(await call(BOB, callArgs[0], callArgs[1]));
    assert.equal(err.code, -32602, callArgs[0]);
  }
  const after = rowOf(db, ALICE_IN);
  assert.equal(after.is_read, before.is_read);
  assert.equal(after.is_archived, before.is_archived);
  assert.equal(after.deleted_at, before.deleted_at);
  assert.equal(after.text_body, "alice secret body");

  const files = rpcError(await call(BOB, "list_attachments", { resend_id: ATTACH_ID }));
  assert.equal(files.code, -32602);
  const download = rpcError(await call(BOB, "get_attachment", { resend_id: ATTACH_ID, filename: ATTACH_NAME }));
  assert.equal(download.code, -32602);
  assert.equal(JSON.stringify(download).includes(Buffer.from(ATTACH_BYTES).toString("base64")), false);

  const own = payload(await call(ALICE, "get_email", { resend_id: ALICE_IN, fresh: true }));
  assert.equal(own.found, true);
  assert.equal(own.text_body, "alice secret body");
});

test("owner match treats underscore as a literal, not a wildcard", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql());
  const now = new Date().toISOString();
  seedEmail(db, {
    id: "wild-victim",
    direction: "in",
    from: "spy@example.com",
    to: [WILD_OTHER],
    subject: "wild victim",
    text: "wild victim secret",
    date: now,
  });
  seedEmail(db, {
    id: "wild-mine",
    direction: "in",
    from: "spy@example.com",
    to: [WILD],
    subject: "wild mine",
    text: "wild mine body",
    date: now,
  });
  const env = makeEnv(db, new Map());
  const call = (owner, name, args) => callTool(env, owner, name, args);

  const leaked = payload(await call(WILD, "get_email", { resend_id: "wild-victim", fresh: true }));
  assert.equal(leaked.found, false);
  assert.equal(JSON.stringify(leaked).includes("wild victim secret"), false);

  const mine = payload(await call(WILD, "get_email", { resend_id: "wild-mine", fresh: true }));
  assert.equal(mine.found, true);
  assert.equal(mine.text_body, "wild mine body");

  const stats = payload(await call(WILD, "email_stats", { fresh: true }));
  assert.equal(stats.total, 1);

  const searched = payload(await call(WILD, "search_emails", { query: "wild", fresh: true }));
  assert.deepEqual(searched.map((row) => row.resend_id), ["wild-mine"]);

  const err = rpcError(await call(WILD, "delete_email", { resend_id: "wild-victim" }));
  assert.equal(err.code, -32602);
  assert.equal(rowOf(db, "wild-victim").deleted_at, null);
  assert.equal(rowOf(db, "wild-victim").text_body, "wild victim secret");
});

test("queries still work when mailbox columns were added after the table existed", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE emails (
      resend_id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      msg_from TEXT,
      msg_to TEXT,
      cc TEXT,
      subject TEXT,
      date TEXT,
      text_body TEXT,
      html_body TEXT,
      message_id TEXT,
      auth TEXT,
      attachments TEXT,
      summary TEXT,
      created_at TEXT
    );
    CREATE TABLE cache_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rev INTEGER NOT NULL
    );
    INSERT INTO cache_revision (id, rev) VALUES (1, 0);
  `);
  const now = new Date().toISOString();
  seedEmail(db, {
    id: ALICE_IN,
    direction: "in",
    from: "vendor@example.com",
    to: [ALICE],
    subject: "legacy inbox",
    text: "legacy body",
    date: now,
  });
  const env = makeEnv(db, new Map());
  const listed = payload(await callTool(env, ALICE, "list_emails", { fresh: true }));
  assert.deepEqual(listed.map((row) => row.resend_id), [ALICE_IN]);
  const columns = db.prepare("SELECT name FROM pragma_table_info('emails')").all().map((row) => row.name);
  assert.equal(columns.includes("is_read"), true);
  assert.equal(columns.includes("deleted_at"), true);
  assert.equal(columns.includes("is_archived"), true);
  assert.equal(rowOf(db, ALICE_IN).is_read, 0);
});

test("unauthorized mcp requests return 401 before touching the database", async () => {
  const env = {
    MCP_TOKEN,
    INTERNAL_TOKEN,
    DB: {
      prepare() {
        throw new Error("database was touched");
      },
    },
  };
  const cases = [
    mcpRequest({ message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }),
    mcpRequest({ token: "wrong-token", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }),
    mcpRequest({
      token: "wrong-token",
      owner: "not-an-email",
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }),
    mcpRequest({
      owner: "not-an-email",
      message: { jsonrpc: "2.0", id: 1, method: "initialize" },
    }),
    mcpRequest({
      internal: INTERNAL_TOKEN,
      message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }),
  ];
  for (const request of cases) {
    const http = await postMcp(env, request);
    assert.equal(http.status, 401, JSON.stringify(http.json));
    assert.equal(http.json.ok, false);
    assert.equal(http.json.result, undefined);
  }
});
