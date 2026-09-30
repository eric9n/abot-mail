import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHmac } from "node:crypto";

import worker, {
  TOOLS,
  buildWebhookBody,
  canonicalUrl,
  consumeDelivery,
  handleFetch,
  handleMcpRpc,
  handleQueue,
  handleScheduled,
  idFromBytes,
  signWebhook,
  stableStringify,
  timingSafeEqual,
  verifyWebhookRequest,
} from "./worker.js";

const TOKEN = "test-data-token";
const NOW = Date.parse("2026-09-29T04:00:00.000Z");
const NOW_ISO = "2026-09-29T04:00:00.000Z";
const LATER = Date.parse("2026-09-29T05:00:00.000Z");
const LATER_ISO = "2026-09-29T05:00:00.000Z";

const PHASE1_TOOL_NAMES = [
  "create_contact",
  "get_contact",
  "list_contacts",
  "update_contact",
  "delete_contact",
  "create_event",
  "get_event",
  "list_events",
  "update_event",
  "delete_event",
  "create_note",
  "get_note",
  "list_notes",
  "update_note",
  "delete_note",
];
const PHASE2_TOOL_NAMES = [
  "poll_events",
  "ack_event",
  "heartbeat",
  "emit_event",
  "create_subscription",
  "get_subscription",
  "list_subscriptions",
  "update_subscription",
  "delete_subscription",
  "rotate_subscription_secret",
];
const TOOL_NAMES = [...PHASE1_TOOL_NAMES, ...PHASE2_TOOL_NAMES];
const SEAL = Buffer.alloc(32, 7).toString("base64");

function schemaSql() {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql());
  const sent = [];
  const env = {
    DATA_MCP_TOKEN: TOKEN,
    SUBSCRIPTION_SEAL: SEAL,
    DELIVER_QUEUE: {
      sent,
      async send(body) {
        sent.push(body);
      },
    },
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
      async batch(statements) {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        return results;
      },
    },
  };
  return { db, env, sent };
}

