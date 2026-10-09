import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { signSvix } from "./run.mjs";
import { handleFetch, verifySvixSignature } from "../worker/worker.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("e2e signer matches the worker verifier", async () => {
  const secret = `whsec_${Buffer.from("unit-test-webhook-secret").toString("base64")}`;
  const body = JSON.stringify({ type: "email.received", data: { email_id: "abc-1" } });
  const nowMs = Date.parse("2026-09-28T12:00:00.000Z");
  const timestamp = String(Math.floor(nowMs / 1000) - 15);
  const signature = signSvix({ secret, svixId: "msg_e2e", timestamp, body });
  const verdict = await verifySvixSignature({
    secret,
    svixId: "msg_e2e",
    svixTimestamp: timestamp,
    svixSignature: signature,
    rawBody: body,
    nowMs,
  });
  assert.equal(verdict.ok, true);

  const expiredTs = String(Math.floor(nowMs / 1000) - 5 * 60 - 1);
  const expired = await verifySvixSignature({
    secret,
    svixId: "msg_old",
    svixTimestamp: expiredTs,
    svixSignature: signSvix({ secret, svixId: "msg_old", timestamp: expiredTs, body }),
    rawBody: body,
    nowMs,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "timestamp_out_of_range");
});

test("e2e signer is accepted by the worker webhook and nothing is queued", async () => {
  const secret = `whsec_${Buffer.from("unit-test-webhook-secret").toString("base64")}`;
  const body = JSON.stringify({
    type: "email.received",
    created_at: "2026-09-28T12:00:00.000Z",
    data: { email_id: "abc-1" },
  });
  const nowMs = Date.parse("2026-09-28T12:00:00.000Z");
  const timestamp = String(Math.floor(nowMs / 1000) - 15);
  const sent = [];
  const res = await handleFetch(
    new Request("https://example.test/", {
      method: "POST",
      headers: {
        "svix-id": "msg_e2e",
        "svix-timestamp": timestamp,
        "svix-signature": signSvix({ secret, svixId: "msg_e2e", timestamp, body }),
      },
      body,
    }),
    {
      WEBHOOK_SECRET: secret,
      INGEST_QUEUE: {
        async send(message) {
          sent.push(message);
        },
      },
    },
    { nowMs },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ignored: true });
  assert.deepEqual(sent, []);
});

test("e2e exits non-zero when credentials are missing", () => {
  const res = spawnSync(process.execPath, ["e2e/run.mjs"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /WORKER_URL/);
  assert.match(res.stderr, /WEBHOOK_SECRET/);
  assert.match(res.stderr, /MCP_URL/);
  assert.match(res.stderr, /MCP_TOKEN/);

  const partial = spawnSync(process.execPath, ["e2e/run.mjs"], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, WORKER_URL: "https://example.test" },
    encoding: "utf8",
  });
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /WEBHOOK_SECRET/);
  assert.doesNotMatch(partial.stderr, /missing required environment variable\(s\): WORKER_URL/);
});
