// 缓存隔离安全测试：验证缓存 key 绑定 ownerEmail，且跨账户不能读到对方邮件正文。
// 运行：node --test test/cache-isolation.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  getEmailCacheUrl,
  searchCacheFields,
  listCacheFields,
  hashCacheFields,
  statsCacheUrl,
  cachedEmailBelongsToOwner,
  handleMcpRpc,
} from "../worker/worker.js";

const OWNER_A = "a@abot.run";
const OWNER_B = "b@abot.run";
const RESEND_ID = "re_test123";
const SECRET_BODY = "TOP-SECRET-BODY-FOR-A-ONLY";

// ---------- 单元测试：缓存 key 必须绑定 owner ----------

test("getEmailCacheUrl: 不同 owner 的 key 不同", () => {
  const ka = getEmailCacheUrl(RESEND_ID, false, false, "none", 7, OWNER_A);
  const kb = getEmailCacheUrl(RESEND_ID, false, false, "none", 7, OWNER_B);
  assert.notEqual(ka, kb, "不同 owner 必须产生不同的缓存 key");
  assert.ok(ka.includes(encodeURIComponent(OWNER_A)), "key 必须包含 owner");
});

test("getEmailCacheUrl: 相同 owner 的 key 相同（缓存仍有效）", () => {
  const k1 = getEmailCacheUrl(RESEND_ID, false, false, "none", 7, OWNER_A);
  const k2 = getEmailCacheUrl(RESEND_ID, false, false, "none", 7, OWNER_A);
  assert.equal(k1, k2);
});

test("search/list: 不同 owner 的 hash 不同", async () => {
  const ha = await hashCacheFields(searchCacheFields({ query: "hello" }, OWNER_A));
  const hb = await hashCacheFields(searchCacheFields({ query: "hello" }, OWNER_B));
  assert.notEqual(ha, hb, "search hash 必须绑定 owner");
  const la = await hashCacheFields(listCacheFields({}, OWNER_A));
  const lb = await hashCacheFields(listCacheFields({}, OWNER_B));
  assert.notEqual(la, lb, "list hash 必须绑定 owner");
});

test("statsCacheUrl: 不同 owner 的 key 不同", () => {
  const sa = statsCacheUrl(7, OWNER_A);
  const sb = statsCacheUrl(7, OWNER_B);
  assert.notEqual(sa, sb, "stats key 必须绑定 owner");
});

test("cachedEmailBelongsToOwner: 归属校验", () => {
  const cachedA = { found: true, from: "sender@example.com", to: [OWNER_A], subject: "hi" };
  assert.equal(cachedEmailBelongsToOwner(cachedA, OWNER_A), true, "自己的缓存应通过");
  assert.equal(cachedEmailBelongsToOwner(cachedA, OWNER_B), false, "他人的缓存必须拒绝");
  assert.equal(cachedEmailBelongsToOwner({ found: false }, OWNER_B), true, "found:false 视为 miss");
  assert.equal(cachedEmailBelongsToOwner(cachedA, null), true, "系统级调用无隔离");
  const cachedFrom = { found: true, direction: "out", from: OWNER_A, to: [] };
  assert.equal(cachedEmailBelongsToOwner(cachedFrom, OWNER_A), true, "自己发出的信应通过");
  assert.equal(cachedEmailBelongsToOwner(cachedFrom, OWNER_B), false, "发件人不是 B，B 必须拒绝");
  const spoofed = { found: true, direction: "in", from: OWNER_A, to: ["x@example.com"] };
  assert.equal(cachedEmailBelongsToOwner(spoofed, OWNER_A), false, "收件的 From 头不能证明归属");
});

// ---------- 集成测试：模拟完整调用链，复现并验证漏洞已修复 ----------

function makeCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const v = store.get(req.url);
      return v ? v.clone() : undefined;
    },
    async put(req, res) {
      store.set(req.url, res.clone());
    },
    async delete(req) {
      return store.delete(req.url);
    },
  };
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) {
      pending.push(Promise.resolve(p));
    },
    async flush() {
      await Promise.all(pending.splice(0));
    },
  };
}