async function mcp(env, name, args, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token === undefined ? TOKEN : opts.token}`;
  const res = await handleFetch(
    new Request(opts.url ?? "https://botu-data.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: opts.id ?? 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    { nowMs: opts.nowMs ?? NOW },
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

test("idFromBytes uses the alphabet and skips biased bytes", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  const bytes = Uint8Array.from([252, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(idFromBytes("ctc_", bytes), "ctc_abcdefghijkl");
  assert.equal(idFromBytes("cal_", bytes), "cal_abcdefghijkl");
  assert.equal(idFromBytes("note_", bytes), "note_abcdefghijkl");
  assert.equal(canonicalUrl("https://bot.example", "cal_abcdefghijkl"), "https://bot.example/cal/cal_abcdefghijkl");
  assert.equal(canonicalUrl("https://bot.example/", "ctc_abcdefghijkl"), "https://bot.example/ctc/ctc_abcdefghijkl");
  assert.equal(canonicalUrl("https://bot.example", "note_abcdefghijkl"), "https://bot.example/note/note_abcdefghijkl");
  assert.throws(() => idFromBytes("nope_", bytes), /bad id prefix/);
  assert.throws(() => idFromBytes("ctc_", Uint8Array.from([252, 253, 254, 255])), /not enough entropy/);
});

test("schema.sql applies twice without dropping rows", () => {
  const sql = schemaSql();
  assert.equal(/drop\s+table/i.test(sql), false);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS contacts/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS calendar_events/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS notes/);
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.exec(sql);
  db.prepare(
    `INSERT INTO contacts (id, name, created_at, updated_at) VALUES ('ctc_abcdefghijkl', 'Ada', ?, ?)`,
  ).run(NOW_ISO, NOW_ISO);
  db.prepare(
    `INSERT INTO calendar_events (id, title, start_utc, end_utc, created_at, updated_at)
     VALUES ('cal_abcdefghijkl', 'a', '2026-09-29T06:00:00.000Z', '2026-09-29T07:00:00.000Z', ?, ?)`,
  ).run(NOW_ISO, NOW_ISO);
  db.prepare(
    `INSERT INTO calendar_events (id, title, start_utc, end_utc, created_at, updated_at)
     VALUES ('cal_bbcdefghijkl', 'b', '2026-09-29T08:00:00.000Z', '2026-09-29T09:00:00.000Z', ?, ?)`,
  ).run(NOW_ISO, NOW_ISO);
  db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get().n, 2);
  assert.equal(db.prepare("SELECT name FROM contacts").get().name, "Ada");
  db.prepare("UPDATE calendar_events SET google_event_id = 'g1' WHERE id = 'cal_abcdefghijkl'").run();
  assert.throws(
    () => db.prepare("UPDATE calendar_events SET google_event_id = 'g1' WHERE id = 'cal_bbcdefghijkl'").run(),
    /UNIQUE/,
  );
  const columns = db.prepare("SELECT name FROM pragma_table_info('contacts')").all().map((row) => row.name);
  assert.deepEqual(columns, [
    "id",
    "name",
    "aliases",
    "org",
    "title",
    "email",
    "phone",
    "relation",
    "notes",
    "source",
    "created_by",
    "created_at",
    "updated_at",
  ]);
});

test("wrangler config is staging-only and does not name the mail archive", () => {
  const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8");
  assert.match(toml, /name = "botu-data-unconfigured"/);
  assert.match(toml, /\[env\.staging\][\s\S]*\nname = "botu-data"\n/);
  assert.match(toml, /database_name = "botu-data"/);
  assert.match(toml, /\[env\.staging\]/);
  assert.match(toml, /DATA_MCP_TOKEN/);
  assert.match(toml, /\[env\.staging\.triggers\]\ncrons = \["\*\/5 \* \* \* \*"\]/);
  assert.match(toml, /binding = "DELIVER_QUEUE"/);
  assert.match(toml, /queue = "botu-deliver"\n/);
  assert.match(toml, /dead_letter_queue = "botu-deliver-dlq"/);
  assert.match(toml, /queue = "botu-deliver-dlq"/);
  assert.equal(toml.includes("[env.production]"), false);
  assert.equal(toml.includes("779058bf-f5c1-44de-b2c8-99350ec7748e"), false);
  assert.equal(/database_name\s*=\s*"abot-mail/.test(toml), false);
  assert.equal(/bucket_name\s*=\s*"abot-mail/.test(toml), false);
  assert.equal(toml.includes("mail-ingest"), false);
  assert.equal(toml.includes("WEBHOOK_SECRET"), false);
  assert.equal(toml.includes("RESEND"), false);
  assert.equal(src.includes("779058bf"), false);
  assert.equal(src.includes("WEBHOOK_SECRET"), false);
  assert.equal(src.includes("RESEND_API_KEY"), false);
  assert.equal(src.includes("ARCHIVE_BUCKET"), false);
  assert.equal(src.includes("INGEST_QUEUE"), false);
  assert.match(src, /env\.DATA_MCP_TOKEN/);
  assert.equal(src.includes("env.MCP_TOKEN"), false);
});

test("health is public and MCP auth fails before the database", async () => {
  const { env } = sqliteEnv();
  const health = await worker.fetch(new Request("https://botu-data.test/health"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const healthPost = await handleFetch(new Request("https://botu-data.test/health", { method: "POST" }), env);
  assert.equal(healthPost.status, 405);

  let touched = false;
  const closed = {
    DATA_MCP_TOKEN: TOKEN,
    DB: {
      prepare() {
        touched = true;
        throw new Error("db touched");
      },
    },
  };
  const missing = await handleFetch(
    new Request("https://botu-data.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    closed,
  );
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, error: "unauthorized" });

  const wrong = await handleFetch(
    new Request("https://botu-data.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    closed,
  );
  assert.equal(wrong.status, 401);
  assert.equal(touched, false);

  const down = await handleFetch(new Request("https://botu-data.test/health"), closed);
  assert.equal(down.status, 503);
  assert.equal(JSON.stringify(await down.json()).includes("db touched"), false);
});

test("tools/list keeps the fifteen phase 1 tools then the ten phase 2 tools", async () => {
  const { env } = sqliteEnv();
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    TOOL_NAMES,
  );
  const res = await handleFetch(
    new Request("https://botu-data.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
    { nowMs: NOW },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.result.tools.map((tool) => tool.name),
    TOOL_NAMES,
  );
  for (const tool of body.result.tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  const init = await handleMcpRpc({ jsonrpc: "2.0", id: 7, method: "initialize" }, {});
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "botu-data-mcp");

  const note = await handleFetch(
    new Request("https://botu-data.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
    env,
  );
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");
});

test("contact tools create, read, list, update, and hard-delete", async () => {
  const { db, env } = sqliteEnv();
  const created = unwrap(
    await mcp(env, "create_contact", {
      name: "100% Ada",
      aliases: ["艾达", "a_b"],
      org: "Analytical",
      title: "Mathematician",
      email: "ada@example.com",
      phone: "+1",
      relation: "friend",
      notes: "first note",
      created_by: "bot:main",
    }),
  );
  assert.match(created.id, /^ctc_[a-z0-9]{12}$/);
  assert.equal(created.url, `https://botu-data.test/ctc/${created.id}`);
  assert.deepEqual(Object.keys(created).sort(), ["id", "url"]);

  const got = unwrap(await mcp(env, "get_contact", { id: created.id }));
  assert.equal(got.found, true);
  assert.equal(got.url, created.url);
  assert.equal(got.name, "100% Ada");
  assert.deepEqual(got.aliases, ["艾达", "a_b"]);
  assert.equal(got.org, "Analytical");
  assert.equal(got.source, "manual");
  assert.equal(got.created_by, "bot:main");
  assert.equal(got.created_at, NOW_ISO);
  assert.equal(got.updated_at, NOW_ISO);

  const byAlias = unwrap(await mcp(env, "list_contacts", { query: "艾达" }));
  assert.equal(byAlias.length, 1);
  assert.equal(byAlias[0].id, created.id);
  assert.equal(byAlias[0].url, created.url);
  const byOrg = unwrap(await mcp(env, "list_contacts", { query: "Analytical" }));
  assert.equal(byOrg.length, 1);
  const byPercent = unwrap(await mcp(env, "list_contacts", { query: "%" }));
  assert.deepEqual(
    byPercent.map((row) => row.id),
    [created.id],
  );
  const byUnderscore = unwrap(await mcp(env, "list_contacts", { query: "_" }));
  assert.equal(byUnderscore.length, 1);
  const none = unwrap(await mcp(env, "list_contacts", { query: "nope" }));
  assert.deepEqual(none, []);

  const updated = unwrap(
    await mcp(env, "update_contact", { id: created.id, org: "Babbage", title: null }, { nowMs: LATER }),
  );
  assert.equal(updated.url, created.url);
  assert.equal(updated.org, "Babbage");
  assert.equal(updated.title, null);
  assert.equal(updated.name, "100% Ada");
  assert.equal(updated.created_at, NOW_ISO);
  assert.equal(updated.updated_at, LATER_ISO);
  assert.equal(updated.created_by, "bot:main");

  const removed = unwrap(await mcp(env, "delete_contact", { id: created.id }));
  assert.deepEqual(removed, { id: created.id, deleted: true });
  const missing = unwrap(await mcp(env, "get_contact", { id: created.id }));
  assert.deepEqual(missing, { found: false, id: created.id });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 0);

  const poison = unwrap(await mcp(env, "create_contact", { name: "'; DROP TABLE contacts; --" }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 1);
  assert.equal(db.prepare("SELECT name FROM contacts WHERE id = ?").get(poison.id).name, "'; DROP TABLE contacts; --");
  unwrap(await mcp(env, "delete_contact", { id: poison.id }));

  const again = rpcError(await mcp(env, "delete_contact", { id: created.id }));
  assert.equal(again.code, -32602);
  assert.equal(again.message, "not found");
});

