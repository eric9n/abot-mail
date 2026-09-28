import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  RpcError,
  archiveEvent,
  assembleStats,
  assertAllowedDownloadUrl,
  buildAttachmentKey,
  buildGetQuery,
  buildHealthQuery,
  buildInsertQuery,
  buildListQuery,
  buildSearchQuery,
  buildStatsQueries,
  canonicalBound,
  decodeWebhookSecret,
  handleFetch,
  handleMcpRpc,
  likeContains,
  mapEmailForStorage,
  parseEmailDate,
  timingSafeEqual,
  toMetadata,
  verifySvixSignature,
} from "./worker.js";

const SECRET_RAW = Buffer.from("unit-test-webhook-secret");
const WEBHOOK_SECRET = `whsec_${SECRET_RAW.toString("base64")}`;
const NOW_MS = Date.parse("2026-09-28T12:00:00.000Z");
const EMAIL_ID = "435eb30a-d52d-4f7c-a400-ccac381b7cc4";

function sign(id, timestamp, body) {
  const mac = createHmac("sha256", SECRET_RAW).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

function freshTimestamp(skewSec = 0) {
  return String(Math.floor(NOW_MS / 1000) + skewSec);
}

test("timingSafeEqual compares full strings", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
  assert.equal(timingSafeEqual("a", ""), false);
});

test("decodeWebhookSecret restores the raw key", () => {
  const bytes = decodeWebhookSecret(WEBHOOK_SECRET);
  assert.deepEqual(Buffer.from(bytes), SECRET_RAW);
});

test("verifySvixSignature accepts a valid signature and rejects forgeries", async () => {
  const body = '{"type":"email.received","data":{"email_id":"abc"}}';
  const ts = freshTimestamp(-30);
  const good = sign("msg_1", ts, body);
  const ok = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_1",
    svixTimestamp: ts,
    svixSignature: good,
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.deepEqual(ok, { ok: true });

  const forged = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_1",
    svixTimestamp: ts,
    svixSignature: `v1,${"A".repeat(44)}`,
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, "bad_signature");

  const otherBody = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_1",
    svixTimestamp: ts,
    svixSignature: good,
    rawBody: body.replace("abc", "abd"),
    nowMs: NOW_MS,
  });
  assert.equal(otherBody.ok, false);

  const among = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_1",
    svixTimestamp: ts,
    svixSignature: `v1,not-the-signature ${good}`,
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(among.ok, true);
});

