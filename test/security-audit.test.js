// 安全审计回归测试：附件路径遍历、变更操作归属校验、send_email 发件人、
// 内部鉴权时序安全、ownerEmail 格式校验、真实 base64 附件。
// 运行：node --test test/security-audit.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  handleMcpRpc,
  handleFetch,
  likeContains,
  buildGetQuery,
} from "../worker/worker.js";

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

// 真实 sqlite 支撑的 deps（含 R2 桶 fake）
function makeDeps(ownerEmail) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
  const bucket = new Map(); // key -> Uint8Array
  const wrap = {
    queryAll: async (sql, params) => db.prepare(sql).all(...(params || [])),
    queryFirst: async (sql, params) => db.prepare(sql).get(...(params || [])) ?? null,
    queryRun: async (sql, params) => {
      const info = db.prepare(sql).run(...(params || []));
      return { success: true, meta: { changes: info.changes } };
    },
    getObjectText: async (key) => {
      const b = bucket.get(key);
      return b ? new TextDecoder().decode(b) : null;
    },
    getObjectBytes: async (key) => {
      const b = bucket.get(key);
      return b ? Uint8Array.from(b) : null;
    },
    ownerEmail,
    nowMs: Date.now(),
    trace: {},
    env: {},
  };
  return { db, bucket, deps: wrap };
}