test("event tools create, list by overlap, update, and cancel in place", async () => {
  const { db, env } = sqliteEnv();
  const meeting = unwrap(
    await mcp(env, "create_event", {
      title: "standup",
      start_utc: "2026-09-29T06:00:00Z",
      end_utc: "2026-09-29T07:00:00+00:00",
      all_day: false,
      repeat: { freq: "weekly", interval: 1 },
      attendee_ids: ["ctc_notyetexist"],
      reminder_minutes: [10, 0],
      location: "room",
      notes: "bring notes",
      created_by: "human",
    }),
  );
  assert.match(meeting.id, /^cal_[a-z0-9]{12}$/);
  assert.equal(meeting.url, `https://botu-data.test/cal/${meeting.id}`);
  const later = unwrap(
    await mcp(env, "create_event", {
      title: "tomorrow",
      start_utc: "2026-09-30T06:00:00Z",
      end_utc: "2026-09-30T07:00:00Z",
      repeat: '{"freq":"daily"}',
    }),
  );

  const got = unwrap(await mcp(env, "get_event", { id: meeting.id }));
  assert.equal(got.found, true);
  assert.equal(got.url, meeting.url);
  assert.equal(got.title, "standup");
  assert.equal(got.start_utc, "2026-09-29T06:00:00.000Z");
  assert.equal(got.end_utc, "2026-09-29T07:00:00.000Z");
  assert.equal(got.timezone, "Asia/Shanghai");
  assert.equal(got.all_day, false);
  assert.deepEqual(got.repeat, { freq: "weekly", interval: 1 });
  assert.deepEqual(got.attendee_ids, ["ctc_notyetexist"]);
  assert.deepEqual(got.reminder_minutes, [10, 0]);
  assert.equal(got.status, "confirmed");
  assert.equal(got.source, "bot");
  assert.equal(got.google_event_id, null);
  assert.equal(got.created_by, "human");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 0);

  const window = unwrap(
    await mcp(env, "list_events", {
      start_utc: "2026-09-29T00:00:00Z",
      end_utc: "2026-09-30T00:00:00Z",
    }),
  );
  assert.deepEqual(
    window.map((row) => row.id),
    [meeting.id],
  );
  assert.equal(window[0].url, meeting.url);

  const updated = unwrap(
    await mcp(
      env,
      "update_event",
      { id: meeting.id, title: "standup moved", all_day: true, location: null },
      { nowMs: LATER },
    ),
  );
  assert.equal(updated.url, meeting.url);
  assert.equal(updated.title, "standup moved");
  assert.equal(updated.all_day, true);
  assert.equal(updated.location, null);
  assert.equal(updated.created_at, NOW_ISO);
  assert.equal(updated.updated_at, LATER_ISO);
  assert.equal(updated.notes, "bring notes");

  const cancelled = unwrap(await mcp(env, "delete_event", { id: meeting.id }, { nowMs: LATER }));
  assert.deepEqual(cancelled, { id: meeting.id, status: "cancelled" });
  const again = unwrap(await mcp(env, "delete_event", { id: meeting.id }, { nowMs: LATER }));
  assert.equal(again.status, "cancelled");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get().n, 2);

  const still = unwrap(await mcp(env, "get_event", { id: meeting.id }));
  assert.equal(still.found, true);
  assert.equal(still.url, meeting.url);
  assert.equal(still.status, "cancelled");
  const confirmed = unwrap(
    await mcp(env, "list_events", {
      start_utc: "2026-09-29T00:00:00Z",
      end_utc: "2026-09-30T00:00:00Z",
      status: "confirmed",
    }),
  );
  assert.deepEqual(confirmed, []);
  const cancelledList = unwrap(
    await mcp(env, "list_events", {
      start_utc: "2026-09-29T00:00:00Z",
      end_utc: "2026-09-30T00:00:00Z",
      status: "cancelled",
    }),
  );
  assert.equal(cancelledList.length, 1);
  assert.equal(cancelledList[0].id, meeting.id);
  assert.equal(later.id.startsWith("cal_"), true);
});

test("note tools create, filter, update, and hard-delete", async () => {
  const { db, env } = sqliteEnv();
  const work = unwrap(
    await mcp(env, "create_note", {
      title: "plan",
      body: "ship botu",
      tags: ["work"],
      links: ["cal_abcdefghijkl"],
      created_by: "bot:main",
    }),
  );
  assert.match(work.id, /^note_[a-z0-9]{12}$/);
  assert.equal(work.url, `https://botu-data.test/note/${work.id}`);
  const home = unwrap(
    await mcp(env, "create_note", { title: "grocery", body: "milk", tags: ["home"] }, { nowMs: LATER }),
  );
  const empty = unwrap(await mcp(env, "create_note", {}));
  assert.match(empty.id, /^note_[a-z0-9]{12}$/);

  const got = unwrap(await mcp(env, "get_note", { id: work.id }));
  assert.equal(got.found, true);
  assert.equal(got.url, work.url);
  assert.equal(got.title, "plan");
  assert.equal(got.body, "ship botu");
  assert.deepEqual(got.tags, ["work"]);
  assert.deepEqual(got.links, ["cal_abcdefghijkl"]);
  assert.equal(got.source, "manual");
  assert.equal(got.created_by, "bot:main");
  assert.equal(got.created_at, NOW_ISO);

  const byText = unwrap(await mcp(env, "list_notes", { query: "groc" }));
  assert.deepEqual(
    byText.map((row) => row.id),
    [home.id],
  );
  assert.equal(byText[0].url, home.url);
  const byTag = unwrap(await mcp(env, "list_notes", { tag: "work" }));
  assert.deepEqual(
    byTag.map((row) => row.id),
    [work.id],
  );
  const prefix = unwrap(await mcp(env, "list_notes", { tag: "wor" }));
  assert.deepEqual(prefix, []);
  const injection = unwrap(await mcp(env, "list_notes", { tag: 'work" OR "1' }));
  assert.deepEqual(injection, []);

  const recent = unwrap(await mcp(env, "list_notes", { limit: 2 }));
  assert.equal(recent.length, 2);
  assert.equal(recent[0].id, home.id);

  const updated = unwrap(
    await mcp(env, "update_note", { id: work.id, body: "ship the data layer", tags: ["work", "v1"] }, { nowMs: LATER }),
  );
  assert.equal(updated.url, work.url);
  assert.equal(updated.body, "ship the data layer");
  assert.deepEqual(updated.tags, ["work", "v1"]);
  assert.equal(updated.title, "plan");
  assert.equal(updated.created_at, NOW_ISO);
  assert.equal(updated.updated_at, LATER_ISO);

  const removed = unwrap(await mcp(env, "delete_note", { id: work.id }));
  assert.deepEqual(removed, { id: work.id, deleted: true });
  assert.deepEqual(unwrap(await mcp(env, "get_note", { id: work.id })), { found: false, id: work.id });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE id = ?").get(work.id).n, 0);
  unwrap(await mcp(env, "delete_note", { id: home.id }));
  unwrap(await mcp(env, "delete_note", { id: empty.id }));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, 0);
});

test("rejects inverted times and illegal repeat without writing", async () => {
  const { db, env } = sqliteEnv();
  const start = "2026-09-29T06:00:00Z";
  const same = rpcError(
    await mcp(env, "create_event", { title: "x", start_utc: start, end_utc: "2026-09-29T06:00:00Z" }),
  );
  assert.equal(same.code, -32602);
  assert.match(same.message, /end_utc/);

  const earlier = rpcError(
    await mcp(env, "create_event", { title: "x", start_utc: start, end_utc: "2026-09-29T05:00:00Z" }),
  );
  assert.equal(earlier.code, -32602);
  assert.match(earlier.message, /end_utc/);

  const badJson = rpcError(
    await mcp(env, "create_event", {
      title: "x",
      start_utc: start,
      end_utc: "2026-09-29T07:00:00Z",
      repeat: "{freq:weekly}",
    }),
  );
  assert.equal(badJson.code, -32602);
  assert.match(badJson.message, /repeat/);
  assert.match(badJson.message, /JSON/);

  const badFreq = rpcError(
    await mcp(env, "create_event", {
      title: "x",
      start_utc: start,
      end_utc: "2026-09-29T07:00:00Z",
      repeat: { freq: "yearly" },
    }),
  );
  assert.equal(badFreq.code, -32602);
  assert.match(badFreq.message, /repeat/);

  const badShape = rpcError(
    await mcp(env, "create_event", {
      title: "x",
      start_utc: start,
      end_utc: "2026-09-29T07:00:00Z",
      repeat: "[]",
    }),
  );
  assert.equal(badShape.code, -32602);

  const window = rpcError(
    await mcp(env, "list_events", { start_utc: start, end_utc: start }),
  );
  assert.equal(window.code, -32602);
  assert.match(window.message, /end_utc/);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get().n, 0);

  const ok = unwrap(
    await mcp(env, "create_event", {
      title: "ok",
      start_utc: start,
      end_utc: "2026-09-29T07:00:00Z",
      repeat: '{"freq":"monthly"}',
    }),
  );
  const moved = rpcError(
    await mcp(env, "update_event", { id: ok.id, end_utc: "2026-09-29T06:00:00Z" }),
  );
  assert.match(moved.message, /end_utc/);
  const badRepeat = rpcError(await mcp(env, "update_event", { id: ok.id, repeat: "not-json" }));
  assert.match(badRepeat.message, /JSON/);
  const row = db.prepare("SELECT end_utc, repeat FROM calendar_events WHERE id = ?").get(ok.id);
  assert.equal(row.end_utc, "2026-09-29T07:00:00.000Z");
  assert.equal(row.repeat, '{"freq":"monthly"}');
});

