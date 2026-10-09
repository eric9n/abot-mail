/**
 * Live check against a deployed worker that no longer archives mail.
 * Reads WORKER_URL, MCP_URL, WEBHOOK_SECRET, MCP_TOKEN.
 * Missing variables fail the process; they never count as a pass.
 *
 * MCP_URL is the gateway mail MCP endpoint. MCP_TOKEN is that gateway's
 * access token. This script does not send an email and does not read D1.
 */

import { createHmac, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
const REQUIRED_ENV = ["WORKER_URL", "MCP_URL", "WEBHOOK_SECRET", "MCP_TOKEN"];

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
    throw new Error(`${label}: expected HTTP ${status}, got ${res.status} ${snippet(res.text)}`);
  }
}

function mcpEndpoint() {
  const raw = process.env.MCP_URL.trim().replace(/\/+$/, "");
  return raw.endsWith("/mcp") ? raw : `${raw}/mcp`;
}

async function main() {
  const missing = missingEnv();
  if (missing.length) {
    console.error(`e2e: missing required environment variable(s): ${missing.join(", ")}`);
    console.error("Required: WORKER_URL, MCP_URL (gateway mail MCP endpoint), WEBHOOK_SECRET (whsec_…), MCP_TOKEN (gateway access token).");
    console.error("Refusing to pass without them.");
    return 1;
  }

  const workerUrl = process.env.WORKER_URL.trim();
  const webhookSecret = process.env.WEBHOOK_SECRET.trim();
  const mcpToken = process.env.MCP_TOKEN.trim();

  const health = await request(endpoint(workerUrl, "/health"));
  assertHttp(health, 200, "GET /health");
  expect(health.json && health.json.ok === true, `health not ok: ${snippet(health.text)}`);
  expect(Object.keys(health.json).join(",") === "ok", `health must be only ok, got ${snippet(health.text)}`);

  const body = JSON.stringify({ type: "email.received", data: { email_id: `probe-${randomUUID()}` } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const svixId = `msg_${randomUUID()}`;
  const signed = await request(endpoint(workerUrl, "/"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": svixId,
      "svix-timestamp": timestamp,
      "svix-signature": signSvix({ secret: webhookSecret, svixId, timestamp, body }),
    },
    body,
  });
  assertHttp(signed, 200, "signed webhook");
  expect(signed.json && signed.json.ok === true && signed.json.ignored === true, `webhook was not ignored: ${snippet(signed.text)}`);
  expect(signed.json.queued !== true, "webhook must not enqueue");

  const bad = await request(endpoint(workerUrl, "/"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": svixId,
      "svix-timestamp": timestamp,
      "svix-signature": "v1,not-a-signature",
    },
    body,
  });
  assertHttp(bad, 401, "bad signature");

  const direct = await request(endpoint(workerUrl, "/mcp"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-abot-owner-email": "probe@abot.run" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assertHttp(direct, 404, "public /mcp");

  const listed = await request(mcpEndpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assertHttp(listed, 200, "gateway tools/list");
  const names = (((listed.json || {}).result || {}).tools || []).map((tool) => tool.name).sort();
  expect(JSON.stringify(names) === JSON.stringify(["get_account", "send_email"]), `unexpected tools: ${snippet(JSON.stringify(names))}`);
  console.log("e2e: health, ignored webhook, and tools/list passed");
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`e2e: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    });
}

