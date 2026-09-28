import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, {
  CACHE_TTL,
  INGEST_MAX_RETRIES,
  INGEST_RETRY_BASE_SEC,
  READ_REV_URL,
  RpcError,
  STATS_CACHE_URL,
  archiveEvent,
  assembleStats,
  assertAllowedDownloadUrl,
  buildAttachmentKey,
  buildFailureInsert,
  buildGetQuery,
  buildHealthQuery,
  buildInsertQuery,
  buildListQuery,
  buildSearchQuery,
  buildStatsQueries,
  canonicalBound,
  canonicalCacheRecord,
  decodeWebhookSecret,
  emailCacheDecision,
  getEmailCacheUrl,
  handleFetch,
  handleMcpRpc,
  handleQueue,
  hashCacheFields,
  isRetryableIngestError,
  likeContains,
  listCacheFields,
  listCacheUrl,
  mapEmailForStorage,
  parseEmailDate,
  r2CacheUrl,
  retryDelaySeconds,
  searchCacheFields,
  searchCacheUrl,
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
  const sent = [];
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
            const info = db.prepare(sql).run(...params);
            return { success: true, meta: { changes: info.changes } };
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
    INGEST_QUEUE: {
      async send(body) {
        sent.push(body);
      },
    },
  };
  return { db, bucket, env, sent };
}

function queueMessage(body, attempts = 1) {
  const ops = [];
  return {
    id: `msg-${attempts}-${ops.length}`,
    body,
    attempts,
    ack() {
      ops.push({ op: "ack" });
    },
    retry(options) {
      ops.push({ op: "retry", options });
    },
    ops,
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("webhook archives inbound mail once, then MCP can read it", async () => {
  const { db, bucket, env, sent } = sqliteEnv();
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
  assert.deepEqual(await first.json(), { ok: true, queued: true });
  assert.equal(calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    resend_id: EMAIL_ID,
    event_type: "email.received",
    received_at: "2026-09-28T06:15:24.000Z",
    svix_id: "msg_in",
  });

  const queued = queueMessage(sent[0], 1);
  await handleQueue({ queue: "mail-ingest", messages: [queued] }, env, { fetch: fetchImpl, nowMs: NOW_MS });
  assert.deepEqual(queued.ops, [{ op: "ack" }]);
  const callsAfterFirst = calls.length;
  assert.ok(callsAfterFirst > 0);

  const second = await post();
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { ok: true, queued: true });
  const replay = queueMessage(sent[1], 1);
  await handleQueue({ queue: "mail-ingest", messages: [replay] }, env, { fetch: fetchImpl, nowMs: NOW_MS });
  assert.deepEqual(replay.ops, [{ op: "ack" }]);
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
  const { db, env, sent } = sqliteEnv();
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
  assert.deepEqual(await ok.json(), { ok: true, ignored: true });
  assert.equal(fetched, false);
  assert.equal(sent.length, 0);
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
  assert.equal(sent.length, 0);

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
  const { db, env, sent } = sqliteEnv();
  let fetched = false;
  const fetchImpl = async (url) => {
    fetched = true;
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
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, queued: true });
  assert.equal(fetched, false);
  const message = queueMessage(sent[0], 1);
  await handleQueue({ queue: "mail-ingest", messages: [message] }, env, { fetch: fetchImpl, nowMs: NOW_MS });
  assert.deepEqual(message.ops, [{ op: "ack" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
  const failure = db.prepare("SELECT * FROM ingest_failures").get();
  assert.equal(failure.resend_id, EMAIL_ID);
  assert.match(failure.error, /unexpected download host/);
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

test("schema.sql can be applied twice and stores ingest failures", () => {
  const db = new DatabaseSync(":memory:");
  const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  db.exec(sql);
  db.exec(sql);
  const poison = "'; DROP TABLE emails; --";
  const insert = buildFailureInsert({
    resend_id: poison,
    event_type: "email.received",
    error: "Bearer secret-token resend 404",
    attempts: 2,
    failed_at: "2026-09-28T12:00:00.000Z",
  });
  assert.equal(insert.sql.includes(poison), false);
  assert.equal(insert.sql.includes("Bearer"), false);
  db.prepare(insert.sql).run(...insert.params);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
  const row = db.prepare("SELECT * FROM ingest_failures").get();
  assert.equal(row.resend_id, poison);
  assert.equal(row.event_type, "email.received");
  assert.equal(row.error, "Bearer [redacted] resend 404");
  assert.equal(row.attempts, 2);
  assert.equal(row.failed_at, "2026-09-28T12:00:00.000Z");
});

test("wrangler keeps production and staging queues apart", () => {
  const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
  assert.equal(toml.includes("whsec_"), false);
  assert.equal(/RESEND_API_KEY\s*=/.test(toml), false);
  assert.equal(/MCP_TOKEN\s*=/.test(toml), false);
  const parts = toml.split("\n[env.staging]\n");
  assert.equal(parts.length, 2);
  const [prod, staging] = parts;
  assert.match(prod, /database_id = "779058bf-f5c1-44de-b2c8-99350ec7748e"/);
  assert.match(prod, /binding = "ARCHIVE_BUCKET"/);
  assert.match(prod, /queue = "mail-ingest"/);
  assert.match(prod, /dead_letter_queue = "mail-ingest-dlq"/);
  assert.match(prod, /queue = "mail-ingest"\nmax_batch_size = 1\nmax_batch_timeout = 1\nmax_retries = 5/);
  assert.match(prod, /queue = "mail-ingest-dlq"\nmax_batch_size = 1\nmax_batch_timeout = 1\nmax_retries = 3/);
  assert.match(prod, /retry_delay = 60/);
  assert.match(prod, /max_batch_size = 1/);
  assert.equal(prod.includes("mail-ingest-staging"), false);
  assert.equal(staging.includes("779058bf-f5c1-44de-b2c8-99350ec7748e"), false);
  assert.match(staging, /name = "resend-agent-mail-relay-staging"/);
  assert.match(staging, /database_name = "abot-mail-archive-staging"/);
  assert.match(staging, /bucket_name = "abot-mail-archive-staging"/);
  assert.match(staging, /binding = "ARCHIVE_BUCKET"/);
  assert.match(staging, /queue = "mail-ingest-staging"/);
  assert.match(staging, /dead_letter_queue = "mail-ingest-staging-dlq"/);
  assert.equal(INGEST_MAX_RETRIES, 3);
  assert.equal(INGEST_RETRY_BASE_SEC, 60);
  assert.equal(retryDelaySeconds(1), 60);
  assert.equal(retryDelaySeconds(2), 120);
  assert.equal(retryDelaySeconds(3), 240);
});

function receivedEmailResponse(status = 200) {
  if (status !== 200) return new Response("no", { status });
  return jsonResponse({
    id: EMAIL_ID,
    from: "a@b.c",
    to: ["eric@abot.run"],
    subject: "queued",
    text: "hello queue",
    created_at: "2026-09-28T00:00:00.000Z",
    raw: { download_url: "https://cdn.resend.app/raw" },
  });
}

function ingestFetch({ apiStatus = 200, apiStatuses = null } = {}) {
  const statuses = apiStatuses ? [...apiStatuses] : null;
  return async (url) => {
    const href = String(url);
    if (href === `https://api.resend.com/emails/receiving/${EMAIL_ID}`) {
      const status = statuses ? statuses.shift() ?? 200 : apiStatus;
      return receivedEmailResponse(status);
    }
    if (href === "https://cdn.resend.app/raw") return new Response("Subject: queued\r\n\r\nhello\r\n", { status: 200 });
    if (href.startsWith(`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments`)) {
      return jsonResponse({ object: "list", has_more: false, data: [] });
    }
    throw new Error(`unexpected fetch ${href}`);
  };
}

test("webhook enqueues only signed mail events", async () => {
  const { db, env, sent } = sqliteEnv();
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error("webhook must not call Resend");
  };
  const event = { type: "email.received", created_at: "2026-09-28T06:15:24.000Z", data: { email_id: EMAIL_ID } };
  const res = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_q",
        "svix-timestamp": freshTimestamp(),
        "svix-signature": sign("msg_q", freshTimestamp(), JSON.stringify(event)),
      },
      body: JSON.stringify(event),
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, queued: true });
  assert.equal(fetched, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
  assert.equal(sent.length, 1);

  const sentEvent = { type: "email.sent", created_at: "2026-09-28T08:00:01.000Z", data: { email_id: "sent-1111-2222" } };
  const sentRaw = JSON.stringify(sentEvent);
  const sentTs = freshTimestamp();
  const sentRes = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_sent",
        "svix-timestamp": sentTs,
        "svix-signature": sign("msg_sent", sentTs, sentRaw),
      },
      body: sentRaw,
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(sentRes.status, 200);
  assert.equal((await sentRes.json()).queued, true);
  assert.equal(sent[1].event_type, "email.sent");
  assert.equal(sent[1].resend_id, "sent-1111-2222");

  const badId = { type: "email.received", created_at: "2026-09-28T06:15:24.000Z", data: { email_id: "../secret" } };
  const badRaw = JSON.stringify(badId);
  const badTs = freshTimestamp();
  const bad = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_bad_id",
        "svix-timestamp": badTs,
        "svix-signature": sign("msg_bad_id", badTs, badRaw),
      },
      body: badRaw,
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: "invalid email_id" });
  assert.equal(sent.length, 2);

  const missing = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: badRaw,
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(missing.status, 401);
  assert.equal(sent.length, 2);

  const huge = await handleFetch(
    new Request("https://example.test/", { method: "POST", body: "x".repeat(1_000_001) }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(huge.status, 413);
  assert.equal(sent.length, 2);
  assert.equal(fetched, false);

  env.INGEST_QUEUE = {
    async send() {
      throw new Error("queue unavailable");
    },
  };
  const failed = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_q",
        "svix-timestamp": freshTimestamp(),
        "svix-signature": sign("msg_q", freshTimestamp(), JSON.stringify(event)),
      },
      body: JSON.stringify(event),
    }),
    env,
    { fetch: fetchImpl, nowMs: NOW_MS },
  );
  assert.equal(failed.status, 500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
});