test("canonical GET routes match get_* and reject a bad token before D1", async () => {
  const { db, env } = sqliteEnv();
  const contact = unwrap(
    await mcp(env, "create_contact", { name: "Ada" }, { url: "https://bot.example/mcp" }),
  );
  assert.equal(contact.url, `https://bot.example/ctc/${contact.id}`);
  const event = unwrap(
    await mcp(env, "create_event", {
      title: "sync",
      start_utc: "2026-09-29T06:00:00Z",
      end_utc: "2026-09-29T07:00:00Z",
    }),
  );
  const note = unwrap(await mcp(env, "create_note", { title: "pointer", body: "pass the url" }));

  async function read(url, token = TOKEN) {
    const headers = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const res = await handleFetch(new Request(url, { headers }), env);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const contactPage = await read(contact.url);
  assert.equal(contactPage.status, 200);
  assert.deepEqual(contactPage.body, unwrap(await mcp(env, "get_contact", { id: contact.id }, { url: "https://bot.example/mcp" })));

  const eventPage = await read(event.url);
  assert.equal(eventPage.status, 200);
  assert.equal(eventPage.body.url, event.url);
  assert.deepEqual(eventPage.body, unwrap(await mcp(env, "get_event", { id: event.id })));

  const notePage = await read(note.url);
  assert.equal(notePage.status, 200);
  assert.deepEqual(notePage.body, unwrap(await mcp(env, "get_note", { id: note.id })));

  unwrap(await mcp(env, "delete_event", { id: event.id }));
  const cancelled = await read(event.url);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.found, true);

  unwrap(await mcp(env, "delete_note", { id: note.id }));
  const gone = await read(note.url);
  assert.equal(gone.status, 404);
  assert.deepEqual(gone.body, { found: false, id: note.id });

  const missing = await read("https://botu-data.test/ctc/ctc_abcdefghijkl");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { found: false, id: "ctc_abcdefghijkl" });

  const wrongKind = await read(`https://botu-data.test/cal/${contact.id}`);
  assert.equal(wrongKind.status, 404);

  const badShape = await read("https://botu-data.test/note/nope");
  assert.equal(badShape.status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 1);

  let touched = false;
  const closed = {
    DATA_MCP_TOKEN: TOKEN,
    DB: {
      prepare() {
        touched = true;
        throw new Error("db touched");
      },
    },
  };
  const unauth = await handleFetch(new Request(contact.url), closed);
  assert.equal(unauth.status, 401);
  const wrong = await handleFetch(
    new Request(event.url, { headers: { authorization: "Bearer wrong-token" } }),
    closed,
  );
  assert.equal(wrong.status, 401);
  const badId = await handleFetch(
    new Request("https://botu-data.test/cal/not-an-id", { headers: { authorization: `Bearer ${TOKEN}` } }),
    closed,
  );
  assert.equal(badId.status, 404);
  assert.equal(touched, false);

  const posted = await handleFetch(
    new Request(note.url, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
    env,
  );
  assert.equal(posted.status, 405);
});

function countOf(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test("phase 2 schema appends four tables and reapplies without dropping rows", () => {
  const sql = schemaSql();
  assert.equal(/\balter\s+table\b/i.test(sql), false);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS events/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS subscriptions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS deliveries/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS heartbeats/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_open/);
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.exec(sql);
  db.prepare(
    `INSERT INTO contacts (id, name, created_at, updated_at) VALUES ('ctc_abcdefghijkl', 'Ada', ?, ?)`,
  ).run(NOW_ISO, NOW_ISO);
  db.prepare(
    `INSERT INTO events (
      id, type, payload, status, dedupe_key, created_at, not_before, source, updated_at
    ) VALUES ('evt_abcdefghijkl', 'reminder.medication', '{}', 'pending', 'reminder.medication:a:t', ?, ?, 'emit', ?)`,
  ).run(NOW_ISO, NOW_ISO, NOW_ISO);
  db.exec(sql);
  assert.equal(countOf(db, "contacts"), 1);
  assert.equal(countOf(db, "events"), 1);
  assert.equal(db.prepare("SELECT name FROM contacts").get().name, "Ada");
});

test("poll_events rejects a bad bearer before reading the body", async () => {
  let touched = false;
  const closed = {
    DATA_MCP_TOKEN: TOKEN,
    DB: {
      prepare() {
        touched = true;
        throw new Error("db touched");
      },
    },
  };
  const missing = await handleFetch(
    new Request("https://botu-data.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
    closed,
  );
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, error: "unauthorized" });
  const wrong = await handleFetch(
    new Request("https://botu-data.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "poll_events", arguments: { subscription_id: "sub_abcdefghijkl" } },
      }),
    }),
    closed,
  );
  assert.equal(wrong.status, 401);
  assert.equal(touched, false);
});

test("dedupe keeps one pending row until ack, then inserts a new id", async () => {
  const { db, env } = sqliteEnv();
  const sub = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }));
  const key = "reminder.medication:med:2026-09-30T00:00:00.000Z";
  const first = unwrap(
    await mcp(env, "emit_event", { type: "reminder.medication", dedupe_key: key, payload: { name: "药" } }),
  );
  assert.equal(first.created, true);
  assert.match(first.id, /^evt_[a-z0-9]{12}$/);
  const second = unwrap(
    await mcp(env, "emit_event", { type: "reminder.medication", dedupe_key: key, payload: { name: "changed" } }),
  );
  assert.deepEqual(second, { id: first.id, created: false });
  assert.equal(countOf(db, "events"), 1);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM events").get().payload).name, "药");
  const page = unwrap(await mcp(env, "poll_events", { subscription_id: sub.id }));
  assert.equal(page.events.length, 1);
  unwrap(await mcp(env, "ack_event", { id: first.id, lease_token: page.events[0].lease_token }));
  const third = unwrap(await mcp(env, "emit_event", { type: "reminder.medication", dedupe_key: key }));
  assert.equal(third.created, true);
  assert.notEqual(third.id, first.id);
  assert.equal(countOf(db, "events"), 2);
});

