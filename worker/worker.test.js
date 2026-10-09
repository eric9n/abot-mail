import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker, {
  decodeWebhookSecret,
  handleFetch,
  handleMcpRpc,
  timingSafeEqual,
  verifySvixSignature,
} from "./worker.js";

const SECRET_RAW = Buffer.from("unit-test-webhook-secret");
const WEBHOOK_SECRET = `whsec_${SECRET_RAW.toString("base64")}`;
const NOW_MS = Date.parse("2026-09-28T12:00:00.000Z");
const REMOVED_TOOLS = [
  "search_emails",
  "get_email",
  "list_emails",
  "email_stats",
  "set_email_read_status",
  "delete_email",
  "set_email_archived_status",
  "list_attachments",
  "get_attachment",
];

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
  assert.equal(ok.ok, true);
  const bad = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_1",
    svixTimestamp: ts,
    svixSignature: sign("msg_2", ts, body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad_signature");
});

test("verifySvixSignature rejects timestamps outside five minutes", async () => {
  const body = "{}";
  const ts = freshTimestamp(-(5 * 60 + 1));
  const verdict = await verifySvixSignature({
    secret: WEBHOOK_SECRET,
    svixId: "msg_old",
    svixTimestamp: ts,
    svixSignature: sign("msg_old", ts, body),
    rawBody: body,
    nowMs: NOW_MS,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "timestamp_out_of_range");
});

test("a signed webhook is ignored and does not touch the queue or Resend", async () => {
  const body = JSON.stringify({
    type: "email.received",
    created_at: "2026-09-28T12:00:00.000Z",
    data: { email_id: "abc-1" },
  });
  const ts = freshTimestamp(-15);
  const sent = [];
  let fetched = 0;
  const res = await handleFetch(
    new Request("https://mail.abot.run/", {
      method: "POST",
      headers: {
        "svix-id": "msg_1",
        "svix-timestamp": ts,
        "svix-signature": sign("msg_1", ts, body),
      },
      body,
    }),
    {
      WEBHOOK_SECRET,
      INGEST_QUEUE: { async send(message) { sent.push(message); } },
    },
    { nowMs: NOW_MS, fetch: async () => { fetched += 1; return new Response("no"); } },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ignored: true });
  assert.deepEqual(sent, []);
  assert.equal(fetched, 0);
});

test("a bad signature is rejected before the body is treated as mail", async () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "abc-1" } });
  const ts = freshTimestamp();
  const res = await handleFetch(
    new Request("https://mail.abot.run/", {
      method: "POST",
      headers: {
        "svix-id": "msg_1",
        "svix-timestamp": ts,
        "svix-signature": "v1,not-the-signature",
      },
      body,
    }),
    { WEBHOOK_SECRET },
    { nowMs: NOW_MS },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { ok: false, error: "unauthorized" });
});

test("health reports liveness only", async () => {
  const res = await handleFetch(new Request("https://mail.abot.run/health"), {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const post = await handleFetch(new Request("https://mail.abot.run/health", { method: "POST" }), {});
  assert.equal(post.status, 405);
});

test("MCP lists only account and send, and archive tools are unknown", async () => {
  const listed = await handleMcpRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { ownerEmail: "eric@abot.run" },
  );
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["get_account", "send_email"],
  );
  for (const name of REMOVED_TOOLS) {
    const rpc = await handleMcpRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: {} } },
      { ownerEmail: "eric@abot.run" },
    );
    assert.equal(rpc.type, "error");
    assert.equal(rpc.error.code, -32601, name);
  }
});

test("schema.sql only creates rate_limits and can be applied twice", () => {
  const db = new DatabaseSync(":memory:");
  const sql = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  db.exec(sql);
  db.exec(sql);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ["rate_limits"]);
});

test("wrangler no longer binds archive resources and still has no secrets", () => {
  const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
  assert.equal(toml.includes("whsec_"), false);
  assert.equal(/RESEND_API_KEY\s*=/.test(toml), false);
  assert.equal(/MCP_TOKEN\s*=/.test(toml), false);
  assert.equal(/INTERNAL_TOKEN\s*=/.test(toml), false);
  assert.match(toml, /x-abot-owner-email/);
  const parts = toml.split("\n[env.staging]\n");
  assert.equal(parts.length, 2);
  const [prod, staging] = parts;
  assert.match(prod, /database_id = "779058bf-f5c1-44de-b2c8-99350ec7748e"/);
  assert.equal(prod.includes("ARCHIVE_BUCKET"), false);
  assert.equal(prod.includes("mail-ingest"), false);
  assert.equal(prod.includes("[ai]"), false);
  assert.equal(prod.includes("[triggers]"), false);
  assert.equal(prod.includes("abot-mail-archive-staging"), false);
  assert.match(prod, /\[observability\]\nenabled = true\nhead_sampling_rate = 1/);
  assert.match(prod, /binding = "METRICS"\ndataset = "mail_metrics"/);
  assert.equal(staging.includes("779058bf-f5c1-44de-b2c8-99350ec7748e"), false);
  assert.match(staging, /name = "resend-agent-mail-relay-staging"/);
  assert.match(staging, /database_name = "abot-mail-archive-staging"/);
  assert.equal(staging.includes("ARCHIVE_BUCKET"), false);
  assert.equal(staging.includes("mail-ingest"), false);
  assert.equal(staging.includes("[env.staging.ai]"), false);
  assert.equal(staging.includes("[env.staging.triggers]"), false);
  assert.match(staging, /dataset = "mail_metrics_staging"/);
});

test("the worker export is fetch only", () => {
  assert.equal(typeof worker.fetch, "function");
  assert.equal(worker.queue, undefined);
  assert.equal(worker.scheduled, undefined);
});

test("unknown routes are not found", async () => {
  const res = await handleFetch(new Request("https://mail.abot.run/archive"), {});
  assert.equal(res.status, 404);
});
