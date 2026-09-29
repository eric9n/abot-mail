import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, {
  TOOLS,
  canonicalUrl,
  handleFetch,
  handleMcpRpc,
  idFromBytes,
  timingSafeEqual,
} from "./worker.js";

const TOKEN = "test-data-token";
const NOW = Date.parse("2026-09-29T04:00:00.000Z");
const NOW_ISO = "2026-09-29T04:00:00.000Z";
const LATER = Date.parse("2026-09-29T05:00:00.000Z");
const LATER_ISO = "2026-09-29T05:00:00.000Z";

const TOOL_NAMES = [
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

function schemaSql() {
  return readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
}

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql());
  const env = {
    DATA_MCP_TOKEN: TOKEN,
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
  };
  return { db, env };
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

test("tools/list exposes the fifteen tools", async () => {
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