test("poll leases the oldest row, hides it, and bumps poll_count after the lease expires", async () => {
  const { env } = sqliteEnv();
  const sub = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }));
  const a = unwrap(
    await mcp(
      env,
      "emit_event",
      { type: "reminder.medication", dedupe_key: "reminder.medication:a:2026-09-30T00:00:00.000Z" },
      { nowMs: NOW },
    ),
  );
  const b = unwrap(
    await mcp(
      env,
      "emit_event",
      { type: "reminder.followup", dedupe_key: "reminder.followup:b:2026-09-30T01:00:00.000Z" },
      { nowMs: NOW + 1000 },
    ),
  );
  const t = NOW + 1000;
  const first = unwrap(await mcp(env, "poll_events", { subscription_id: sub.id, limit: 1 }, { nowMs: t }));
  assert.equal(first.events[0].id, a.id);
  assert.equal(first.events[0].poll_count, 1);
  assert.equal(first.has_more, true);
  const second = unwrap(await mcp(env, "poll_events", { subscription_id: sub.id, limit: 1 }, { nowMs: t }));
  assert.equal(second.events[0].id, b.id);
  unwrap(await mcp(env, "ack_event", { id: b.id, lease_token: second.events[0].lease_token }, { nowMs: t }));
  const hidden = unwrap(await mcp(env, "poll_events", { subscription_id: sub.id }, { nowMs: t }));
  assert.deepEqual(hidden.events, []);
  assert.equal(hidden.has_more, false);
  assert.ok(hidden.retry_after_seconds >= 1);
  const again = unwrap(
    await mcp(env, "poll_events", { subscription_id: sub.id, limit: 1 }, { nowMs: t + 121000 }),
  );
  assert.equal(again.events[0].id, a.id);
  assert.equal(again.events[0].poll_count, 2);
  const gone = unwrap(await mcp(env, "poll_events", { subscription_id: sub.id }, { nowMs: t + 121000 }));
  assert.deepEqual(
    gone.events.map((row) => row.id),
    [],
  );
});

test("a cursor that moved forward still returns an older unacked row once its lease expires", async () => {
  const { env } = sqliteEnv();
  const sub = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }));
  const a = unwrap(
    await mcp(
      env,
      "emit_event",
      { type: "reminder.medication", dedupe_key: "reminder.medication:a:2026-09-30T00:00:00.000Z" },
      { nowMs: NOW },
    ),
  );
  unwrap(
    await mcp(
      env,
      "emit_event",
      { type: "reminder.followup", dedupe_key: "reminder.followup:b:2026-09-30T01:00:00.000Z" },
      { nowMs: NOW + 1000 },
    ),
  );
  const t = NOW + 1000;
  const first = unwrap(
    await mcp(env, "poll_events", { subscription_id: sub.id, limit: 1, visibility_seconds: 30 }, { nowMs: t }),
  );
  assert.equal(first.events[0].id, a.id);
  const second = unwrap(
    await mcp(
      env,
      "poll_events",
      { subscription_id: sub.id, limit: 1, visibility_seconds: 30, cursor: first.next_cursor },
      { nowMs: t },
    ),
  );
  const soon = unwrap(
    await mcp(
      env,
      "poll_events",
      { subscription_id: sub.id, cursor: second.next_cursor, visibility_seconds: 30 },
      { nowMs: t },
    ),
  );
  assert.deepEqual(soon.events, []);
  assert.ok(soon.retry_after_seconds >= 1);
  const back = unwrap(
    await mcp(
      env,
      "poll_events",
      { subscription_id: sub.id, limit: 1, cursor: second.next_cursor, visibility_seconds: 30 },
      { nowMs: t + 31000 },
    ),
  );
  assert.equal(back.events[0].id, a.id);
  assert.equal(back.events[0].poll_count, 2);
});

test("repeat ack is idempotent and a wrong token is lease mismatch while pending", async () => {
  const { db, env } = sqliteEnv();
  const sub = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }));
  const ev = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:a:2026-09-30T00:00:00.000Z",
    }),
  );
  const page = unwrap(await mcp(env, "poll_events", { subscription_id: sub.id }));
  const bad = rpcError(
    await mcp(env, "ack_event", { id: ev.id, lease_token: "0123456789abcdef0123456789abcdef" }),
  );
  assert.equal(bad.code, -32602);
  assert.equal(bad.message, "lease mismatch");
  assert.equal(db.prepare("SELECT status FROM events WHERE id = ?").get(ev.id).status, "pending");
  const ok = unwrap(await mcp(env, "ack_event", { id: ev.id, lease_token: page.events[0].lease_token }));
  assert.equal(ok.idempotent, false);
  assert.equal(ok.status, "acked");
  assert.match(ok.ack_cursor, /^v1\./);
  const again = unwrap(
    await mcp(env, "ack_event", { id: ev.id, lease_token: "ffffffffffffffffffffffffffffffff" }),
  );
  assert.deepEqual(again, { id: ev.id, status: "acked", idempotent: true, ack_cursor: ok.ack_cursor });
});

test("emit_event rejects watchdog types and calendar.due without writing", async () => {
  const { db, env } = sqliteEnv();
  const watchdog = rpcError(
    await mcp(env, "emit_event", { type: "watchdog.heartbeat_stale", dedupe_key: "custom-key" }),
  );
  assert.equal(watchdog.code, -32602);
  const due = rpcError(await mcp(env, "emit_event", { type: "calendar.due", dedupe_key: "custom-key" }));
  assert.equal(due.code, -32602);
  const keyA = rpcError(
    await mcp(env, "emit_event", { type: "reminder.medication", dedupe_key: "watchdog.nope" }),
  );
  assert.equal(keyA.code, -32602);
  const keyB = rpcError(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "calendar.due:cal_abcdefghijkl:2026-09-30T04:00:00.000Z",
    }),
  );
  assert.equal(keyB.code, -32602);
  assert.equal(countOf(db, "events"), 0);
});