test("verifySvixSignature rejects timestamps outside five minutes", async () => {
  const body = "{}";
  const oldTs = freshTimestamp(-(5 * 60 + 1));
  const old = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_old",
    svixTimestamp: oldTs,
    svixSignature: sign("msg_old", oldTs, body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(old.ok, false);
  assert.equal(old.reason, "timestamp_out_of_range");

  const futureTs = freshTimestamp(5 * 60 + 1);
  const future = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_new",
    svixTimestamp: futureTs,
    svixSignature: sign("msg_new", futureTs, body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(future.ok, false);
  assert.equal(future.reason, "timestamp_out_of_range");

  const edgeTs = freshTimestamp(-5 * 60);
  const edge = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_edge",
    svixTimestamp: edgeTs,
    svixSignature: sign("msg_edge", edgeTs, body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(edge.ok, true);
});

test("verifySvixSignature rejects missing headers and a bad secret", async () => {
  const body = "{}";
  const ts = freshTimestamp();
  const missing = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "",
    svixTimestamp: ts,
    svixSignature: sign("msg", ts, body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(missing.reason, "missing_header");

  const badSecret = await verifySvixSignature({
    secret: "not-a-whsec",
    svixId: "msg",
    svixTimestamp: ts,
    svixSignature: sign("msg", ts, body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(badSecret.reason, "bad_secret");
});

test("parseEmailDate prefers a quoted Date header over created_at", () => {
  assert.equal(parseEmailDate('"2026-09-28T06:15:05.000Z"'), "2026-09-28T06:15:05.000Z");
  assert.equal(parseEmailDate("Mon, 28 Sep 2026 06:15:05 +0000"), "2026-09-28T06:15:05.000Z");
  const row = mapEmailForStorage(
    {
      id: EMAIL_ID,
      from: "notboliam@gmail.com",
      to: ["eric@abot.run"],
      cc: [],
      subject: "test",
      text: "test\n",
      html: null,
      message_id: "<abc@gmail.com>",
      created_at: "2026-09-28T06:15:23.755Z",
      headers: { date: '"2026-09-28T06:15:05.000Z"' },
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    },
    { direction: "in", eventCreatedAt: "2026-09-28T06:16:00.000Z", attachments: [] },
  );
  assert.equal(row.date, "2026-09-28T06:15:05.000Z");
  assert.equal(row.direction, "in");
  assert.deepEqual(JSON.parse(row.auth), { spf: "pass", dkim: "pass", dmarc: "pass" });
  assert.equal(row.msg_to, '["eric@abot.run"]');
  const outbound = mapEmailForStorage(
    { id: "x", from: "eric@abot.run", to: ["a@b.c"], subject: "s", text: "t", created_at: "2026-09-28T01:00:00.000Z" },
    { direction: "out", eventCreatedAt: "2026-09-28T01:00:01.000Z", attachments: [] },
  );
  assert.equal(outbound.auth, null);
});

test("attachment keys drop path segments and stay unique", () => {
  const used = new Set();
  assert.equal(buildAttachmentKey(EMAIL_ID, "../secret/a b.png", used), `attachments/${EMAIL_ID}/a_b.png`);
  assert.equal(buildAttachmentKey(EMAIL_ID, "../secret/a b.png", used), `attachments/${EMAIL_ID}/2-a_b.png`);
  assert.equal(buildAttachmentKey(EMAIL_ID, "..", used), `attachments/${EMAIL_ID}/attachment`);
});

test("download URLs are limited to Resend HTTPS hosts", () => {
  assert.equal(
    assertAllowedDownloadUrl("https://cdn.resend.app/receiving/raw/x"),
    "https://cdn.resend.app/receiving/raw/x",
  );
  assert.throws(() => assertAllowedDownloadUrl("http://cdn.resend.app/x"), /non-https/);
  assert.throws(() => assertAllowedDownloadUrl("https://evil.example/raw"), /unexpected download host/);
  assert.throws(() => assertAllowedDownloadUrl("https://resend.com.evil.example/x"), /unexpected/);
});

test("SQL builders parameterize filters and clamp limit", () => {
  const query = "'; DROP TABLE emails; --";
  const search = buildSearchQuery({
    query,
    from: "alice@example.com",
    to: "eric@abot.run",
    since: "2026-09-01",
    until: "2026-09-28T00:00:00.000Z",
    direction: "in",
    limit: 500,
  });
  assert.equal(search.sql.includes("DROP"), false);
  assert.equal(search.sql.includes(query), false);
  assert.equal(search.params.at(-1), 100);
  assert.equal(search.params[0], likeContains(query));
  assert.equal(search.params.filter((p) => p === search.params[0]).length, 3);
  assert.ok(search.params.includes("in"));
  assert.equal(canonicalBound("2026-09-01", "start"), "2026-09-01T00:00:00.000Z");
  assert.equal(canonicalBound("2026-09-01", "end"), "2026-09-01T23:59:59.999Z");
  assert.equal(likeContains("100%_"), "%100\\%\\_%");
  assert.throws(() => buildSearchQuery({}), (err) => err instanceof RpcError && err.code === -32602);
  assert.throws(() => buildSearchQuery({ query: "a", direction: "IN" }), (err) => err.code === -32602);
  assert.throws(() => buildGetQuery({}), (err) => err.code === -32602);

  const getHtml = buildGetQuery({ resend_id: EMAIL_ID, include_html: true });
  const getPlain = buildGetQuery({ resend_id: EMAIL_ID });
  assert.match(getHtml.sql, /text_body,\n {2}html_body/);
  assert.doesNotMatch(getPlain.sql, /text_body,\n {2}html_body/);
  assert.deepEqual(getPlain.params, [EMAIL_ID]);

  const list = buildListQuery({ direction: "out", since: "2026-09-15", limit: 5 });
  assert.match(list.sql, /ORDER BY date DESC/);
  assert.deepEqual(list.params, ["out", "2026-09-15T00:00:00.000Z", 5]);

  const stats = buildStatsQueries(NOW_MS);
  assert.equal(stats.byDay.params[0], new Date(NOW_MS - 30 * 24 * 60 * 60 * 1000).toISOString());
  assert.equal(stats.topSenders.params.length, 0);
  assert.match(buildHealthQuery(NOW_MS).sql, /direction = 'in'/);
  assert.doesNotMatch(buildHealthQuery(NOW_MS).sql, /text_body|html_body|subject/);
});

test("SQL builders run against the archive schema", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const rows = [
    mapEmailForStorage(
      {
        id: "in-1",
        from: "alice@example.com",
        to: ["eric@abot.run"],
        cc: ["cc@example.com"],
        subject: "invoice 发票",
        text: "please pay 100% done",
        html: "<p>pay</p>",
        message_id: "<in@example.com>",
        created_at: "2026-09-01T00:00:00.000Z",
        authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
      },
      {
        direction: "in",
        eventCreatedAt: "2026-09-01T00:00:00.000Z",
        attachments: [{ filename: "a.png", content_type: "image/png", size: 4, r2_key: "attachments/in-1/a.png" }],
      },
    ),
    mapEmailForStorage(
      {
        id: "out-1",
        from: "eric@abot.run",
        to: ["bob@example.com"],
        subject: "re: invoice",
        text: "100X done",
        html: null,
        created_at: "2026-09-20T00:00:00.000Z",
      },
      { direction: "out", eventCreatedAt: "2026-09-20T00:00:00.000Z", attachments: [] },
    ),
  ];
  for (const row of rows) {
    const insert = buildInsertQuery(row);
    db.prepare(insert.sql).run(...insert.params);
  }
  const again = buildInsertQuery(rows[0]);
  db.prepare(again.sql).run(...again.params);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 2);

  function all(query) {
    return db.prepare(query.sql).all(...query.params);
  }

  const bySubject = all(buildSearchQuery({ query: "发票" })).map(toMetadata);
  assert.equal(bySubject.length, 1);
  assert.equal(bySubject[0].resend_id, "in-1");
  assert.equal(bySubject[0].has_text, true);
  assert.equal(bySubject[0].has_html, true);
  assert.equal("text_body" in bySubject[0], false);
  assert.equal("html_body" in bySubject[0], false);
  assert.deepEqual(bySubject[0].to, ["eric@abot.run"]);

  assert.equal(all(buildSearchQuery({ query: "100%" })).length, 1);
  assert.equal(all(buildSearchQuery({ query: "100%", from: "alice@example.com" }))[0].resend_id, "in-1");
  assert.equal(all(buildSearchQuery({ query: "_" })).length, 0);
  assert.equal(all(buildSearchQuery({ query: "invoice", direction: "out" }))[0].resend_id, "out-1");
  assert.equal(all(buildSearchQuery({ query: "invoice", since: "2026-09-15" }))[0].resend_id, "out-1");
  assert.equal(all(buildSearchQuery({ query: "invoice", to: "eric@abot.run" }))[0].resend_id, "in-1");

  const listed = all(buildListQuery({ limit: 1 }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].resend_id, "out-1");

  const detail = all(buildGetQuery({ resend_id: "in-1", include_html: true }))[0];
  assert.equal(detail.text_body, "please pay 100% done");
  assert.match(detail.html_body, /pay/);
  const plain = all(buildGetQuery({ resend_id: "in-1" }))[0];
  assert.equal(plain.html_body, undefined);

  const statsQueries = buildStatsQueries(Date.parse("2026-09-28T00:00:00.000Z"));
  const stats = assembleStats(
    all(statsQueries.total),
    all(statsQueries.byDirection),
    all(statsQueries.byDay),
    all(statsQueries.topSenders),
  );
  assert.equal(stats.total, 2);
  assert.deepEqual(stats.by_direction, { in: 1, out: 1 });
  assert.deepEqual(
    stats.by_day.map((d) => d.day),
    ["2026-09-01", "2026-09-20"],
  );
  assert.equal(stats.top_senders[0].count, 1);

  const health = db.prepare(buildHealthQuery(Date.now()).sql).get(...buildHealthQuery(Date.now()).params);
  assert.equal(Number(health.count_24h), 2);
  assert.ok(health.last_received_at);
});

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const bucket = new Map();
  const env = {
    WEBHOOK_SECRET,
    RESEND_API_KEY: "test-resend-key",
    MCP_TOKEN: "test-mcp-token",
    DB: {
      prepare(sql) {
        const make = (params) => ({
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          first: async () => db.prepare(sql).get(...params) ?? null,
          run: async () => {
            db.prepare(sql).run(...params);
            return { success: true };
          },
        });
        return { ...make([]), bind: (...params) => make(params) };
      },
    },
    ARCHIVE_BUCKET: {
      async put(key, value, opts) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
        bucket.set(key, { bytes, opts });
      },
      async get(key) {
        const hit = bucket.get(key);
        if (!hit) return null;
        return { async text() { return new TextDecoder().decode(hit.bytes); } };
      },
    },
  };
  return { db, bucket, env };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("webhook archives inbound mail once, then MCP can read it", async () => {
  const { db, bucket, env } = sqliteEnv();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, authorization: init.headers && init.headers.Authorization });
    if (href === `https://api.resend.com/emails/receiving/${EMAIL_ID}`) {
      assert.equal(init.headers.Authorization, "Bearer test-resend-key");
      return jsonResponse({
        object: "email",
        id: EMAIL_ID,
        from: "notboliam@gmail.com",
        to: ["eric@abot.run"],
        cc: [],
        subject: "invoice 发票",
        text: "please pay\n",
        html: "<p>pay</p>",
        message_id: "<abc@gmail.com>",
        created_at: "2026-09-28T06:15:23.755Z",
        headers: { date: '"2026-09-28T06:15:05.000Z"' },
        authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
        raw: { download_url: "https://cdn.resend.app/receiving/raw/x", expires_at: "2026-09-28T07:00:00.000Z" },
        attachments: [],
      });
    }
    if (href === "https://cdn.resend.app/receiving/raw/x") {
      assert.equal(init.headers && init.headers.Authorization, undefined);
      assert.equal(init.redirect, "manual");
      return new Response("Subject: invoice\r\n\r\nplease pay\r\n", { status: 200 });
    }
    if (href.startsWith(`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments`)) {
      if (!href.includes("after=")) {
        return jsonResponse({
          object: "list",
          has_more: true,
          data: [
            {
              id: "att-1",
              filename: "../secret/a b.png",
              size: 4,
              content_type: "image/png",
              download_url: "https://inbound-cdn.resend.com/att-1",
            },
          ],
        });
      }
      return jsonResponse({
        object: "list",
        has_more: false,
        data: [
          {
            id: "att-2",
            filename: "../secret/a b.png",
            size: 3,
            content_type: "image/png",
            download_url: "https://inbound-cdn.resend.com/att-2",
          },
        ],
      });
    }
    if (href === "https://inbound-cdn.resend.com/att-1") return new Response("png1", { status: 200 });
    if (href === "https://inbound-cdn.resend.com/att-2") return new Response("png", { status: 200 });
    throw new Error(`unexpected fetch ${href}`);
  };

  const event = {
    type: "email.received",
    created_at: "2026-09-28T06:15:24.000Z",
    data: { email_id: EMAIL_ID, from: "notboliam@gmail.com", to: ["eric@abot.run"], subject: "invoice 发票" },
  };
  const raw = JSON.stringify(event);
  const ts = freshTimestamp(-5);
  const post = () =>
    handleFetch(
      new Request("https://resend-agent-mail-relay.eric9n-cf.workers.dev/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "msg_in",
          "svix-timestamp": ts,
          "svix-signature": sign("msg_in", ts, raw),
        },
        body: raw,
      }),
      env,
      { fetch: fetchImpl, nowMs: NOW_MS },
    );

  const first = await post();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });
  const callsAfterFirst = calls.length;
  const second = await post();
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });
  assert.equal(calls.length, callsAfterFirst);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 1);

  const stored = db.prepare("SELECT * FROM emails").get();
  assert.equal(stored.direction, "in");
  assert.equal(stored.date, "2026-09-28T06:15:05.000Z");
  assert.equal(stored.subject, "invoice 发票");
  assert.equal(stored.text_body, "please pay\n");
  const attachments = JSON.parse(stored.attachments);
  assert.deepEqual(
    attachments.map((item) => item.r2_key),
    [`attachments/${EMAIL_ID}/a_b.png`, `attachments/${EMAIL_ID}/2-a_b.png`],
  );
  assert.ok(bucket.has(`raw/${EMAIL_ID}.eml`));
  assert.equal(new TextDecoder().decode(bucket.get(`raw/${EMAIL_ID}.eml`).bytes), "Subject: invoice\r\n\r\nplease pay\r\n");

  const health = await handleFetch(new Request("https://example.test/health"), env, { nowMs: Date.now() });
  const healthBody = await health.json();
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(healthBody).sort(), ["count_24h", "last_received_at", "ok"]);
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.count_24h, 1);
  assert.equal(typeof healthBody.last_received_at, "string");
  assert.equal(JSON.stringify(healthBody).includes("please pay"), false);

  async function mcp(message, token = "test-mcp-token") {
    const res = await handleFetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
      }),
      env,
      { nowMs: Date.parse("2026-09-28T12:00:00.000Z") },
    );
    return { status: res.status, body: await res.json() };
  }

  const listedTools = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(
    listedTools.body.result.tools.map((tool) => tool.name),
    ["search_emails", "get_email", "list_emails", "email_stats"],
  );
  for (const tool of listedTools.body.result.tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
  }

  const found = await mcp({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "search_emails", arguments: { query: "发票" } },
  });
  const foundRows = JSON.parse(found.body.result.content[0].text);
  assert.equal(foundRows.length, 1);
  assert.equal(foundRows[0].resend_id, EMAIL_ID);
  assert.equal("text_body" in foundRows[0], false);

  const detail = await mcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_email", arguments: { resend_id: EMAIL_ID, include_html: true, include_raw_eml: true } },
  });
  const email = JSON.parse(detail.body.result.content[0].text);
  assert.equal(email.found, true);
  assert.match(email.text_body, /please pay/);
  assert.match(email.html_body, /pay/);
  assert.match(email.raw_eml, /Subject: invoice/);

  const stats = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "email_stats", arguments: {} } });
  const statsBody = JSON.parse(stats.body.result.content[0].text);
  assert.equal(statsBody.total, 1);
  assert.equal(statsBody.by_direction.in, 1);
  assert.equal(statsBody.by_direction.out, 0);
});