function seedEmail(db, { resendId, from, to }) {
  db.prepare(
    `INSERT INTO emails (resend_id, direction, msg_from, msg_to, subject, date, text_body, attachments)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    resendId, "in", from, JSON.stringify(to), "subj", "2026-10-02T10:00:00Z", "body",
    JSON.stringify([{ filename: "report.pdf", content_type: "application/pdf", size: 4, r2_key: `attachments/${resendId}/report.pdf` }]),
  );
}

// ---------- 1. get_attachment 路径遍历 ----------

test("get_attachment 拒绝路径遍历文件名", async () => {
  const { db, deps } = makeDeps(OWNER_A);
  seedEmail(db, { resendId: "re1", from: "x@example.com", to: [OWNER_A] });
  for (const evil of ["../../raw/other.eml", "a/b.pdf", "..\\win.pdf", ".."]) {
    const rpc = await handleMcpRpc(toolMessage(1, "get_attachment", { resend_id: "re1", filename: evil }), deps);
    assert.equal(toolError(rpc).code, -32602, evil);
  }
});

test("get_attachment 要求文件名与记录精确匹配", async () => {
  const { db, bucket, deps } = makeDeps(OWNER_A);
  seedEmail(db, { resendId: "re1", from: "x@example.com", to: [OWNER_A] });
  bucket.set("attachments/re1/report.pdf", new Uint8Array([1, 2, 3, 4]));
  // 猜一个同目录下不存在的文件名
  const rpc = await handleMcpRpc(toolMessage(1, "get_attachment", { resend_id: "re1", filename: "other.pdf" }), deps);
  assert.equal(toolError(rpc).code, -32602);
  assert.match(toolError(rpc).message, /attachment not found/);
});

test("get_attachment 跨账户被拒绝", async () => {
  const { db, bucket } = makeDeps(OWNER_A);
  seedEmail(db, { resendId: "re1", from: "x@example.com", to: [OWNER_A] });
  bucket.set("attachments/re1/report.pdf", new Uint8Array([1, 2, 3, 4]));
  const { deps } = makeDeps(OWNER_B);
  // B 用自己的 deps（空库）查 A 的邮件
  const rpc = await handleMcpRpc(toolMessage(1, "get_attachment", { resend_id: "re1", filename: "report.pdf" }), deps);
  assert.equal(toolError(rpc).code, -32602);
});

test("get_attachment 返回真实 base64（二进制往返）", async () => {
  const { db, bucket, deps } = makeDeps(OWNER_A);
  seedEmail(db, { resendId: "re1", from: "x@example.com", to: [OWNER_A] });
  const raw = new Uint8Array([0, 255, 16, 32, 200, 1]);
  bucket.set("attachments/re1/report.pdf", raw);
  const v = toolOk(await handleMcpRpc(toolMessage(1, "get_attachment", { resend_id: "re1", filename: "report.pdf" }), deps));
  const back = Uint8Array.from(atob(v.content_base64), (ch) => ch.charCodeAt(0));
  assert.deepEqual(back, raw);
});

// ---------- 2. 变更操作：不存在/他人邮件必须报错 ----------

for (const [tool, args] of [
  ["set_email_read_status", { resend_id: "nope", is_read: true }],
  ["delete_email", { resend_id: "nope" }],
  ["set_email_archived_status", { resend_id: "nope", is_archived: true }],
]) {
  test(`${tool} 对不存在的邮件报错`, async () => {
    const { deps } = makeDeps(OWNER_A);
    const rpc = await handleMcpRpc(toolMessage(1, tool, args), deps);
    assert.equal(toolError(rpc).code, -32602);
  });
}

test("变更操作不能动他人的邮件", async () => {
  const { db } = makeDeps(OWNER_A);
  seedEmail(db, { resendId: "reA", from: "x@example.com", to: [OWNER_A] });
  const q = (ownerEmail) => ({
    queryAll: async (sql, params) => db.prepare(sql).all(...(params || [])),
    queryFirst: async (sql, params) => db.prepare(sql).get(...(params || [])) ?? null,
    queryRun: async (sql, params) => {
      const info = db.prepare(sql).run(...(params || []));
      return { success: true, meta: { changes: info.changes } };
    },
    ownerEmail,
    nowMs: Date.now(),
    trace: {},
    env: {},
  });
  for (const [tool, args] of [
    ["set_email_read_status", { resend_id: "reA", is_read: true }],
    ["delete_email", { resend_id: "reA" }],
    ["set_email_archived_status", { resend_id: "reA", is_archived: true }],
  ]) {
    const rpc = await handleMcpRpc(toolMessage(1, tool, args), q(OWNER_B));
    assert.equal(toolError(rpc).code, -32602, tool);
  }
  // A 自己操作成功
  const ok = toolOk(await handleMcpRpc(toolMessage(1, "set_email_read_status", { resend_id: "reA", is_read: true }), q(OWNER_A)));
  assert.equal(ok.is_read, true);
  assert.equal(db.prepare("SELECT is_read AS r FROM emails WHERE resend_id='reA'").get().r, 1);
});

// ---------- 3. send_email ----------

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

// ---------- 4. ownerEmail LIKE 通配符转义 ----------

test("ownerEmail 中的 LIKE 通配符被转义", () => {
  const q = buildGetQuery({ resend_id: "re1" }, { ownerEmail: "a%b_c@abot.run" });
  const likeParam = q.params[q.params.length - 1];
  assert.ok(likeParam.includes("\\%"), "百分号必须转义: " + likeParam);
  assert.ok(likeParam.includes("\\_"), "下划线必须转义: " + likeParam);
  assert.equal(likeContains("100%_"), "%100\\%\\_%");
});

// ---------- 5. /mcp 鉴权 ----------

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
    assert.ok(body.result.tools.length > 0);
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

function gatewayEnv(handler) {
  const calls = [];
  return {
    calls,
    env: {
      GATEWAY: {
        async fetch(url, init) {
          calls.push({ url, init });
          return handler(url, init);
        },
      },
    },
  };
}

test("/signup 转发到 abot-gateway，不在本 Worker 建表或核对邀请码", async () => {
  const { env, calls } = gatewayEnv(() => Response.json({ id: "prov_1", status: "pending" }));
  const r = await handleFetch(
    new Request("https://mail.abot.run/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite_code: " inv_x ", agent_name: "bot", reason: "r", requested_email: "Bot@abot.run" }),
    }),
    env,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, id: "prov_1", status: "pending", message: "等待人工审核" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://abot-gateway/provision/request");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    invite_code: "inv_x",
    agent_name: "bot",
    reason: "r",
    requested_email: "bot@abot.run",
  });
});

test("/signup 本地拒绝缺邀请码和非法邮箱，网关错误原样带回状态码", async () => {
  const { env, calls } = gatewayEnv(() => Response.json({ error: "invite_code_used" }, { status: 403 }));
  const post = (body) =>
    handleFetch(
      new Request("https://mail.abot.run/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ invite_code: "inv", requested_email: "x@evil.com" })).status, 400);
  assert.equal(calls.length, 0);
  const used = await post({ invite_code: "inv" });
  assert.equal(used.status, 403);
  assert.equal((await used.json()).error, "invite_code_used");
  const missing = await handleFetch(
    new Request("https://mail.abot.run/signup", { method: "POST", body: JSON.stringify({ invite_code: "inv" }) }),
    {},
  );
  assert.equal(missing.status, 500);
  assert.equal((await missing.json()).error, "gateway_binding_missing");
});

test("/provision/status 转发到 abot-gateway 并返回状态", async () => {
  const { env, calls } = gatewayEnv((url) =>
    url.endsWith("id=prov_1")
      ? Response.json({ id: "prov_1", status: "approved", email: "bot@abot.run" })
      : Response.json({ error: "not_found" }, { status: 404 }),
  );
  const ok = await handleFetch(new Request("https://mail.abot.run/provision/status?id=prov_1"), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, id: "prov_1", status: "approved", email: "bot@abot.run" });
  const missing = await handleFetch(new Request("https://mail.abot.run/provision/status?id=a%26b"), env);
  assert.equal(missing.status, 404);
  assert.equal(calls[1].url, "https://abot-gateway/provision/status?id=a%26b");
});