test("consumer retries transient failures, then archives once", async () => {
  const { db, bucket, env } = sqliteEnv();
  const fetchImpl = ingestFetch({ apiStatuses: [503, 200] });
  const body = {
    resend_id: EMAIL_ID,
    event_type: "email.received",
    received_at: "2026-09-28T00:00:01.000Z",
    svix_id: "msg_retry",
  };
  const first = queueMessage(body, 1);
  await handleQueue({ queue: "mail-ingest", messages: [first] }, env, { fetch: fetchImpl, nowMs: NOW_MS });
  assert.deepEqual(first.ops, [{ op: "retry", options: { delaySeconds: 60 } }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_failures").get().n, 0);

  const second = queueMessage(body, 2);
  await handleQueue({ queue: "mail-ingest", messages: [second] }, env, { fetch: fetchImpl, nowMs: NOW_MS });
  assert.deepEqual(second.ops, [{ op: "ack" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 1);
  assert.ok(bucket.has(`raw/${EMAIL_ID}.eml`));

  const third = queueMessage(body, 1);
  const callsBefore = db.prepare("SELECT COUNT(*) AS n FROM emails").get().n;
  let fetches = 0;
  const countingFetch = async (url, init) => {
    fetches += 1;
    return fetchImpl(url, init);
  };
  await handleQueue({ queue: "mail-ingest", messages: [third] }, env, { fetch: countingFetch, nowMs: NOW_MS });
  assert.deepEqual(third.ops, [{ op: "ack" }]);
  assert.equal(fetches, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, callsBefore);
});

test("consumer records permanent Resend 4xx and exhausted retries", async () => {
  const { db, env } = sqliteEnv();
  assert.equal(isRetryableIngestError(Object.assign(new Error("resend 404"), { status: 404, source: "resend" })), false);
  assert.equal(isRetryableIngestError(Object.assign(new Error("resend 429"), { status: 429, source: "resend" })), true);
  assert.equal(isRetryableIngestError(Object.assign(new Error("resend 503"), { status: 503, source: "resend" })), true);
  assert.equal(isRetryableIngestError(Object.assign(new Error("download 404"), { status: 404, source: "download" })), false);
  assert.equal(isRetryableIngestError(Object.assign(new Error("download 429"), { status: 429, source: "download" })), true);
  assert.equal(isRetryableIngestError(Object.assign(new Error("download 503"), { status: 503, source: "download" })), true);
  assert.equal(isRetryableIngestError(new TypeError("network timeout")), true);
  assert.equal(isRetryableIngestError(new Error("refusing unexpected download host")), false);

  const missing = queueMessage(
    { resend_id: EMAIL_ID, event_type: "email.received", received_at: "2026-09-28T00:00:01.000Z" },
    1,
  );
  await handleQueue(
    { queue: "mail-ingest", messages: [missing] },
    env,
    { fetch: ingestFetch({ apiStatus: 404 }), nowMs: NOW_MS },
  );
  assert.deepEqual(missing.ops, [{ op: "ack" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
  const notFound = db.prepare("SELECT * FROM ingest_failures").get();
  assert.equal(notFound.error, "resend 404");
  assert.equal(notFound.attempts, 1);
  assert.equal(notFound.event_type, "email.received");
  assert.equal(notFound.failed_at, new Date(NOW_MS).toISOString());

  const exhausted = queueMessage(
    { resend_id: EMAIL_ID, event_type: "email.received", received_at: "2026-09-28T00:00:01.000Z" },
    INGEST_MAX_RETRIES + 1,
  );
  await handleQueue(
    { queue: "mail-ingest", messages: [exhausted] },
    env,
    { fetch: ingestFetch({ apiStatus: 503 }), nowMs: NOW_MS },
  );
  assert.deepEqual(exhausted.ops, [{ op: "ack" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
  const dead = db.prepare("SELECT * FROM ingest_failures WHERE error = ?").get("resend 503");
  assert.equal(dead.attempts, INGEST_MAX_RETRIES + 1);
  assert.equal(dead.resend_id, EMAIL_ID);
});

test("poison queue messages are recorded and never fetched", async () => {
  const { db, env } = sqliteEnv();
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error("poison must not be fetched");
  };
  const samples = [
    null,
    ["email.received"],
    { event_type: "email.bounced", resend_id: EMAIL_ID },
    { event_type: "email.received", resend_id: "'; DROP TABLE emails; --" },
    { event_type: "email.received" },
  ];
  for (const body of samples) {
    const message = queueMessage(body, 1);
    await handleQueue({ queue: "mail-ingest", messages: [message] }, env, { fetch: fetchImpl, nowMs: NOW_MS });
    assert.deepEqual(message.ops, [{ op: "ack" }]);
  }
  assert.equal(fetched, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_failures").get().n, samples.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);
});

test("dead letter queue records the message without calling Resend", async () => {
  const { db, env } = sqliteEnv();
  let fetched = false;
  const message = queueMessage(
    { resend_id: EMAIL_ID, event_type: "email.received", received_at: "2026-09-28T00:00:01.000Z" },
    4,
  );
  await handleQueue({ queue: "mail-ingest-dlq", messages: [message] }, env, {
    fetch: async () => {
      fetched = true;
      throw new Error("dlq must not fetch");
    },
    nowMs: NOW_MS,
  });
  assert.equal(fetched, false);
  assert.deepEqual(message.ops, [{ op: "ack" }]);
  const row = db.prepare("SELECT * FROM ingest_failures").get();
  assert.equal(row.error, "retries exhausted");
  assert.equal(row.resend_id, EMAIL_ID);
  assert.equal(row.attempts, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);

  const staging = queueMessage({ resend_id: EMAIL_ID, event_type: "email.sent" }, 3);
  await handleQueue({ queue: "mail-ingest-staging-dlq", messages: [staging] }, env, { nowMs: NOW_MS });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_failures").get().n, 2);
});

test("a D1 outage while recording a failure is retried", async () => {
  const { env } = sqliteEnv();
  env.DB = {
    prepare() {
      throw new Error("d1 unavailable");
    },
  };
  const message = queueMessage({ resend_id: EMAIL_ID, event_type: "email.received" }, 2);
  await handleQueue({ queue: "mail-ingest-dlq", messages: [message] }, env, { nowMs: NOW_MS });
  assert.deepEqual(message.ops, [{ op: "retry", options: { delaySeconds: 120 } }]);
});

test("overlapping archive attempts still leave one email row", async () => {
  const { db, env } = sqliteEnv();
  const fetchImpl = ingestFetch();
  const event = { type: "email.received", created_at: "2026-09-28T00:00:01.000Z", data: { email_id: EMAIL_ID } };
  const [a, b] = await Promise.all([
    archiveEvent({ event, env, fetchImpl, nowMs: NOW_MS }),
    archiveEvent({ event, env, fetchImpl, nowMs: NOW_MS }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 1);
  assert.equal(db.prepare("SELECT text_body FROM emails").get().text_body, "hello queue");
});

test("worker queue handler is exported", async () => {
  assert.equal(typeof worker.fetch, "function");
  assert.equal(typeof worker.queue, "function");
  const { env } = sqliteEnv();
  await worker.queue({ queue: "mail-ingest", messages: [] }, env);
});

test("unknown routes and methods", async () => {
  const env = { DB: { prepare() { throw new Error("no"); } } };
  const missing = await handleFetch(new Request("https://example.test/admin"), env);
  assert.equal(missing.status, 404);
  const healthPost = await handleFetch(new Request("https://example.test/health", { method: "POST" }), env);
  assert.equal(healthPost.status, 405);
});

function memoryCache() {
  const store = new Map();
  const clock = { now: 0 };
  const cache = {
    puts: [],
    deletes: [],
    matches: [],
    advance(ms) {
      clock.now += ms;
    },
    async match(request) {
      const url = request.url;
      cache.matches.push({ url, method: request.method, authorization: request.headers.get("authorization") });
      const hit = store.get(url);
      if (!hit) return undefined;
      if (clock.now >= hit.expires) {
        store.delete(url);
        return undefined;
      }
      return new Response(hit.body, { status: 200, headers: hit.headers });
    },
    async put(request, response) {
      const url = request.url;
      const cacheControl = response.headers.get("cache-control") || "";
      const body = await response.text();
      cache.puts.push({
        url,
        method: request.method,
        authorization: request.headers.get("authorization"),
        cacheControl,
        status: response.status,
        body,
      });
      const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1]);
      if (response.status === 200 && Number.isFinite(maxAge) && maxAge > 0) {
        store.set(url, {
          body,
          expires: clock.now + maxAge * 1000,
          headers: {
            "content-type": response.headers.get("content-type") || "application/octet-stream",
            "cache-control": cacheControl,
          },
        });
      }
    },
    async delete(request) {
      cache.deletes.push(request.url);
      return store.delete(request.url);
    },
  };
  return cache;
}

function instrumentDb(env) {
  const sqls = [];
  const orig = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    sqls.push(sql);
    return orig(sql);
  };
  return {
    sqls,
    reset() {
      sqls.length = 0;
    },
  };
}

function instrumentBucket(env) {
  const keys = [];
  const orig = env.ARCHIVE_BUCKET.get.bind(env.ARCHIVE_BUCKET);
  env.ARCHIVE_BUCKET.get = async (key) => {
    keys.push(key);
    return orig(key);
  };
  return keys;
}

async function mcpCall(env, message, deps) {
  const res = await handleFetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-mcp-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
    }),
    env,
    deps,
  );
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    body: res.status === 202 ? null : await res.json(),
  };
}

function toolMessage(id, name, args) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function toolValue(rpc) {
  assert.equal(rpc.status, 200);
  assert.equal(rpc.body.error, undefined);
  return JSON.parse(rpc.body.result.content[0].text);
}

test("cache keys follow the phase-2 table and fresh is optional", async () => {
  assert.equal(emailCacheDecision(false, undefined).ai, "none");
  assert.equal(emailCacheDecision(false, null).cache, true);
  for (const status of ["ok", "failed", "skipped", "deferred"]) {
    assert.deepEqual(emailCacheDecision(true, status), { cache: true, ai: status });
  }
  assert.equal(emailCacheDecision(true, null).cache, false);
  assert.equal(emailCacheDecision(true, "pending").cache, false);
  assert.equal(emailCacheDecision(true, "").cache, false);

  assert.equal(
    getEmailCacheUrl(EMAIL_ID, true, false, "none"),
    `https://cache.internal/mcp/get?id=${EMAIL_ID}&html=1&raw=0&ai=none`,
  );
  assert.equal(r2CacheUrl(`raw/${EMAIL_ID}.eml`), `https://cache.internal/r2/raw/${EMAIL_ID}.eml`);
  assert.equal(
    r2CacheUrl(`attachments/${EMAIL_ID}/a.png`),
    `https://cache.internal/r2/attachments/${EMAIL_ID}/a.png`,
  );
  assert.equal(STATS_CACHE_URL, "https://cache.internal/mcp/stats");
  assert.equal(CACHE_TTL.getEmail, 86400);
  assert.equal(CACHE_TTL.r2, 604800);
  assert.equal(CACHE_TTL.search, 10);
  assert.equal(CACHE_TTL.list, 10);
  assert.equal(CACHE_TTL.stats, 120);

  const fields = searchCacheFields({
    query: "invoice",
    from: "a@b.c",
    to: "eric@abot.run",
    since: "2026-09-01",
    until: "2026-09-28T00:00:00.000Z",
    direction: "in",
    limit: 500,
  });
  const record = canonicalCacheRecord(fields);
  assert.deepEqual(
    record.split("\n").map((line) => line.split("=")[0]),
    ["direction", "from", "limit", "query", "since", "to", "until"],
  );
  assert.match(record, /^direction=in\nfrom=a@b\.c\nlimit=100\nquery=invoice\n/);
  assert.match(record, /since=2026-09-01T00:00:00\.000Z/);
  assert.equal(record.includes("fresh"), false);
  assert.equal(record.includes("cursor"), false);
  assert.equal(record.includes("token"), false);
  assert.equal(record.includes("Bearer"), false);
  const same = await hashCacheFields(searchCacheFields({ limit: 100, query: "invoice", from: "a@b.c", to: "eric@abot.run", since: "2026-09-01T00:00:00.000Z", until: "2026-09-28T00:00:00.000Z", direction: "in" }));
  assert.equal(await hashCacheFields(fields), same);
  assert.match(same, /^[0-9a-f]{64}$/);
  const listRecord = canonicalCacheRecord(listCacheFields({ limit: 20, direction: "out", since: "2026-09-15" }));
  assert.deepEqual(
    listRecord.split("\n").map((line) => line.split("=")[0]),
    ["direction", "limit", "since"],
  );
  assert.equal(listRecord.includes("cursor"), false);

  const plain = buildSearchQuery({ query: "a", limit: 5 });
  const withFresh = buildSearchQuery({ query: "a", limit: 5, fresh: true });
  assert.equal(plain.sql, withFresh.sql);
  assert.deepEqual(plain.params, withFresh.params);
  assert.throws(() => buildSearchQuery({ query: "a", fresh: "yes" }), (err) => err instanceof RpcError && err.code === -32602);
  assert.throws(() => buildListQuery({ cursor: "abc" }), (err) => err instanceof RpcError && err.code === -32602);
  assert.throws(() => buildGetQuery({ resend_id: EMAIL_ID, fresh: 1 }), (err) => err instanceof RpcError && err.code === -32602);

  const { env } = sqliteEnv();
  const cache = memoryCache();
  const listed = await mcpCall(env, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { cache, nowMs: NOW_MS });
  assert.equal(listed.status, 200);
  for (const tool of listed.body.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.fresh.type, "boolean");
    assert.equal((tool.inputSchema.required || []).includes("fresh"), false);
  }
  assert.equal(cache.puts.length, 0);
  assert.equal(cache.matches.length, 0);

  const skill = readFileSync(new URL("../skill/mail_archive.py", import.meta.url), "utf8");
  assert.match(skill, /d1\/database\/\{\}\/query/);
  assert.equal(skill.includes("cache.internal"), false);
  assert.equal(skill.includes("caches.default"), false);
});

test("MCP reads hit the cache and stay no-store", async () => {
  const { db, bucket, env } = sqliteEnv();
  const row = mapEmailForStorage(
    {
      id: EMAIL_ID,
      from: "alice@example.com",
      to: ["eric@abot.run"],
      subject: "invoice",
      text: "please pay",
      html: "<p>pay</p>",
      created_at: "2026-09-28T00:00:00.000Z",
    },
    {
      direction: "in",
      eventCreatedAt: "2026-09-28T00:00:00.000Z",
      attachments: [{ filename: "a.png", content_type: "image/png", size: 3, r2_key: `attachments/${EMAIL_ID}/a.png` }],
    },
  );
  const insert = buildInsertQuery(row);
  db.prepare(insert.sql).run(...insert.params);
  await env.ARCHIVE_BUCKET.put(`raw/${EMAIL_ID}.eml`, new TextEncoder().encode("Subject: invoice\r\n\r\nplease pay\r\n"));
  const sqls = instrumentDb(env);
  const r2Gets = instrumentBucket(env);
  const cache = memoryCache();
  const deps = { cache, nowMs: NOW_MS };

  const search = await mcpCall(env, toolMessage(1, "search_emails", { query: "invoice", limit: 500 }), deps);
  const searchRows = toolValue(search);
  assert.equal(searchRows.length, 1);
  assert.equal(searchRows[0].resend_id, EMAIL_ID);
  assert.equal("text_body" in searchRows[0], false);
  assert.equal(search.cacheControl, "no-store");
  const searchUrl = cache.puts.find((put) => put.url.startsWith("https://cache.internal/mcp/search?")).url;
  assert.equal(searchUrl, searchCacheUrl(await hashCacheFields(searchCacheFields({ query: "invoice", limit: 100 })), 0));
  assert.equal(cache.puts.find((put) => put.url === searchUrl).cacheControl, "max-age=10");
  assert.equal(cache.puts.find((put) => put.url === searchUrl).status, 200);
  assert.equal(cache.puts.find((put) => put.url === searchUrl).method, "GET");
  sqls.reset();
  const searchAgain = toolValue(await mcpCall(env, toolMessage(2, "search_emails", { limit: 100, query: "invoice" }), deps));
  assert.equal(searchAgain.length, 1);
  assert.equal(sqls.sqls.length, 0);
  sqls.reset();
  const other = toolValue(await mcpCall(env, toolMessage(3, "search_emails", { query: "missing" }), deps));
  assert.equal(other.length, 0);
  assert.equal(sqls.sqls.length, 1);

  sqls.reset();
  const listed = toolValue(await mcpCall(env, toolMessage(4, "list_emails", { direction: "in", since: "2026-09-01" }), deps));
  assert.equal(listed.length, 1);
  const listUrl = cache.puts.find((put) => put.url.startsWith("https://cache.internal/mcp/list?")).url;
  assert.equal(
    listUrl,
    listCacheUrl(await hashCacheFields(listCacheFields({ direction: "in", since: "2026-09-01" })), 0),
  );
  assert.equal(cache.puts.find((put) => put.url === listUrl).cacheControl, "max-age=10");
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(5, "list_emails", { since: "2026-09-01T00:00:00.000Z", direction: "in" }), deps));
  assert.equal(sqls.sqls.length, 0);

  sqls.reset();
  const stats = toolValue(await mcpCall(env, toolMessage(6, "email_stats", {}), deps));
  assert.equal(stats.total, 1);
  assert.equal(stats.by_direction.in, 1);
  assert.equal(cache.puts.filter((put) => put.url === STATS_CACHE_URL).length, 1);
  assert.equal(cache.puts.find((put) => put.url === STATS_CACHE_URL).cacheControl, "max-age=120");
  assert.equal(sqls.sqls.length, 4);
  sqls.reset();
  const statsAgain = toolValue(await mcpCall(env, toolMessage(7, "email_stats", {}), deps));
  assert.deepEqual(statsAgain, stats);
  assert.equal(sqls.sqls.length, 0);

  sqls.reset();
  const detail = toolValue(
    await mcpCall(env, toolMessage(8, "get_email", { resend_id: EMAIL_ID, include_html: false, include_raw_eml: false }), deps),
  );
  assert.equal(detail.found, true);
  assert.equal(detail.text_body, "please pay");
  assert.equal("html_body" in detail, false);
  assert.equal("raw_eml" in detail, false);
  assert.equal("ai_status" in detail, false);
  const plainUrl = getEmailCacheUrl(EMAIL_ID, false, false, "none");
  assert.equal(cache.puts.find((put) => put.url === plainUrl).cacheControl, "max-age=86400");
  sqls.reset();
  const plainAgain = toolValue(await mcpCall(env, toolMessage(9, "get_email", { resend_id: EMAIL_ID }), deps));
  assert.equal(plainAgain.text_body, "please pay");
  assert.equal(sqls.sqls.length, 0);
  assert.equal(r2Gets.length, 0);

  sqls.reset();
  const html = toolValue(await mcpCall(env, toolMessage(10, "get_email", { resend_id: EMAIL_ID, include_html: true }), deps));
  assert.match(html.html_body, /pay/);
  assert.ok(sqls.sqls.some((sql) => sql.includes("FROM emails")));
  const raw = toolValue(
    await mcpCall(env, toolMessage(11, "get_email", { resend_id: EMAIL_ID, include_raw_eml: true }), deps),
  );
  assert.match(raw.raw_eml, /Subject: invoice/);
  assert.equal(r2Gets.length, 1);
  assert.deepEqual(r2Gets, [`raw/${EMAIL_ID}.eml`]);
  const rawPut = cache.puts.find((put) => put.url === r2CacheUrl(`raw/${EMAIL_ID}.eml`));
  assert.equal(rawPut.cacheControl, "max-age=604800");
  assert.match(rawPut.body, /Subject: invoice/);
  const r2Before = r2Gets.length;
  sqls.reset();
  const rawHtml = toolValue(
    await mcpCall(
      env,
      toolMessage(12, "get_email", { resend_id: EMAIL_ID, include_html: true, include_raw_eml: true }),
      deps,
    ),
  );
  assert.match(rawHtml.html_body, /pay/);
  assert.match(rawHtml.raw_eml, /Subject: invoice/);
  assert.equal(r2Gets.length, r2Before);
  assert.equal(rawHtml.attachments[0].r2_key, `attachments/${EMAIL_ID}/a.png`);

  sqls.reset();
  const missing = toolValue(await mcpCall(env, toolMessage(13, "get_email", { resend_id: "missing-id" }), deps));
  assert.deepEqual(missing, { found: false, resend_id: "missing-id" });
  const readsAfterMiss = sqls.sqls.filter((sql) => sql.includes("FROM emails")).length;
  assert.equal(readsAfterMiss, 1);
  assert.equal(cache.puts.some((put) => put.url.includes("id=missing-id")), false);
  toolValue(await mcpCall(env, toolMessage(14, "get_email", { resend_id: "missing-id" }), deps));
  assert.equal(sqls.sqls.filter((sql) => sql.includes("FROM emails")).length, 2);

  for (const put of cache.puts) {
    assert.equal(put.authorization, null);
    assert.equal(put.cacheControl.includes("public"), false);
    assert.equal(put.cacheControl.includes("no-store"), false);
    assert.equal(put.url.includes("test-mcp-token"), false);
    assert.equal(put.url.includes("Bearer"), false);
  }
  for (const match of cache.matches) {
    assert.equal(match.method, "GET");
    assert.equal(match.authorization, null);
  }
});

test("fresh bypasses the cache and TTLs expire entries", async () => {
  const { db, env } = sqliteEnv();
  const cache = memoryCache();
  const deps = { cache, nowMs: NOW_MS };
  const sqls = instrumentDb(env);

  await cache.put(
    new Request(STATS_CACHE_URL),
    new Response(JSON.stringify({ total: 999, by_direction: { in: 0, out: 0 }, by_day: [], top_senders: [] }), {
      status: 200,
      headers: { "cache-control": "max-age=120", "content-type": "application/json" },
    }),
  );
  cache.puts.length = 0;
  const stale = toolValue(await mcpCall(env, toolMessage(1, "email_stats", {}), deps));
  assert.equal(stale.total, 999);
  assert.equal(sqls.sqls.length, 0);
  const fresh = toolValue(await mcpCall(env, toolMessage(2, "email_stats", { fresh: true }), deps));
  assert.equal(fresh.total, 0);
  assert.equal(sqls.sqls.length, 4);
  sqls.reset();
  const updated = toolValue(await mcpCall(env, toolMessage(3, "email_stats", { fresh: false }), deps));
  assert.equal(updated.total, 0);
  assert.equal(sqls.sqls.length, 0);

  const row = mapEmailForStorage(
    { id: "ttl-1", from: "a@b.c", to: ["eric@abot.run"], subject: "ttl", text: "body", created_at: "2026-09-28T00:00:00.000Z" },
    { direction: "in", eventCreatedAt: "2026-09-28T00:00:00.000Z", attachments: [] },
  );
  db.prepare(buildInsertQuery(row).sql).run(...buildInsertQuery(row).params);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(4, "search_emails", { query: "ttl" }), deps));
  cache.advance(9_000);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(5, "search_emails", { query: "ttl" }), deps));
  assert.equal(sqls.sqls.length, 0);
  cache.advance(2_000);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(6, "search_emails", { query: "ttl" }), deps));
  assert.equal(sqls.sqls.length, 1);

  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(7, "list_emails", { limit: 1 }), deps));
  cache.advance(9_000);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(8, "list_emails", { limit: 1 }), deps));
  assert.equal(sqls.sqls.length, 0);
  cache.advance(2_000);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(9, "list_emails", { limit: 1 }), deps));
  assert.equal(sqls.sqls.length, 1);

  cache.advance(CACHE_TTL.stats * 1000);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(10, "email_stats", {}), deps));
  assert.equal(sqls.sqls.length, 4);
  cache.advance(119_000);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(11, "email_stats", {}), deps));
  assert.equal(sqls.sqls.length, 0);
  cache.advance(2_000);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(12, "email_stats", {}), deps));
  assert.equal(sqls.sqls.length, 4);

  sqls.reset();
  const email = toolValue(await mcpCall(env, toolMessage(13, "get_email", { resend_id: "ttl-1" }), deps));
  assert.equal(email.text_body, "body");
  db.prepare("UPDATE emails SET text_body = ? WHERE resend_id = ?").run("changed", "ttl-1");
  sqls.reset();
  const cachedEmail = toolValue(await mcpCall(env, toolMessage(14, "get_email", { resend_id: "ttl-1" }), deps));
  assert.equal(cachedEmail.text_body, "body");
  assert.equal(sqls.sqls.length, 0);
  const refreshed = toolValue(await mcpCall(env, toolMessage(15, "get_email", { resend_id: "ttl-1", fresh: true }), deps));
  assert.equal(refreshed.text_body, "changed");
  cache.advance(CACHE_TTL.getEmail * 1000);
  sqls.reset();
  const expired = toolValue(await mcpCall(env, toolMessage(16, "get_email", { resend_id: "ttl-1" }), deps));
  assert.equal(expired.text_body, "changed");
  assert.ok(sqls.sqls.some((sql) => sql.includes("FROM emails")));
});