test("webhook ignores unknown events and rejects a bad signature before fetch", async () => {
  const { db, env } = sqliteEnv();
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error("should not fetch");
  };
  const ignored = { type: "email.delivered", data: { email_id: EMAIL_ID } };
  const raw = JSON.stringify(ignored);
  const ts = freshTimestamp();
  const ok = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_ign",
        "svix-timestamp": ts,
        "svix-signature": sign("msg_ign", ts, raw),
      },
      body: raw,
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(ok.status, 200);
  assert.equal(fetched, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);

  const bad = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_bad",
        "svix-timestamp": ts,
        "svix-signature": "v1,aaaaaaaa",
      },
      body: raw,
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(bad.status, 401);
  assert.equal(fetched, false);

  const spaced = JSON.stringify({ type: "email.delivered", data: { email_id: EMAIL_ID } });
  const reparsed = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_ign",
        "svix-timestamp": ts,
        "svix-signature": sign("msg_ign", ts, raw),
      },
      body: `${spaced} `,
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(reparsed.status, 401);
});

test("webhook refuses a raw download that redirects off Resend", async () => {
  const { db, env } = sqliteEnv();
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.startsWith("https://api.resend.com/emails/receiving/")) {
      return jsonResponse({
        id: EMAIL_ID,
        from: "a@b.c",
        to: ["eric@abot.run"],
        subject: "x",
        text: "y",
        created_at: "2026-09-28T00:00:00.000Z",
        raw: { download_url: "https://cdn.resend.app/raw" },
      });
    }
    if (href === "https://cdn.resend.app/raw") {
      return new Response(null, { status: 302, headers: { location: "https://evil.example/raw" } });
    }
    throw new Error(`unexpected ${href}`);
  };
  const event = { type: "email.received", created_at: "2026-09-28T00:00:01.000Z", data: { email_id: EMAIL_ID } };
  const raw = JSON.stringify(event);
  const ts = freshTimestamp();
  const res = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: { "svix-id": "msg_r", "svix-timestamp": ts, "svix-signature": sign("msg_r", ts, raw) },
      body: raw,
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(res.status, 500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
});

