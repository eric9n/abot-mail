#!/usr/bin/env node
// The only release path for resend-agent-mail-relay. Cloudflare Workers Builds runs:
//   build command:  npm run gate && node deploy/cloudflare.mjs build
//   deploy command: node deploy/cloudflare.mjs deploy
// Both refuse to run outside Workers Builds (WORKERS_CI=1).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = join(ROOT, "worker", "wrangler.toml");
export const PRODUCTION_BRANCH = "main";
// Live consumers from the archive worker. Wrangler deploy does not delete a
// consumer that was removed from wrangler.toml, and the versions API rejects
// a script with no queue() while one is still attached (error 11001).
export const INGEST_QUEUES = ["mail-ingest", "mail-ingest-dlq"];

export const PRODUCTION = {
  name: "resend-agent-mail-relay",
  route: "mail.abot.run/*",
  zone: "abot.run",
  d1Id: "779058bf-f5c1-44de-b2c8-99350ec7748e",
};

export class DeployError extends Error {}

export function assertWorkersBuilds(env) {
  if (env.WORKERS_CI !== "1") {
    throw new DeployError(
      "refusing to run outside Cloudflare Workers Builds (WORKERS_CI is not 1). " +
        "Production deploys only from the dashboard build of the main branch.",
    );
  }
}

export function assertProductionBranch(env) {
  const branch = env.WORKERS_CI_BRANCH;
  if (branch !== PRODUCTION_BRANCH) {
    throw new DeployError(`refusing to deploy branch ${JSON.stringify(branch ?? null)}; only ${PRODUCTION_BRANCH} deploys`);
  }
}

/** The part of wrangler.toml before the first [env.*] table, which is what a plain deploy reads. */
export function topLevelConfig(toml) {
  const match = /^\[+env\./m.exec(toml);
  return match ? toml.slice(0, match.index) : toml;
}

function stripComments(toml) {
  return toml
    .split("\n")
    .map((line) => line.replace(/^\s*#.*$/, ""))
    .join("\n");
}

function tables(toml, header) {
  const out = [];
  const re = new RegExp(`^\\[\\[${header.replace(/\./g, "\\.")}\\]\\]\\s*$`, "gm");
  let m;
  while ((m = re.exec(toml))) {
    const rest = toml.slice(m.index + m[0].length);
    const next = /^\[/m.exec(rest);
    out.push(next ? rest.slice(0, next.index) : rest);
  }
  return out;
}

function value(block, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(block);
  if (!m) return undefined;
  const raw = m[1];
  if (raw.startsWith('"')) return raw.slice(1, raw.indexOf('"', 1));
  return raw;
}

/** Returns a list of problems. Empty means the default env still deploys production as it runs today. */
export function productionConfigProblems(toml) {
  const top = stripComments(topLevelConfig(toml));
  const head = top.split(/^\[/m)[0];
  const problems = [];
  const expect = (ok, message) => {
    if (!ok) problems.push(message);
  };
  expect(value(head, "name") === PRODUCTION.name, `name must be ${PRODUCTION.name}`);
  expect(value(head, "main") === "worker.js", "main must be worker.js");
  expect(value(head, "workers_dev") === "false", "workers_dev must be false (POST /mcp trusts only the Service Binding host)");
  expect(value(head, "preview_urls") === "false", "preview_urls must be false");

  const routes = tables(top, "routes");
  expect(
    routes.length === 1 && value(routes[0], "pattern") === PRODUCTION.route && value(routes[0], "zone_name") === PRODUCTION.zone,
    `exactly one route ${PRODUCTION.route} on zone ${PRODUCTION.zone}`,
  );

  const d1 = tables(top, "d1_databases");
  expect(
    d1.length === 1 && value(d1[0], "binding") === "DB" && value(d1[0], "database_id") === PRODUCTION.d1Id,
    `D1 binding DB must point at ${PRODUCTION.d1Id}`,
  );

  expect(tables(top, "r2_buckets").length === 0, "no R2 binding: mail is not archived");
  expect(tables(top, "queues.producers").length === 0, "no queue producer: mail is not ingested");
  expect(tables(top, "queues.consumers").length === 0, "no queue consumer: mail is not ingested");
  expect(!/^\[ai\]\s*$/m.test(top), "no Workers AI binding: summaries are not stored");
  expect(!/^\[triggers\]\s*$/m.test(top), "no cron: archive alerts are removed");
  expect(!/^\s*\[vars\]/m.test(top), "no [vars]: secrets stay in Worker secrets");
  return problems;
}

function wrangler(args, env) {
  const result = spawnWrangler(args, env, "inherit");
  if (result.status !== 0) throw new DeployError(`wrangler ${args[0]} exited with ${result.status}`);
}

function spawnWrangler(args, env, stdio) {
  const bin = join(ROOT, "node_modules", ".bin", "wrangler");
  const result = spawnSync(bin, args, { cwd: ROOT, env, stdio, encoding: stdio === "inherit" ? undefined : "utf8" });
  if (result.error) throw result.error;
  return result;
}

export function consumerRemoveArgs(queue) {
  return ["queues", "consumer", "remove", queue, PRODUCTION.name];
}

export function consumerAlreadyGone(output) {
  return /No worker consumer /.test(output);
}

function detachIngestConsumers(env) {
  for (const queue of INGEST_QUEUES) {
    const result = spawnWrangler(consumerRemoveArgs(queue), env, "pipe");
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (output) process.stderr.write(output.endsWith("\n") ? output : `${output}\n`);
    if (result.status === 0 || consumerAlreadyGone(output)) continue;
    throw new DeployError(`wrangler queues consumer remove ${queue} exited with ${result.status}`);
  }
}

function checkConfig() {
  const problems = productionConfigProblems(readFileSync(CONFIG_PATH, "utf8"));
  if (problems.length) {
    throw new DeployError(`worker/wrangler.toml is not the production config:\n  - ${problems.join("\n  - ")}`);
  }
}

export function deployMessage(env) {
  const sha = (env.WORKERS_CI_COMMIT_SHA || "").slice(0, 12);
  return `Workers Builds ${env.WORKERS_CI_BUILD_UUID || "?"} ${PRODUCTION_BRANCH}@${sha || "?"}`;
}

export function run(command, env = process.env) {
  assertWorkersBuilds(env);
  if (command === "build") {
    checkConfig();
    wrangler(["deploy", "--dry-run", "--config", CONFIG_PATH, "--env=", "--outdir", join(ROOT, "dist")], env);
    return;
  }
  if (command === "deploy") {
    assertProductionBranch(env);
    checkConfig();
    detachIngestConsumers(env);
    const args = ["deploy", "--config", CONFIG_PATH, "--env=", "--message", deployMessage(env)];
    if (env.WORKERS_CI_COMMIT_SHA) args.push("--tag", env.WORKERS_CI_COMMIT_SHA.slice(0, 12));
    wrangler(args, env);
    return;
  }
  throw new DeployError(`usage: node deploy/cloudflare.mjs <build|deploy>, got ${JSON.stringify(command ?? null)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run(process.argv[2]);
  } catch (err) {
    console.error(err instanceof DeployError ? `deploy/cloudflare.mjs: ${err.message}` : err);
    process.exit(1);
  }
}