test("pending and null ai_status are not cached", async () => {
  const { db, env } = sqliteEnv();
  db.exec("ALTER TABLE emails ADD COLUMN ai_status TEXT");
  const row = mapEmailForStorage(
    { id: EMAIL_ID, from: "a@b.c", to: ["eric@abot.run"], subject: "ai", text: "first", created_at: "2026-09-28T00:00:00.000Z" },
    { direction: "in", eventCreatedAt: "2026-09-28T00:00:00.000Z", attachments: [] },
  );
  db.prepare(buildInsertQuery(row).sql).run(...buildInsertQuery(row).params);
  const cache = memoryCache();
  const deps = { cache, nowMs: NOW_MS };
  const sqls = instrumentDb(env);

  async function readsFor(status, text) {
    db.prepare("UPDATE emails SET ai_status = ?, text_body = ? WHERE resend_id = ?").run(status, text, EMAIL_ID);
    sqls.reset();
    const before = cache.puts.length;
    const first = toolValue(await mcpCall(env, toolMessage(1, "get_email", { resend_id: EMAIL_ID }), deps));
    const afterFirst = sqls.sqls.filter((sql) => sql.includes("FROM emails")).length;
    sqls.reset();
    const second = toolValue(await mcpCall(env, toolMessage(2, "get_email", { resend_id: EMAIL_ID }), deps));
    const afterSecond = sqls.sqls.filter((sql) => sql.includes("FROM emails")).length;
    return { first, second, afterFirst, afterSecond, puts: cache.puts.length - before };
  }

  const pending = await readsFor("pending", "first");
  assert.equal(pending.first.text_body, "first");
  assert.equal("ai_status" in pending.first, false);
  assert.equal(pending.afterFirst, 1);
  assert.equal(pending.afterSecond, 1);
  assert.equal(pending.puts, 0);

  const empty = await readsFor(null, "second");
  assert.equal(empty.first.text_body, "second");
  assert.equal(empty.afterSecond, 1);
  assert.equal(empty.puts, 0);

  const ok = await readsFor("ok", "third");
  assert.equal(ok.afterFirst, 1);
  assert.equal(ok.afterSecond, 0);
  assert.equal(ok.second.text_body, "third");
  assert.equal(ok.puts, 1);
  assert.equal(cache.puts.at(-1).url, getEmailCacheUrl(EMAIL_ID, false, false, "ok"));

  db.prepare("UPDATE emails SET ai_status = ?, text_body = ? WHERE resend_id = ?").run("failed", "fourth", EMAIL_ID);
  sqls.reset();
  const stale = toolValue(await mcpCall(env, toolMessage(3, "get_email", { resend_id: EMAIL_ID }), deps));
  assert.equal(stale.text_body, "third");
  assert.equal(sqls.sqls.filter((sql) => sql.includes("FROM emails")).length, 0);
  const live = toolValue(await mcpCall(env, toolMessage(4, "get_email", { resend_id: EMAIL_ID, fresh: true }), deps));
  assert.equal(live.text_body, "fourth");
  assert.equal(cache.puts.at(-1).url, getEmailCacheUrl(EMAIL_ID, false, false, "failed"));
});

