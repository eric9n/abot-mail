import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONFIG_PATH,
  DeployError,
  assertProductionBranch,
  assertWorkersBuilds,
  deployMessage,
  productionConfigProblems,
  run,
} from "../deploy/cloudflare.mjs";

const SCRIPT = fileURLToPath(new URL("../deploy/cloudflare.mjs", import.meta.url));
const TOML = readFileSync(CONFIG_PATH, "utf8");

test("build and deploy refuse to run outside Workers Builds", () => {
  for (const command of ["build", "deploy"]) {
    const env = { ...process.env };
    delete env.WORKERS_CI;
    const result = spawnSync(process.execPath, [SCRIPT, command], { env, encoding: "utf8" });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /outside Cloudflare Workers Builds/);
  }
  assert.throws(() => assertWorkersBuilds({ WORKERS_CI: "true" }), DeployError);
  assert.throws(() => run("deploy", {}), DeployError);
});

test("deploy only ships main", () => {
  assert.doesNotThrow(() => assertProductionBranch({ WORKERS_CI_BRANCH: "main" }));
  for (const branch of [undefined, "", "cursor/x", "Main"]) {
    assert.throws(() => assertProductionBranch({ WORKERS_CI_BRANCH: branch }), DeployError, String(branch));
  }
  assert.throws(() => run("deploy", { WORKERS_CI: "1", WORKERS_CI_BRANCH: "dev" }), /only main deploys/);
  assert.throws(() => run("publish", { WORKERS_CI: "1" }), /usage/);
});

test("the checked-in wrangler.toml is the production config", () => {
  assert.deepEqual(productionConfigProblems(TOML), []);
});

test("production config check catches drift that would break the live worker", () => {
  const cases = [
    [TOML.replace('binding = "GATEWAY"', 'binding = "GW"'), /GATEWAY/],
    [TOML.replace("workers_dev = false", "workers_dev = true"), /workers_dev/],
    [TOML.replace('pattern = "mail.abot.run/*"', 'pattern = "x.abot.run/*"'), /route/],
    [TOML.replace("779058bf-f5c1-44de-b2c8-99350ec7748e", "00000000-0000-4000-8000-000000000000"), /D1/],
    [TOML.replace('queue = "mail-ingest"\n', 'queue = "mail-ingest-staging"\n'), /queue/],
    [TOML.replace("[ai]", '[vars]\nX = "1"\n\n[ai]'), /\[vars\]/],
  ];
  for (const [toml, problem] of cases) {
    assert.notEqual(toml, TOML);
    const problems = productionConfigProblems(toml);
    assert.ok(problems.some((p) => problem.test(p)), `${problem}: ${JSON.stringify(problems)}`);
  }
});

test("staging tables do not satisfy or break the production check", () => {
  const top = TOML.slice(0, TOML.indexOf("\n[env.staging]"));
  assert.deepEqual(productionConfigProblems(top), []);
});

test("deploy message names the build and commit", () => {
  assert.equal(
    deployMessage({ WORKERS_CI_BUILD_UUID: "b-1", WORKERS_CI_COMMIT_SHA: "0123456789abcdef" }),
    "Workers Builds b-1 main@0123456789ab",
  );
});