test("audience defaults to bot, accepts user, rejects invalid values, and filters poll", async () => {
  const { db, env } = sqliteEnv();
  const sub = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }));
  const implicit = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:implicit",
    }),
  );
  assert.equal(db.prepare("SELECT audience FROM events WHERE id = ?").get(implicit.id).audience, "bot");
  const explicit = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:explicit-bot",
      audience: "bot",
    }),
  );
  assert.equal(explicit.created, true);
  assert.equal(db.prepare("SELECT audience FROM events WHERE id = ?").get(explicit.id).audience, "bot");
  const user = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.followup",
      dedupe_key: "reminder.followup:user",
      audience: "user",
    }),
  );
  assert.equal(user.created, true);
  assert.equal(db.prepare("SELECT audience FROM events WHERE id = ?").get(user.id).audience, "user");
  const bad = rpcError(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:bad",
      audience: "human",
    }),
  );
  assert.equal(bad.code, -32602);
  assert.equal(countOf(db, "events"), 3);
  const badPoll = rpcError(await mcp(env, "poll_events", { subscription_id: sub.id, audience: "all" }));
  assert.equal(badPoll.code, -32602);

  const all = unwrap(
    await mcp(env, "poll_events", { subscription_id: sub.id, visibility_seconds: 30 }),
  );
  assert.deepEqual(
    all.events.map((row) => row.id).sort(),
    [implicit.id, explicit.id, user.id].sort(),
  );
  const later = NOW + 31_000;
  const onlyUser = unwrap(
    await mcp(
      env,
      "poll_events",
      { subscription_id: sub.id, audience: "user", visibility_seconds: 30 },
      { nowMs: later },
    ),
  );
  assert.deepEqual(
    onlyUser.events.map((row) => row.id),
    [user.id],
  );
  const onlyBot = unwrap(
    await mcp(
      env,
      "poll_events",
      { subscription_id: sub.id, audience: "bot", visibility_seconds: 30 },
      { nowMs: later },
    ),
  );
  assert.deepEqual(onlyBot.events.map((row) => row.id).sort(), [implicit.id, explicit.id].sort());

  unwrap(
    await mcp(env, "create_event", {
      title: "复诊",
      start_utc: "2026-09-29T03:00:00.000Z",
      end_utc: "2026-09-29T04:00:00.000Z",
    }),
  );
  unwrap(await mcp(env, "heartbeat", { ttl_seconds: 120 }, { nowMs: NOW - 200_000 }));
  await handleScheduled({}, env, { nowMs: NOW });
  const detected = db.prepare("SELECT type, audience, source FROM events WHERE source = 'detector'").all();
  assert.equal(detected.length, 2);
  for (const row of detected) {
    assert.equal(row.audience, "bot");
    assert.equal(row.source, "detector");
  }
  assert.deepEqual(detected.map((row) => row.type).sort(), ["calendar.due", "watchdog.heartbeat_stale"]);

  db.exec("ALTER TABLE events DROP COLUMN audience");
  db.prepare(
    `INSERT INTO events (
      id, type, payload, status, dedupe_key, created_at, not_before, source, updated_at
    ) VALUES ('evt_legacyaudien', 'reminder.medication', '{}', 'pending', 'reminder.medication:legacy', ?, ?, 'emit', ?)`,
  ).run(NOW_ISO, NOW_ISO, NOW_ISO);
  const migrated = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.followup",
      dedupe_key: "reminder.followup:after-migrate",
    }),
  );
  assert.equal(db.prepare("SELECT audience FROM events WHERE id = 'evt_legacyaudien'").get().audience, "bot");
  assert.equal(db.prepare("SELECT audience FROM events WHERE id = ?").get(migrated.id).audience, "bot");
  const again = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:after-migrate",
      audience: "user",
    }),
  );
  assert.equal(again.created, true);
  assert.equal(db.prepare("SELECT audience FROM events WHERE id = ?").get(again.id).audience, "user");
});

test("payload with a secret key or whsec_ substring is not stored", async () => {
  const { db, env } = sqliteEnv();
  const key = "reminder.medication:a:2026-09-30T00:00:00.000Z";
  const token = rpcError(
    await mcp(env, "emit_event", { type: "reminder.medication", dedupe_key: key, payload: { token: "x" } }),
  );
  assert.equal(token.message, "payload contains a secret");
  const nested = rpcError(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: key,
      payload: { meta: { Password: "x" } },
    }),
  );
  assert.equal(nested.message, "payload contains a secret");
  const embedded = rpcError(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: key,
      payload: { note: "see whsec_abc" },
    }),
  );
  assert.equal(embedded.message, "payload contains a secret");
  assert.equal(countOf(db, "events"), 0);
});

test("the default subscription filter does not claim reminder events", async () => {
  const { db, env } = sqliteEnv();
  const sub = unwrap(await mcp(env, "create_subscription", { mode: "poll" }));
  unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:a:2026-09-30T00:00:00.000Z",
    }),
  );
  const page = unwrap(await mcp(env, "poll_events", { subscription_id: sub.id }));
  assert.deepEqual(page.events, []);
  assert.equal(db.prepare("SELECT poll_count FROM events").get().poll_count, 0);
  const paused = unwrap(await mcp(env, "update_subscription", { id: sub.id, status: "paused" }));
  assert.equal(paused.status, "paused");
  const blocked = rpcError(await mcp(env, "poll_events", { subscription_id: sub.id }));
  assert.equal(blocked.message, "subscription paused");
});

test("calendar detector skips cancelled and out-of-window rows and dedupes until ack", async () => {
  const { db, env } = sqliteEnv();
  const due = unwrap(
    await mcp(env, "create_event", {
      title: "复诊",
      start_utc: "2026-09-29T03:00:00.000Z",
      end_utc: "2026-09-29T04:00:00.000Z",
      location: "clinic",
      notes: "do not copy whsec_secret",
    }),
  );
  unwrap(
    await mcp(env, "create_event", {
      title: "old",
      start_utc: "2026-09-20T03:00:00.000Z",
      end_utc: "2026-09-20T04:00:00.000Z",
    }),
  );
  unwrap(
    await mcp(env, "create_event", {
      title: "later",
      start_utc: "2026-09-29T06:00:00.000Z",
      end_utc: "2026-09-29T07:00:00.000Z",
    }),
  );
  const cancelled = unwrap(
    await mcp(env, "create_event", {
      title: "nope",
      start_utc: "2026-09-29T02:00:00.000Z",
      end_utc: "2026-09-29T02:30:00.000Z",
    }),
  );
  unwrap(await mcp(env, "delete_event", { id: cancelled.id }));
  await handleScheduled({}, env, { nowMs: NOW });
  const rows = db.prepare("SELECT type, dedupe_key, payload, source FROM events").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "calendar.due");
  assert.equal(rows[0].source, "detector");
  const payload = JSON.parse(rows[0].payload);
  assert.equal(payload.calendar_event_id, due.id);
  assert.equal(payload.path, `/cal/${due.id}`);
  assert.equal(payload.title, "复诊");
  assert.equal(payload.location, "clinic");
  assert.equal(payload.notes, undefined);
  assert.equal(rows[0].dedupe_key, `calendar.due:${due.id}:${payload.start_utc}`);
  await handleScheduled({}, env, { nowMs: NOW });
  assert.equal(countOf(db, "events"), 1);
  unwrap(await mcp(env, "delete_event", { id: due.id }));
  await handleScheduled({}, env, { nowMs: NOW });
  assert.equal(countOf(db, "events"), 1);
});