test("a queued insert invalidates reads and fills R2 cache", async () => {
  const { db, env } = sqliteEnv();
  const cache = memoryCache();
  const sqls = instrumentDb(env);
  const r2Gets = instrumentBucket(env);
  const deps = { cache, nowMs: NOW_MS };

  toolValue(await mcpCall(env, toolMessage(1, "search_emails", { query: "hello" }), deps));
  toolValue(await mcpCall(env, toolMessage(2, "list_emails", {}), deps));
  const before = toolValue(await mcpCall(env, toolMessage(3, "email_stats", {}), deps));
  assert.equal(before.total, 0);

  const fetchImpl = async (url) => {
    const href = String(url);
    if (href === `https://api.resend.com/emails/receiving/${EMAIL_ID}`) return receivedEmailResponse();
    if (href === "https://cdn.resend.app/raw") return new Response("Subject: queued\r\n\r\nhello queue\r\n", { status: 200 });
    if (href.startsWith(`https://api.resend.com/emails/receiving/${EMAIL_ID}/attachments`)) {
      return jsonResponse({
        object: "list",
        has_more: false,
        data: [{ id: "att_1", filename: "a.png", content_type: "image/png", size: 3, download_url: "https://cdn.resend.app/file" }],
      });
    }
    if (href === "https://cdn.resend.app/file") return new Response("PNG", { status: 200 });
    throw new Error(`unexpected fetch ${href}`);
  };
  const message = queueMessage(
    { resend_id: EMAIL_ID, event_type: "email.received", received_at: "2026-09-28T00:00:01.000Z", svix_id: "msg_cache" },
    1,
  );
  await handleQueue({ queue: "mail-ingest", messages: [message] }, env, { fetch: fetchImpl, nowMs: NOW_MS, cache });
  assert.deepEqual(message.ops, [{ op: "ack" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 1);

  const rev = cache.puts.filter((put) => put.url === READ_REV_URL);
  assert.equal(rev.length, 1);
  assert.equal(rev[0].body, "1");
  assert.equal(rev[0].method, "GET");
  const rawKey = `raw/${EMAIL_ID}.eml`;
  const attachmentKey = `attachments/${EMAIL_ID}/a.png`;
  assert.ok(cache.puts.some((put) => put.url === r2CacheUrl(rawKey) && put.cacheControl === "max-age=604800"));
  assert.ok(cache.puts.some((put) => put.url === r2CacheUrl(attachmentKey) && put.body === "PNG"));
  const expectedDeletes = new Set([STATS_CACHE_URL]);
  for (const html of [false, true]) {
    for (const raw of [false, true]) {
      for (const ai of ["none", "ok", "failed", "skipped", "deferred"]) {
        expectedDeletes.add(getEmailCacheUrl(EMAIL_ID, html, raw, ai));
      }
    }
  }
  assert.deepEqual(new Set(cache.deletes), expectedDeletes);

  sqls.reset();
  const found = toolValue(await mcpCall(env, toolMessage(4, "search_emails", { query: "hello" }), deps));
  assert.equal(found.length, 1);
  assert.equal(found[0].resend_id, EMAIL_ID);
  assert.equal(sqls.sqls.length, 1);
  const listed = toolValue(await mcpCall(env, toolMessage(5, "list_emails", {}), deps));
  assert.equal(listed.length, 1);
  const stats = toolValue(await mcpCall(env, toolMessage(6, "email_stats", {}), deps));
  assert.equal(stats.total, 1);
  assert.equal(stats.by_direction.in, 1);

  sqls.reset();
  const email = toolValue(
    await mcpCall(env, toolMessage(7, "get_email", { resend_id: EMAIL_ID, include_raw_eml: true }), deps),
  );
  assert.match(email.raw_eml, /hello queue/);
  assert.equal(email.attachments[0].r2_key, attachmentKey);
  assert.equal(r2Gets.length, 0);
  sqls.reset();
  toolValue(await mcpCall(env, toolMessage(8, "get_email", { resend_id: EMAIL_ID, include_raw_eml: true }), deps));
  assert.equal(sqls.sqls.length, 0);
  assert.equal(r2Gets.length, 0);

  const deletesBeforeReplay = cache.deletes.length;
  const revPuts = cache.puts.filter((put) => put.url === READ_REV_URL).length;
  const replay = queueMessage(
    { resend_id: EMAIL_ID, event_type: "email.received", received_at: "2026-09-28T00:00:01.000Z" },
    1,
  );
  await handleQueue({ queue: "mail-ingest", messages: [replay] }, env, { fetch: fetchImpl, nowMs: NOW_MS, cache });
  assert.deepEqual(replay.ops, [{ op: "ack" }]);
  assert.equal(cache.deletes.length, deletesBeforeReplay);
  assert.equal(cache.puts.filter((put) => put.url === READ_REV_URL).length, revPuts);
  sqls.reset();
  const still = toolValue(await mcpCall(env, toolMessage(9, "email_stats", {}), deps));
  assert.equal(still.total, 1);
  assert.equal(sqls.sqls.length, 0);
});

test("unauthorized, health, webhook, and failed ingest do not write the cache", async () => {
  const { db, env } = sqliteEnv();
  const cache = memoryCache();
  const unauth = await handleFetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
    { cache, nowMs: NOW_MS },
  );
  assert.equal(unauth.status, 401);
  const wrong = await handleFetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "email_stats" }),
    }),
    env,
    { cache, nowMs: NOW_MS },
  );
  assert.equal(wrong.status, 401);

  const health = await handleFetch(new Request("https://example.test/health"), env, { cache, nowMs: NOW_MS });
  const healthAgain = await handleFetch(new Request("https://example.test/health"), env, { cache, nowMs: NOW_MS });
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(await health.json()).sort(), ["count_24h", "last_received_at", "ok"]);
  assert.equal(healthAgain.status, 200);

  const event = { type: "email.received", created_at: "2026-09-28T00:00:01.000Z", data: { email_id: EMAIL_ID } };
  const body = JSON.stringify(event);
  const queued = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_cache",
        "svix-timestamp": freshTimestamp(),
        "svix-signature": sign("msg_cache", freshTimestamp(), body),
      },
      body,
    }),
    env,
    { cache, nowMs: NOW_MS, fetch: async () => { throw new Error("webhook must not fetch"); } },
  );
  assert.equal(queued.status, 200);
  assert.deepEqual(await queued.json(), { ok: true, queued: true });
  const forged = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_bad",
        "svix-timestamp": freshTimestamp(),
        "svix-signature": "v1,aaaa",
      },
      body,
    }),
    env,
    { cache, nowMs: NOW_MS },
  );
  assert.equal(forged.status, 401);

  const failed = queueMessage({ resend_id: EMAIL_ID, event_type: "email.received" }, 1);
  await handleQueue({ queue: "mail-ingest", messages: [failed] }, env, {
    cache,
    nowMs: NOW_MS,
    fetch: ingestFetch({ apiStatus: 404 }),
  });
  assert.deepEqual(failed.ops, [{ op: "ack" }]);
  const dead = queueMessage({ resend_id: EMAIL_ID, event_type: "email.received" }, 4);
  await handleQueue({ queue: "mail-ingest-dlq", messages: [dead] }, env, { cache, nowMs: NOW_MS });
  assert.deepEqual(dead.ops, [{ op: "ack" }]);
  assert.equal(cache.puts.length, 0);
  assert.equal(cache.deletes.length, 0);
  assert.equal(cache.matches.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 0);

  const broken = memoryCache();
  broken.match = async () => {
    throw new Error("match down");
  };
  broken.put = async () => {
    throw new Error("put down");
  };
  const rpc = await handleMcpRpc(
    toolMessage(1, "email_stats", {}),
    {
      cache: broken,
      nowMs: NOW_MS,
      async queryAll(sql, params) {
        const out = await env.DB.prepare(sql).bind(...(params || [])).all();
        return out.results || [];
      },
    },
  );
  assert.equal(JSON.parse(rpc.result.content[0].text).total, 0);

  const throwing = memoryCache();
  throwing.put = async () => {
    throw new Error("put down");
  };
  throwing.delete = async () => {
    throw new Error("delete down");
  };
  const message = queueMessage(
    { resend_id: EMAIL_ID, event_type: "email.received", received_at: "2026-09-28T00:00:01.000Z" },
    1,
  );
  await handleQueue({ queue: "mail-ingest", messages: [message] }, env, {
    cache: throwing,
    nowMs: NOW_MS,
    fetch: ingestFetch(),
  });
  assert.deepEqual(message.ops, [{ op: "ack" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM emails").get().n, 1);
});

test("MCP cache fills through waitUntil when a context is present", async () => {
  const { env } = sqliteEnv();
  const cache = memoryCache();
  const originalPut = cache.put.bind(cache);
  let releasePut;
  const putBlock = new Promise((resolve) => {
    releasePut = resolve;
  });
  cache.put = async (request, response) => {
    await putBlock;
    return originalPut(request, response);
  };
  const pending = [];
  const ctx = {
    waitUntil(promise) {
      pending.push(promise);
    },
  };
  const firstPromise = mcpCall(env, toolMessage(1, "email_stats", {}), { cache, ctx, nowMs: NOW_MS });
  const first = await firstPromise;
  assert.equal(toolValue(first).total, 0);
  assert.equal(first.cacheControl, "no-store");
  assert.equal(cache.puts.length, 0);
  assert.equal(pending.length, 1);
  releasePut();
  await Promise.all(pending);
  assert.equal(cache.puts.length, 1);
  assert.equal(cache.puts[0].url, STATS_CACHE_URL);
  const sqls = instrumentDb(env);
  const second = toolValue(await mcpCall(env, toolMessage(2, "email_stats", {}), { cache, nowMs: NOW_MS }));
  assert.equal(second.total, 0);
  assert.equal(sqls.sqls.length, 0);
});
