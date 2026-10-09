// 安全回归：send_email 发件人与配额、MCP 只接受内部 host 和 owner。
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { bumpCounter, handleFetch, handleMcpRpc } from "../worker/worker.js";

const OWNER_A = "a@abot.run";
const OWNER_B = "b@abot.run";

function toolMessage(id, name, args) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}
function toolError(rpc) {
  assert.equal(rpc.type, "error");
  return rpc.error;
}
function toolOk(rpc) {
  assert.equal(rpc.type, "result", JSON.stringify(rpc));
  return JSON.parse(rpc.result.content[0].text);
}

function makeDeps(ownerEmail) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
  const deps = {
    ownerEmail,
    queryAll: async (sql, params) => db.prepare(sql).all(...(params || [])),
    queryFirst: async (sql, params) => db.prepare(sql).get(...(params || [])) ?? null,
    queryRun: async (sql, params) => {
      const info = db.prepare(sql).run(...(params || []));
      return { meta: { changes: info.changes } };
    },
  };
  return { db, deps };
}

test("send_email 发件人恒为绑定邮箱，无绑定时报错", async () => {
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
  };
  try {
    const { deps } = makeDeps(OWNER_A);
    deps.env = { RESEND_API_KEY: "re_test" };
    const v = toolOk(
      await handleMcpRpc(toolMessage(1, "send_email", { to: "x@example.com", subject: "s", body: "b" }), deps),
    );
    assert.equal(v.from, OWNER_A);
    assert.equal(v.to, "x@example.com");
    assert.equal(seen[0].from, OWNER_A, "发件人恒为绑定邮箱");

    const spoof = await handleMcpRpc(
      toolMessage(2, "send_email", { to: "x@example.com", subject: "s", body: "b", from: "evil@abot.run" }),
      deps,
    );
    assert.equal(toolError(spoof).code, -32602);
    assert.equal(seen.length, 1, "别人的 from 不得发出");

    const { deps: noOwner } = makeDeps(null);
    noOwner.env = { RESEND_API_KEY: "re_test" };
    const rpc = await handleMcpRpc(toolMessage(2, "send_email", { to: "x@example.com", subject: "s", body: "b" }), noOwner);
    assert.equal(toolError(rpc).code, -32001);
  } finally {
    globalThis.fetch = origFetch;
  }
});

async function withResend(fn) {
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `em_${seen.length}` }), { status: 200 });
  };
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = origFetch;
  }
}

test("send_email 校验收件人、主题和正文，非法输入不会发出", async () => {
  await withResend(async (seen) => {
    const { deps } = makeDeps(OWNER_A);
    deps.env = { RESEND_API_KEY: "re_test" };
    const send = (args) => handleMcpRpc(toolMessage(1, "send_email", { subject: "s", body: "b", ...args }), deps);
    const many = Array.from({ length: 11 }, (_, i) => `u${i}@example.com`).join(",");
    for (const to of [
      "not-an-address",
      "a@b",
      "x@example.com\r\nBcc: victim@example.com",
      "Evil <x@example.com>",
      "x@example.com;y@example.com",
      " , ",
      many,
      `${"a".repeat(250)}@example.com`,
    ]) {
      assert.equal(toolError(await send({ to })).code, -32602, to);
    }
    assert.equal(toolError(await send({ to: "x@example.com", subject: "a\r\nBcc: v@example.com" })).code, -32602);
    assert.equal(toolError(await send({ to: "x@example.com", subject: "s".repeat(999) })).code, -32602);
    assert.equal(toolError(await send({ to: "x@example.com", body: "b".repeat(100_001) })).code, -32602);
    assert.equal(seen.length, 0);

    const v = toolOk(await send({ to: "x@example.com, Y@example.com ,x@EXAMPLE.com" }));
    assert.deepEqual(v.to, ["x@example.com", "Y@example.com"]);
    assert.deepEqual(seen[0].to, ["x@example.com", "Y@example.com"]);
  });
});

test("send_email 按收件人数计每小时配额，超额直接拒绝且不调用 Resend", async () => {
  await withResend(async (seen) => {
    const { db, deps } = makeDeps(OWNER_A);
    deps.env = { RESEND_API_KEY: "re_test", SEND_HOURLY_LIMIT: "3" };
    deps.nowMs = Date.UTC(2026, 9, 4, 10, 15);
    const send = (to) => handleMcpRpc(toolMessage(1, "send_email", { to, subject: "s", body: "b" }), deps);
    toolOk(await send("a@example.com, b@example.com"));
    const over = toolError(await send("c@example.com, d@example.com"));
    assert.equal(over.code, -32003);
    assert.match(over.message, /3 recipients per hour/);
    toolOk(await send("c@example.com"));
    assert.equal(toolError(await send("e@example.com")).code, -32003);
    assert.equal(seen.length, 2);

    const other = { ...deps, ownerEmail: OWNER_B };
    toolOk(await handleMcpRpc(toolMessage(2, "send_email", { to: "z@example.com", subject: "s", body: "b" }), other));

    deps.nowMs += 3_600_000;
    toolOk(await send("e@example.com"));
    const hour = Math.floor(deps.nowMs / 3_600_000);
    const keys = db.prepare("SELECT k FROM rate_limits ORDER BY k").all().map((row) => row.k);
    assert.deepEqual(keys, [`send:${OWNER_A}:${hour}`], "过期窗口在新窗口创建时被清理");
  });
});