test("heartbeat staleness starts only after the first report and does not duplicate", async () => {
  const { db, env } = sqliteEnv();
  unwrap(await mcp(env, "create_subscription", { mode: "poll", watch_heartbeat: false, agent_id: "bot:quiet" }));
  unwrap(await mcp(env, "heartbeat", { agent_id: "bot:quiet", ttl_seconds: 120 }, { nowMs: NOW - 1_000_000 }));
  await handleScheduled({}, env, { nowMs: NOW });
  assert.equal(countOf(db, "events"), 0);
  unwrap(await mcp(env, "create_subscription", { mode: "poll" }));
  await handleScheduled({}, env, { nowMs: NOW });
  assert.equal(countOf(db, "events"), 0);
  const beat = unwrap(await mcp(env, "heartbeat", { ttl_seconds: 600 }, { nowMs: NOW }));
  assert.deepEqual(beat, { agent_id: "bot:main", seen_at: NOW_ISO, ttl_seconds: 600 });
  await handleScheduled({}, env, { nowMs: NOW + 600 * 1000 });
  assert.equal(countOf(db, "events"), 0);
  await handleScheduled({}, env, { nowMs: NOW + 630 * 1000 });
  const row = db.prepare("SELECT type, dedupe_key, payload FROM events").get();
  assert.equal(row.type, "watchdog.heartbeat_stale");
  assert.equal(row.dedupe_key, "watchdog.heartbeat_stale:bot:main");
  assert.equal(JSON.parse(row.payload).stale_for_seconds, 30);
  await handleScheduled({}, env, { nowMs: NOW + 800 * 1000 });
  assert.equal(countOf(db, "events"), 1);
});

test("webhook signature matches a fixed HMAC and rejects a bad signature", async () => {
  const secret = "whsec_test_signature_key";
  const event = {
    id: "evt_0123456789ab",
    type: "calendar.due",
    dedupe_key: "calendar.due:cal_0123456789ab:2026-09-30T04:00:00.000Z",
    created_at: "2026-09-30T04:00:00.000Z",
    not_before: "2026-09-30T04:00:00.000Z",
    payload: { title: "复诊", all_day: false },
  };
  const body = buildWebhookBody(event);
  assert.equal(
    body,
    '{"created_at":"2026-09-30T04:00:00.000Z","dedupe_key":"calendar.due:cal_0123456789ab:2026-09-30T04:00:00.000Z","id":"evt_0123456789ab","not_before":"2026-09-30T04:00:00.000Z","payload":{"all_day":false,"title":"复诊"},"type":"calendar.due"}',
  );
  assert.equal(stableStringify(event.payload), '{"all_day":false,"title":"复诊"}');
  assert.equal(body.includes("whsec_"), false);
  assert.equal(body.includes("lease_token"), false);
  assert.equal(Object.hasOwn(JSON.parse(body), "secret"), false);
  const timestamp = "1759190400";
  const hex = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  assert.equal(await signWebhook(secret, timestamp, body), hex);
  assert.match(hex, /^[0-9a-f]{64}$/);
  const nowMs = 1759190400 * 1000;
  assert.equal(
    await verifyWebhookRequest({ secret, timestamp, body, signature: `v1=${hex}`, nowMs }),
    true,
  );
  assert.equal(
    await verifyWebhookRequest({ secret, timestamp, body, signature: `v1=${"0".repeat(64)}`, nowMs }),
    false,
  );
  assert.equal(
    await verifyWebhookRequest({ secret, timestamp, body, signature: `v1=${hex}`, nowMs: nowMs + 301000 }),
    false,
  );
});

test("timeouts and 500s back off 60/120/240 and the fourth failure dies with the event still pending", async () => {
  const { db, env } = sqliteEnv();
  const sub = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/hook",
      event_types: ["*"],
    }),
  );
  assert.match(sub.secret, /^whsec_[A-Za-z0-9+/]+=*$/);
  assert.equal(Object.hasOwn(unwrap(await mcp(env, "get_subscription", { id: sub.id })), "secret"), false);
  const ev = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:a:2026-09-30T00:00:00.000Z",
      payload: { name: "药" },
    }),
  );
  const delivery = db.prepare("SELECT id FROM deliveries WHERE event_id = ?").get(ev.id);
  const delays = [];
  let calls = 0;
  for (let i = 0; i < 4; i++) {
    const decision = await consumeDelivery({ body: { delivery_id: delivery.id } }, env, {
      nowMs: NOW + i * 1000,
      fetch: async () => {
        calls += 1;
        return new Response("no", { status: 500 });
      },
    });
    if (i < 3) {
      assert.equal(decision.action, "retry");
      delays.push(decision.delaySeconds);
    } else {
      assert.equal(decision.action, "ack");
    }
  }
  assert.deepEqual(delays, [60, 120, 240]);
  assert.equal(calls, 4);
  const dead = db.prepare("SELECT state, dead_reason, attempts FROM deliveries WHERE id = ?").get(delivery.id);
  assert.equal(dead.state, "dead");
  assert.equal(dead.dead_reason, "retries_exhausted");
  assert.equal(dead.attempts, 4);
  assert.equal(db.prepare("SELECT status FROM events WHERE id = ?").get(ev.id).status, "pending");

  const follow = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.followup",
      dedupe_key: "reminder.followup:cal_abcdefghijkl:2026-09-30T00:00:00.000Z",
    }),
  );
  const second = db.prepare("SELECT id FROM deliveries WHERE event_id = ?").get(follow.id);
  let posts = 0;
  const missing = await consumeDelivery({ body: { delivery_id: second.id } }, env, {
    nowMs: NOW,
    fetch: async (url, init) => {
      posts += 1;
      assert.equal(url, "https://example.com/hook");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers["user-agent"], "botu-data-webhook/1");
      assert.equal(init.headers.authorization, undefined);
      assert.equal(init.body.includes(sub.secret), false);
      assert.equal(init.body.includes("lease_token"), false);
      assert.equal(
        await verifyWebhookRequest({
          secret: sub.secret,
          timestamp: init.headers["x-botu-timestamp"],
          body: init.body,
          signature: init.headers["x-botu-signature"],
          nowMs: NOW,
        }),
        true,
      );
      return new Response("missing", { status: 404 });
    },
  });
  assert.equal(missing.action, "ack");
  assert.equal(posts, 1);
  const row = db.prepare("SELECT state, dead_reason, last_error, attempts FROM deliveries WHERE id = ?").get(second.id);
  assert.equal(row.state, "dead");
  assert.equal(row.dead_reason, "http_status");
  assert.equal(row.last_error, "http_404");
  assert.equal(row.attempts, 1);
  assert.equal(db.prepare("SELECT status FROM events WHERE id = ?").get(follow.id).status, "pending");

  const third = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:b:2026-09-30T02:00:00.000Z",
    }),
  );
  const thirdDelivery = db.prepare("SELECT id FROM deliveries WHERE event_id = ?").get(third.id);
  const timed = await consumeDelivery({ body: { delivery_id: thirdDelivery.id } }, env, {
    nowMs: NOW,
    fetch: async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    },
  });
  assert.equal(timed.action, "retry");
  assert.equal(timed.delaySeconds, 60);
  assert.equal(db.prepare("SELECT last_error, attempts FROM deliveries WHERE id = ?").get(thirdDelivery.id).last_error, "timeout");
  const nextAt = db.prepare("SELECT next_attempt_at FROM deliveries WHERE id = ?").get(thirdDelivery.id).next_attempt_at;
  assert.equal(nextAt, new Date(NOW + 60 * 1000).toISOString());
});