// 模拟 DB：只存一封属于 OWNER_A 的邮件；按真实 SQL 的归属规则过滤
const EMAIL_ROW = {
  resend_id: RESEND_ID,
  direction: "inbound",
  msg_from: "sender@example.com",
  msg_to: JSON.stringify([OWNER_A]),
  cc: "[]",
  subject: "secret",
  date: "2026-10-02T10:00:00Z",
  message_id: "m1",
  has_text: 1,
  has_html: 0,
  attachments: "[]",
  created_at: "2026-10-02T10:00:00Z",
  text_body: SECRET_BODY,
  html_body: null,
  summary: null,
};

function makeDeps(ownerEmail, cache, ctx) {
  const belongs = (row) =>
    row.msg_from === ownerEmail || (row.msg_to && row.msg_to.includes('"' + ownerEmail + '"'));
  return {
    ownerEmail,
    cache,
    ctx,
    ai: null,
    nowMs: Date.now(),
    trace: {},
    summaryTimeoutMs: 1000,
    async queryFirst(sql, params) {
      if (sql.includes("pragma_table_info")) return null;
      return { rev: 7 };
    },
    async queryAll(sql, params) {
      if (sql.includes("pragma_table_info")) return [];
      if (sql.startsWith("SELECT summary FROM emails")) return [];
      if (sql.includes("FROM emails")) {
        // 模拟真实 WHERE：resend_id 匹配 + 归属过滤 + 未删除
        if (params[0] !== RESEND_ID) return [];
        if (!belongs(EMAIL_ROW)) return [];
        return [EMAIL_ROW];
      }
      return [];
    },
    async queryRun() {
      return {};
    },
    async getObjectText() {
      return null;
    },
  };
}

function getEmailMsg(resendId) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_email", arguments: { resend_id: resendId } },
  };
}

function resultBody(rpc) {
  assert.equal(rpc.type, "result");
  return JSON.parse(rpc.result.content[0].text);
}

test("跨账户：B 不能读到 A 缓存的邮件正文", async () => {
  const cache = makeCache();
  const ctxA = makeCtx();
  const depsA = makeDeps(OWNER_A, cache, ctxA);
  // A 先读：DB 命中，写入缓存
  const ra = await handleMcpRpc(getEmailMsg(RESEND_ID), depsA);
  await ctxA.flush();
  const bodyA = resultBody(ra);
  assert.equal(bodyA.found, true);
  assert.equal(bodyA.text_body, SECRET_BODY);
  assert.ok(cache.store.size > 0, "A 的读取应写入缓存");

  // B 读同一封：缓存 key 已隔离 → miss → DB 归属过滤 → found:false
  const ctxB = makeCtx();
  const depsB = makeDeps(OWNER_B, cache, ctxB);
  const rb = await handleMcpRpc(getEmailMsg(RESEND_ID), depsB);
  await ctxB.flush();
  const bodyB = resultBody(rb);
  assert.equal(bodyB.found, false, "B 不应看到 A 的邮件");
  assert.ok(
    !JSON.stringify(bodyB).includes(SECRET_BODY),
    "B 的响应中绝不能出现 A 的正文",
  );
});

test("同账户：缓存命中仍有效", async () => {
  const cache = makeCache();
  const ctx = makeCtx();
  const deps = makeDeps(OWNER_A, cache, ctx);
  await handleMcpRpc(getEmailMsg(RESEND_ID), deps);
  await ctx.flush();
  const sizeAfterFirst = cache.store.size;
  assert.ok(sizeAfterFirst > 0);
  // 第二次：应命中自己 owner 的缓存
  const r2 = await handleMcpRpc(getEmailMsg(RESEND_ID), deps);
  await ctx.flush();
  const body2 = resultBody(r2);
  assert.equal(body2.found, true);
  assert.equal(body2.text_body, SECRET_BODY);
  assert.equal(cache.store.size, sizeAfterFirst, "不应产生新的缓存条目");
});
