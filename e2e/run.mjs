/**
 * Live gate against a deployed archive worker.
 * Reads WORKER_URL, WEBHOOK_SECRET, MCP_TOKEN, TEST_EMAIL_ID.
 * Missing variables fail the process; they never count as a pass.
 *
 * The only write is an idempotent archive of TEST_EMAIL_ID. Point WORKER_URL
 * at the staging worker so this does not touch the production D1 database.
 */

import { createHmac, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED_ENV = ["WORKER_URL", "WEBHOOK_SECRET", "MCP_TOKEN", "TEST_EMAIL_ID"];

export function signSvix({ secret, svixId, timestamp, body }) {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) {
    throw new Error("WEBHOOK_SECRET must start with whsec_");
  }
  const b64 = secret.slice("whsec_".length).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const key = Buffer.from(b64 + pad, "base64");
  return `v1,${createHmac("sha256", key).update(`${svixId}.${timestamp}.${body}`).digest("base64")}`;
}

function missingEnv() {
  return REQUIRED_ENV.filter((key) => !process.env[key] || !String(process.env[key]).trim());
}

function endpoint(base, path) {
  const trimmed = base.replace(/\/+$/, "");
  return path === "/" ? `${trimmed}/` : `${trimmed}${path}`;
}

function snippet(text) {
  let out = String(text ?? "");
  for (const key of ["MCP_TOKEN", "WEBHOOK_SECRET"]) {
    const secret = process.env[key];
    if (secret) out = out.replaceAll(secret, "[redacted]");
  }
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, { method = "GET", headers = {}, body, timeoutMs = 30000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function assertHttp(res, status, label) {
  if (res.status !== status) {
    const hint =
      res.status === 500
        ? " Confirm TEST_EMAIL_ID is an existing received email and the worker RESEND_API_KEY can read it."
        : "";
    throw new Error(`${label}: expected HTTP ${status}, got ${res.status}: ${snippet(res.text)}.${hint}`);
  }
}

export async function main() {
  const missing = missingEnv();
  if (missing.length) {
    console.error(`e2e: missing required environment variable(s): ${missing.join(", ")}`);
    console.error("Required: WORKER_URL, WEBHOOK_SECRET (whsec_…), MCP_TOKEN, TEST_EMAIL_ID (an existing Resend received email id).");
    console.error("Refusing to pass without them.");
    return 1;
  }

  const workerUrl = process.env.WORKER_URL.trim();
  const webhookSecret = process.env.WEBHOOK_SECRET.trim();
  const mcpToken = process.env.MCP_TOKEN.trim();
  const emailId = process.env.TEST_EMAIL_ID.trim();

  let parsedUrl;
  try {
    parsedUrl = new URL(workerUrl);
  } catch {
    console.error(`e2e: WORKER_URL is not a URL: ${workerUrl}`);
    return 1;
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    console.error("e2e: WORKER_URL must be http or https");
    return 1;
  }
  if (!webhookSecret.startsWith("whsec_")) {
    console.error("e2e: WEBHOOK_SECRET must start with whsec_");
    return 1;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(emailId) || emailId.includes("..")) {
    console.error("e2e: TEST_EMAIL_ID must be a Resend id (letters, digits, '.', '_', '-')");
    return 1;
  }

  const root = endpoint(workerUrl, "/");
  const mcpUrl = endpoint(workerUrl, "/mcp");
  const healthUrl = endpoint(workerUrl, "/health");
  const ctx = { email: null, totalAfterArchive: null, delivery: null };
  const results = [];

  async function runCase(id, title, fn) {
    try {
      await fn();
      results.push({ id, title, ok: true });
      console.log(`PASS  ${id}  ${title}`);
    } catch (err) {
      const message = err && err.name === "TimeoutError" ? `${title}: request timed out` : err.message || String(err);
      results.push({ id, title, ok: false, message });
      console.error(`FAIL  ${id}  ${title}`);
      console.error(`      ${message}`);
    }
  }

  function postWebhook(body, headers, timeoutMs = 60000) {
    return request(root, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      timeoutMs,
    });
  }

  function signedHeaders(svixId, timestamp, body) {
    return {
      "svix-id": svixId,
      "svix-timestamp": timestamp,
      "svix-signature": signSvix({ secret: webhookSecret, svixId, timestamp, body }),
    };
  }

  async function mcp(token, method, params, { allowError = false } = {}) {
    const headers = { "content-type": "application/json" };
    if (token != null) headers.authorization = `Bearer ${token}`;
    const res = await request(mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: "e2e", method, params }),
    });
    if (!allowError) {
      assertHttp(res, 200, method);
      if (res.json?.error) {
        throw new Error(`${method} JSON-RPC ${res.json.error.code}: ${res.json.error.message}`);
      }
    }
    return res;
  }

  async function tool(name, args) {
    const res = await mcp(mcpToken, "tools/call", { name, arguments: args });
    const text = res.json?.result?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error(`${name}: missing text content: ${snippet(res.text)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${name}: tool text was not JSON: ${snippet(text)}`);
    }
  }

  async function totalCount() {
    const stats = await tool("email_stats", {});
    if (typeof stats.total !== "number" || !stats.by_direction) {
      throw new Error(`email_stats returned an unexpected payload: ${snippet(JSON.stringify(stats))}`);
    }
    return stats.total;
  }

  const eventBody = JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: { email_id: emailId },
  });
  const freshTs = String(Math.floor(Date.now() / 1000));
  ctx.delivery = {
    body: eventBody,
    headers: signedHeaders(`e2e-${randomUUID()}`, freshTs, eventBody),
  };

  await runCase("d", "MCP without a token and with a wrong token returns 401", async () => {
    const absent = await mcp(null, "tools/call", { name: "get_email", arguments: { resend_id: emailId } }, { allowError: true });
    assertHttp(absent, 401, "MCP with no Authorization header");
    const wrong = await mcp("incorrect-mcp-token", "tools/call", { name: "get_email", arguments: { resend_id: emailId } }, { allowError: true });
    assertHttp(wrong, 401, "MCP with the wrong token");
  });

  await runCase("c", "forged signature and an expired timestamp return 401", async () => {
    const before = await totalCount();
    const forged = await postWebhook(eventBody, {
      "svix-id": `e2e-forged-${randomUUID()}`,
      "svix-timestamp": freshTs,
      "svix-signature": `v1,${"A".repeat(44)}`,
    });
    assertHttp(forged, 401, "forged signature");
    const expiredTs = String(Math.floor(Date.now() / 1000) - 5 * 60 - 1);
    const expiredId = `e2e-expired-${randomUUID()}`;
    const expired = await postWebhook(eventBody, signedHeaders(expiredId, expiredTs, eventBody));
    assertHttp(expired, 401, "expired timestamp");
    const after = await totalCount();
    expect(after === before, `rejected webhooks changed the archive total from ${before} to ${after}`);
  });

  await runCase("a", "valid email.received webhook returns 200 and get_email reads the row", async () => {
    const res = await postWebhook(ctx.delivery.body, ctx.delivery.headers);
    assertHttp(res, 200, "valid webhook");
    expect(res.json?.ok === true, `valid webhook body was ${snippet(res.text)}`);
    const email = await tool("get_email", { resend_id: emailId, include_html: true });
    expect(email.found === true, `get_email did not find ${emailId}: ${snippet(JSON.stringify(email))}`);
    expect(email.resend_id === emailId, `get_email resend_id was ${email.resend_id}`);
    expect(email.direction === "in", `stored direction was ${email.direction}, expected in`);
    for (const key of ["from", "to", "cc", "subject", "date", "has_text", "has_html", "attachments", "text_body"]) {
      expect(Object.prototype.hasOwnProperty.call(email, key), `get_email is missing ${key}`);
    }
    expect(Array.isArray(email.to), "get_email to is not an array");
    expect(typeof email.date === "string" && email.date.length > 0, "get_email date is empty");
    ctx.email = email;
    ctx.totalAfterArchive = await totalCount();
  });

  await runCase("e", "authenticated search_emails finds the row and get_email returns the body", async () => {
    expect(ctx.email, "prerequisite failed: case a did not read the archived email");
    const email = ctx.email;
    const text = typeof email.text_body === "string" ? email.text_body.trim() : "";
    const html = typeof email.html_body === "string" ? email.html_body.trim() : "";
    const subject = typeof email.subject === "string" ? email.subject.trim() : "";
    expect(text.length > 0 || html.length > 0, "get_email returned no text_body or html_body");
    const address = typeof email.from === "string" ? email.from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] : null;
    const query = (text.length >= 20 ? text.slice(0, 60) : subject || address || text).slice(0, 200);
    expect(query.length > 0, "archived email has no subject, sender, or text_body to search");
    const args = { query, limit: 100, direction: "in" };
    if (address) args.from = address;
    const rows = await tool("search_emails", args);
    expect(Array.isArray(rows), "search_emails did not return an array");
    expect(
      rows.some((row) => row.resend_id === emailId),
      `search_emails query ${JSON.stringify(query)} returned ${rows.length} row(s) and none were ${emailId}`,
    );
    const again = await tool("get_email", { resend_id: emailId });
    expect(again.found === true && again.resend_id === emailId, "second get_email did not return the same id");
    expect(again.text_body === email.text_body, "text_body changed between reads");
    expect(!Object.prototype.hasOwnProperty.call(again, "html_body"), "get_email included html_body without include_html");
  });

  await runCase("b", "replaying the same webhook leaves a single row", async () => {
    expect(ctx.email && ctx.totalAfterArchive != null, "prerequisite failed: case a did not archive the email");
    const replay = await postWebhook(ctx.delivery.body, ctx.delivery.headers);
    assertHttp(replay, 200, "replayed webhook");
    expect(replay.json?.ok === true && replay.json?.duplicate === true, `replay body was ${snippet(replay.text)}`);
    const after = await totalCount();
    expect(after === ctx.totalAfterArchive, `replay changed the archive total from ${ctx.totalAfterArchive} to ${after}`);
    const email = await tool("get_email", { resend_id: emailId, include_html: true });
    expect(email.found === true && email.resend_id === emailId, "get_email after replay did not return the same id");
    expect(email.text_body === ctx.email.text_body, "text_body changed after replay");
    expect(email.html_body === ctx.email.html_body, "html_body changed after replay");
  });

  await runCase("f", "unauthenticated responses do not contain the message body", async () => {
    expect(ctx.email, "prerequisite failed: case a did not read the archived email");
    const probes = [
      ["GET /health", await request(healthUrl)],
      ["POST /mcp with no token", await mcp(null, "tools/call", { name: "get_email", arguments: { resend_id: emailId } }, { allowError: true })],
      ["POST /mcp with the wrong token", await mcp("incorrect-mcp-token", "tools/call", { name: "get_email", arguments: { resend_id: emailId } }, { allowError: true })],
      [
        "POST / with no Svix headers",
        await postWebhook(eventBody, {}, 30000),
      ],
    ];
    const staticUnauthorized = '{"ok":false,"error":"unauthorized"}';
    const bodyNeedles = (min) =>
      [ctx.email.text_body, ctx.email.html_body]
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length >= min && !staticUnauthorized.includes(value));
    const againstHealth = bodyNeedles(12);
    const againstUnauthorized = bodyNeedles(4);
    for (const [label, res] of probes) {
      if (label === "GET /health") {
        expect(res.status === 200, `${label}: expected HTTP 200, got ${res.status}: ${snippet(res.text)}`);
        const keys = res.json && typeof res.json === "object" ? Object.keys(res.json).sort() : [];
        expect(
          keys.length === 3 && keys[0] === "count_24h" && keys[1] === "last_received_at" && keys[2] === "ok",
          `${label} exposed unexpected fields: ${keys.join(", ") || snippet(res.text)}`,
        );
        for (const needle of againstHealth) {
          expect(!res.text.includes(needle), `${label} contained the archived message body`);
        }
      } else {
        expect(res.status === 401, `${label}: expected HTTP 401, got ${res.status}: ${snippet(res.text)}`);
        for (const needle of againstUnauthorized) {
          expect(!res.text.includes(needle), `${label} contained the archived message body`);
        }
      }
      for (const banned of ["text_body", "html_body", "raw_eml"]) {
        expect(!res.text.includes(`"${banned}"`), `${label} included ${banned}`);
      }
    }
  });

  const failed = results.filter((item) => !item.ok);
  console.log("");
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
  return failed.length === 0 ? 0 : 1;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(`e2e: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}