test("subscription_deleted does not raise queue_dlq; other dead letters do once and do not fan out", async () => {
  const { db, env } = sqliteEnv();
  const kept = unwrap(
    await mcp(env, "create_subscription", { mode: "webhook", url: "https://example.com/a", event_types: ["*"] }),
  );
  const dropped = unwrap(
    await mcp(env, "create_subscription", { mode: "webhook", url: "https://example.com/b", event_types: ["*"] }),
  );
  const ev = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:a:2026-09-30T00:00:00.000Z",
    }),
  );
  assert.equal(countOf(db, "deliveries"), 2);
  unwrap(await mcp(env, "delete_subscription", { id: dropped.id }));
  assert.equal(
    db.prepare("SELECT dead_reason FROM deliveries WHERE subscription_id = ?").get(dropped.id).dead_reason,
    "subscription_deleted",
  );
  const keptDelivery = db.prepare("SELECT id FROM deliveries WHERE subscription_id = ?").get(kept.id);
  await consumeDelivery({ body: { delivery_id: keptDelivery.id } }, env, {
    nowMs: NOW,
    fetch: async () => new Response("", { status: 404 }),
  });
  await handleScheduled({}, env, { nowMs: NOW + 1000 });
  const watch = db.prepare("SELECT id, dedupe_key, payload FROM events WHERE type = 'watchdog.queue_dlq'").all();
  assert.equal(watch.length, 1);
  assert.equal(watch[0].dedupe_key, `watchdog.queue_dlq:${keptDelivery.id}`);
  assert.equal(JSON.parse(watch[0].payload).dead_reason, "http_status");
  assert.equal(JSON.parse(watch[0].payload).queue, "botu-deliver-dlq");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE event_id = ?").get(watch[0].id).n, 0);
  await handleScheduled({}, env, { nowMs: NOW + 2000 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'watchdog.queue_dlq'").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM events WHERE id = ?").get(ev.id).status, "pending");
});

test("the dead-letter consumer records the row and does not POST", async () => {
  const { db, env } = sqliteEnv();
  unwrap(
    await mcp(env, "create_subscription", { mode: "webhook", url: "https://example.com/hook", event_types: ["*"] }),
  );
  unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:a:2026-09-30T00:00:00.000Z",
    }),
  );
  const delivery = db.prepare("SELECT id FROM deliveries").get();
  let posts = 0;
  let acked = 0;
  let retried = 0;
  await handleQueue(
    {
      queue: "botu-deliver-dlq",
      messages: [
        {
          body: { delivery_id: delivery.id },
          ack() {
            acked += 1;
          },
          retry() {
            retried += 1;
          },
        },
      ],
    },
    env,
    {
      nowMs: NOW,
      fetch: async () => {
        posts += 1;
        return new Response("no");
      },
    },
  );
  assert.equal(posts, 0);
  assert.equal(acked, 1);
  assert.equal(retried, 0);
  const row = db.prepare("SELECT state, dead_reason, last_error FROM deliveries").get();
  assert.equal(row.state, "dead");
  assert.equal(row.dead_reason, "retries_exhausted");
  assert.equal(row.last_error, "handler_crash");
});

test("cron requeues a due delivery and returns a stuck inflight row to due", async () => {
  const { db, env, sent } = sqliteEnv();
  unwrap(
    await mcp(env, "create_subscription", { mode: "webhook", url: "https://example.com/hook", event_types: ["*"] }),
  );
  const later = new Date(NOW + 3_600_000).toISOString();
  unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:a:2026-09-30T00:00:00.000Z",
      not_before: later,
    }),
  );
  assert.equal(sent.length, 0);
  const delivery = db.prepare("SELECT id, state, queued_at, next_attempt_at FROM deliveries").get();
  assert.equal(delivery.state, "due");
  assert.equal(delivery.queued_at, null);
  assert.equal(delivery.next_attempt_at, later);
  await handleScheduled({}, env, { nowMs: NOW });
  assert.equal(sent.length, 0);
  await handleScheduled({}, env, { nowMs: NOW + 3_600_000 });
  assert.deepEqual(sent, [{ delivery_id: delivery.id }]);
  db.prepare(
    "UPDATE deliveries SET state = 'inflight', inflight_at = ?, queued_at = ?, next_attempt_at = NULL WHERE id = ?",
  ).run(new Date(NOW).toISOString(), new Date(NOW).toISOString(), delivery.id);
  sent.length = 0;
  await handleScheduled({}, env, { nowMs: NOW + 181_000 });
  const reclaimed = db.prepare("SELECT state, queued_at FROM deliveries WHERE id = ?").get(delivery.id);
  assert.equal(reclaimed.state, "due");
  assert.equal(reclaimed.queued_at, null);
  assert.equal(sent.length, 0);
  await handleScheduled({}, env, { nowMs: NOW + 181_000 });
  assert.deepEqual(sent, [{ delivery_id: delivery.id }]);
});

test("health and create_contact keep their phase 1 shapes", async () => {
  const { env } = sqliteEnv();
  const health = await worker.fetch(new Request("https://botu-data.test/health"), env);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(Object.keys(body), ["ok"]);
  const created = unwrap(await mcp(env, "create_contact", { name: "Ada" }));
  assert.deepEqual(Object.keys(created).sort(), ["id", "url"]);
  const init = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, {});
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.version, "1.0.0");
  assert.deepEqual(
    TOOLS.map((tool) => tool.name).slice(0, 15),
    PHASE1_TOOL_NAMES,
  );
  assert.deepEqual(TOOLS.map((tool) => tool.name).slice(15), PHASE2_TOOL_NAMES);
});