test("webhook stores outbound mail without auth or raw", async () => {
  const sentId = "sent-1111-2222";
  const { db, bucket, env } = sqliteEnv();
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href === `https://api.resend.com/emails/${sentId}`) {
      return jsonResponse({
        id: sentId,
        from: "eric@abot.run",
        to: ["bob@example.com"],
        cc: [],
        subject: "outbound",
        text: "sent body",
        html: "<p>sent</p>",
        created_at: "2026-09-28T08:00:00.000Z",
      });
    }
    if (href.startsWith(`https://api.resend.com/emails/${sentId}/attachments`)) {
      return jsonResponse({ object: "list", has_more: false, data: [] });
    }
    throw new Error(`unexpected ${href}`);
  };
  const result = await archiveEvent({
    event: { type: "email.sent", created_at: "2026-09-28T08:00:01.000Z", data: { email_id: sentId } },
    env,
    fetchImpl,
    nowMs: NOW_MS,
  });
  assert.equal(result.status, 200);
  const row = db.prepare("SELECT * FROM emails WHERE resend_id = ?").get(sentId);
  assert.equal(row.direction, "out");
  assert.equal(row.auth, null);
  assert.equal(row.text_body, "sent body");
  assert.equal(bucket.size, 0);
});

test("MCP JSON-RPC dispatch", async () => {
  const deps = {
    async queryAll() {
      throw new Error("db should not be called");
    },
  };
  const init = await handleMcpRpc(
    { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    deps,
  );
  assert.deepEqual(init.result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "abot-mail-mcp", version: "1.0.0" },
  });

  const note = await handleMcpRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, deps);
  assert.equal(note.type, "notification");

  const missing = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "resources/list" }, deps);
  assert.equal(missing.error.code, -32601);

  const badParams = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/call" }, deps);
  assert.equal(badParams.error.code, -32602);

  const unknownTool = await handleMcpRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_all", arguments: {} } },
    deps,
  );
  assert.equal(unknownTool.error.code, -32601);

  const missingQuery = await handleMcpRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_emails", arguments: {} } },
    { async queryAll() { throw new Error("no"); } },
  );
  assert.equal(missingQuery.error.code, -32602);

  const boom = await handleMcpRpc(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_emails", arguments: {} } },
    { async queryAll() { throw new Error("d1 down"); } },
  );
  assert.equal(boom.error.code, -32603);
  assert.equal(boom.error.message, "internal error");
});

