/**
 * Local coverage for the remaining MCP tools.
 * No archive rows, no R2, no network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleFetch } from "../worker/worker.js";

const ALICE = "alice@abot.run";

function envWith(db) {
  return {
    RESEND_API_KEY: "re_test",
    DB: {
      prepare(sql) {
        const make = (params) => ({
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          first: async () => db.prepare(sql).get(...params) ?? null,
          run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...params).changes } }),
        });
        return { ...make([]), bind: (...params) => make(params) };
      },
    },
  };
}

function post(body, headers = {}) {
  return new Request("https://backend.internal/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-abot-owner-email": ALICE, ...headers },
    body: JSON.stringify(body),
  });
}

test("gateway MCP can read the account and send without storing mail", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
  const env = envWith(db);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "em_e2e" }), { status: 200 });
  };

  const listed = await handleFetch(
    post({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    env,
  );
  assert.equal(listed.status, 200);
  const names = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["get_account", "send_email"]);

  const account = await handleFetch(
    post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_account", arguments: {} } }),
    env,
  );
  const accountBody = await account.json();
  assert.deepEqual(JSON.parse(accountBody.result.content[0].text), { email: ALICE, domain: "abot.run" });

  const sent = await handleFetch(
    post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "send_email", arguments: { to: "a@example.com", subject: "hi", body: "there" } },
    }),
    env,
    { fetch: fetchImpl },
  );
  const sentBody = JSON.parse((await sent.json()).result.content[0].text);
  assert.equal(sentBody.id, "em_e2e");
  assert.equal(sentBody.from, ALICE);
  assert.equal(calls.length, 1);
  const sendRows = db.prepare("SELECT k, count FROM rate_limits WHERE k LIKE 'send:%'").all();
  assert.equal(sendRows.length, 1);
  assert.equal(sendRows[0].count, 1);

  const gone = await handleFetch(
    post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_emails", arguments: { query: "hi" } } }),
    env,
  );
  assert.equal((await gone.json()).error.code, -32601);
});
