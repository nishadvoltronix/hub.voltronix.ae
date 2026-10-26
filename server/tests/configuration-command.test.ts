import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { syntheticChildEnvironment } from "./helpers/child-environment.js";

const backend = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const checker = fileURLToPath(new URL("../scripts/check-runtime.ts", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const settings = { CRM_API_ENVIRONMENT: "development", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3002",
  APP_ORIGIN: "http://127.0.0.1:3001", CRM_RUNTIME_ENABLE: "", CRM_RUNTIME_PROFILE: "", CRM_MYSQL_NETWORK_DISABLED: "1" };

function run(entrypoint: string, cwd: string, overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entrypoint], {
    cwd, env: syntheticChildEnvironment({ ...settings, ...overrides }), encoding: "utf8", timeout: 15_000, windowsHide: true,
  });
}

for (const [label, cwd] of [["workspace", root], ["backend", backend], ["unrelated directory", tmpdir()]] as const) {
  test(`configuration command from ${label} validates local foundation without MySQL or a listener`, () => {
    const result = run(checker, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "PASS_LOCAL_API_CONFIGURATION");
    assert.equal(report.mode, "foundation-only");
    assert.equal(report.profileValidated, false);
    assert.equal(report.databaseConnections, 0);
    assert.equal(report.databaseWrites, 0);
    assert.match(report.limitation, /not CRM availability/);
  });
}

test("configuration command refuses invalid local settings with key-only diagnostics", () => {
  const result = run(checker, root, { CRM_API_PORT: "synthetic-secret-marker" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("synthetic-secret-marker"), false);
  const report = JSON.parse(result.stderr);
  assert.equal(report.status, "REFUSED");
  assert.equal(report.code, "LOCAL_API_CONFIGURATION");
  assert.match(report.hint, /CRM_API_PORT/);
  assert.equal(report.databaseConnections, 0);
  assert.equal(report.databaseWrites, 0);
});

test("nonempty malformed MySQL selection cannot fall back to foundation success", () => {
  const result = run(checker, root, { CRM_RUNTIME_ENABLE: "synthetic-secret-marker" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("synthetic-secret-marker"), false);
  const report = JSON.parse(result.stderr);
  assert.equal(report.code, "RUNTIME_CONFIGURATION");
  assert.equal(report.databaseConnections, 0);
  assert.equal(report.databaseWrites, 0);
});

test("normal CLI configuration refusal supplies key-only diagnostics before listening", () => {
  const result = run(cli, tmpdir(), { CRM_API_PORT: "synthetic-secret-marker" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("synthetic-secret-marker"), false);
  assert.match(result.stderr, /CRM_API_PORT/);
  assert.match(result.stderr, /Process settings override server\/\.env/);
});

test("production checker and CLI refuse a foundation-only startup without opening a listener", () => {
  for (const entrypoint of [checker, cli]) {
    const result = run(entrypoint, root, { CRM_API_ENVIRONMENT: "production", APP_ORIGIN: "https://crm.example.invalid" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /private.*profile/i);
    assert.equal(result.stderr.includes("synthetic-secret-marker"), false);
  }
});

test("checker and native CLI refuse Hub legacy mode or disabled mixed credentials before runtime startup", () => {
  for (const entrypoint of [checker, cli]) for (const overrides of [
    { CRM_DATABASE_MODE: "legacy" }, { CRM_DATABASE_MODE: "" },
    { CRM_DATABASE_MODE: "disabled", CRM_MYSQL_PASSWORD: "synthetic-secret-marker" },
    { CRM_DATABASE_MODE: "disabled", CRM_RUNTIME_PROFILE: "synthetic-secret-marker" },
  ]) {
    const result = run(entrypoint, root, overrides);
    assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("synthetic-secret-marker"), false);
    assert.equal(result.stderr.includes("listener started"), false);
  }
});