test("MCP HTTP auth runs before JSON parsing", async () => {
  const env = { MCP_TOKEN: "test-mcp-token", DB: { prepare() { throw new Error("db touched"); } } };
  const unauth = await handleFetch(
    new Request("https://example.test/mcp", { method: "POST", body: "{", headers: { "content-type": "application/json" } }),
    env,
  );
  assert.equal(unauth.status, 401);

  const wrong = await handleFetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
  );
  assert.equal(wrong.status, 401);

  const parsed = await handleFetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-mcp-token", "content-type": "application/json" },
      body: "{",
    }),
    env,
  );
  assert.equal(parsed.status, 400);
  assert.equal((await parsed.json()).error.code, -32700);

  const accepted = await handleFetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-mcp-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
    env,
  );
  assert.equal(accepted.status, 202);
  assert.equal(await accepted.text(), "");

  const type = await handleFetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-mcp-token", "content-type": "text/plain" },
      body: "{}",
    }),
    env,
  );
  assert.equal(type.status, 415);
});

test("unknown routes and methods", async () => {
  const env = { DB: { prepare() { throw new Error("no"); } } };
  const missing = await handleFetch(new Request("https://example.test/admin"), env);
  assert.equal(missing.status, 404);
  const healthPost = await handleFetch(new Request("https://example.test/health", { method: "POST" }), env);
  assert.equal(healthPost.status, 405);
});