test("Resend 拒收时退回配额", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 });
  try {
    const { db, deps } = makeDeps(OWNER_A);
    deps.env = { RESEND_API_KEY: "re_test" };
    const err = toolError(await handleMcpRpc(toolMessage(1, "send_email", { to: "a@example.com, b@example.com", subject: "s", body: "b" }), deps));
    assert.equal(err.code, -32603);
    assert.match(err.message, /HTTP 403.*domain not verified/);
    assert.equal(db.prepare("SELECT count FROM rate_limits").get().count, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("send_email 配额表缺失时自动建表，配额存储不可用时拒绝发送", async () => {
  await withResend(async (seen) => {
    const { db, deps } = makeDeps(OWNER_A);
    deps.env = { RESEND_API_KEY: "re_test" };
    db.exec("DROP TABLE rate_limits");
    toolOk(await handleMcpRpc(toolMessage(1, "send_email", { to: "x@example.com", subject: "s", body: "b" }), deps));
    assert.equal(db.prepare("SELECT count FROM rate_limits").get().count, 1);

    deps.queryFirst = async () => {
      throw new Error("D1_ERROR: database unavailable");
    };
    const rpc = await handleMcpRpc(toolMessage(2, "send_email", { to: "x@example.com", subject: "s", body: "b" }), deps);
    assert.equal(toolError(rpc).code, -32603);
    assert.equal(seen.length, 1);
  });
});

test("bumpCounter 原子累加，同一 key 并发也不丢计数", async () => {
  const { db, deps } = makeDeps(OWNER_A);
  const counts = await Promise.all(Array.from({ length: 20 }, () => bumpCounter(deps, "k", 10, 1, 5)));
  assert.deepEqual([...counts].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(db.prepare("SELECT count FROM rate_limits WHERE k='k'").get().count, 20);
});

function mcpEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
  return {
    INTERNAL_TOKEN: "internal-secret",
    MCP_TOKEN: "mcp-secret",
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

function mcpPost(headers) {
  return new Request("https://backend.internal/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

test("/mcp 不校验 X-Internal-Token，合法 owner 即通过", async () => {
  const env = mcpEnv();
  for (const headers of [
    { "x-abot-owner-email": OWNER_A },
    { "x-internal-token": "wrong", "x-abot-owner-email": OWNER_A },
    { "x-internal-token": "internal-secret", "x-abot-owner-email": OWNER_A },
    { authorization: "Bearer nope", "x-abot-owner-email": OWNER_A },
  ]) {
    const r = await handleFetch(mcpPost(headers), env);
    assert.equal(r.status, 200, JSON.stringify(headers));
    const body = await r.json();
    assert.deepEqual(body.result.tools.map((tool) => tool.name), ["get_account", "send_email"]);
  }
});

test("/mcp 缺 owner 或格式非法被拒绝，token 不能代替", async () => {
  const env = mcpEnv();
  const missing = await handleFetch(mcpPost({}), env);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, "x-abot-owner-email required");
  const bearer = await handleFetch(mcpPost({ authorization: "Bearer mcp-secret" }), env);
  assert.equal(bearer.status, 401);
  const internal = await handleFetch(mcpPost({ "x-internal-token": "internal-secret" }), env);
  assert.equal(internal.status, 401);
  for (const bad of ["not-an-email", "a@evil.com", "a@abot.run.evil.com", ""]) {
    const r = await handleFetch(mcpPost({ "x-internal-token": "internal-secret", "x-abot-owner-email": bad }), env);
    assert.equal(r.status, 401, bad || "(empty)");
  }
});

test("/mcp 只接受 Service Binding 的内部 host，公网 host 带 owner 也是 404", async () => {
  const env = mcpEnv();
  for (const host of ["mail.abot.run", "resend-agent-mail-relay.eric9n-cf.workers.dev", "example.test"]) {
    const r = await handleFetch(
      new Request(`https://${host}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-abot-owner-email": OWNER_A },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    assert.equal(r.status, 404, host);
    assert.equal((await r.json()).error, "not found");
  }
  const internal = await handleFetch(mcpPost({ "x-abot-owner-email": OWNER_A }), env);
  assert.equal(internal.status, 200);
});

test("/mcp 每邮箱每分钟最多 100 次（D1 计数），其他邮箱不受影响", async () => {
  const env = { ...mcpEnv(), MCP_RATE_LIMIT: "1000" };
  const nowMs = Date.UTC(2026, 9, 4, 10, 15, 30);
  const statuses = [];
  for (let i = 0; i < 101; i++) {
    statuses.push((await handleFetch(mcpPost({ "x-abot-owner-email": "rl-a@abot.run" }), env, { nowMs })).status);
  }
  assert.ok(statuses.slice(0, 100).every((s) => s === 200));
  assert.equal(statuses[100], 429);
  const other = await handleFetch(mcpPost({ "x-abot-owner-email": "rl-b@abot.run" }), env, { nowMs });
  assert.equal(other.status, 200);
  const nextMinute = await handleFetch(mcpPost({ "x-abot-owner-email": "rl-a@abot.run" }), env, { nowMs: nowMs + 60_000 });
  assert.equal(nextMinute.status, 200);
});

test("归档工具不能再读写历史邮件", async () => {
  const { deps } = makeDeps(OWNER_A);
  for (const name of ["search_emails", "get_email", "delete_email", "get_attachment"]) {
    const rpc = await handleMcpRpc(toolMessage(1, name, { resend_id: "x", query: "q" }), deps);
    assert.equal(toolError(rpc).code, -32601, name);
  }
});
