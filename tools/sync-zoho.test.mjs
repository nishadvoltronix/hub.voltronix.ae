import assert from "node:assert/strict";
import test from "node:test";
import { runZohoInbound } from "./sync-zoho.mjs";

const values = { NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", APP_ORIGIN: "https://synthetic.example.invalid",
  CRM_API_INSTANCE_ID: "synthetic", CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3302",
  CRM_DATABASE_MODE: "mysql-native", CRM_MYSQL_NETWORK_DISABLED: "0", CRM_RUNTIME_ENABLE: "approved-production-mysql-crm-runtime",
  CRM_RUNTIME_SOURCE: "environment", CRM_MYSQL_HOST: "127.0.0.1", CRM_MYSQL_PORT: "3308", CRM_MYSQL_DATABASE: "synthetic_native",
  CRM_MYSQL_USER: "synthetic_runtime", CRM_MYSQL_PASSWORD: "synthetic-password", CRM_MYSQL_SERVER_UUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  CRM_MYSQL_APPROVED: "true", CRM_MYSQL_APPROVAL_REFERENCE: "synthetic approval", CRM_MYSQL_PROVISIONING_REFERENCE: "synthetic fixture",
  CRM_MYSQL_ISSUER_COMPANY: "VOLTRONIX CONTRACTING LLC", CRM_MYSQL_ISSUER_SALESPERSON: "Synthetic",
  ZOHO_ENABLED: "false", ZOHO_SYNC_ENABLED: "false", ZOHO_ORGANIZATION_ID: "3001", ZOHO_SYNC_PRINCIPAL_ID: "1",
  ZOHO_SYNC_INTERVAL_SECONDS: "300", ZOHO_CLIENT_ID: "synthetic-client", ZOHO_CLIENT_SECRET: "synthetic-secret", ZOHO_REFRESH_TOKEN: "synthetic-refresh" };
function fixture(options = {}) {
  const calls = [], database = {}, selected = { organizationId: "3001", principalId: "1", intervalMs: 300000,
    credentials: { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh" } };
  const source = { readiness: async () => { calls.push("source-ready"); }, close() { calls.push("source-close"); if (options.closeFails) throw Error("private-provider-value"); } };
  const runtime = { database, readiness: async () => { calls.push("database-ready"); return true; }, close: async () => { calls.push("database-close"); } };
  return { calls, dependencies: { root: "synthetic-root", loadEnvironment: (_root, overrides) => {
    calls.push("environment"); assert.deepEqual(overrides, {}); return { ...values, ...(options.environment ?? {}) };
  }, loadConfiguration: async () => { calls.push("configuration"); return {}; }, modules: async () => [
    { createCrmRuntime() { calls.push("database-create"); return runtime; } },
    { zohoSyncConfigurationFromEnvironment() { return selected; } },
    { openZohoInboundSource: async (config, dependencies) => {
      calls.push("source-open"); assert.deepEqual(config, { credentials: selected.credentials, organizationId: "3001" });
      assert.deepEqual(dependencies, { networkEnabled: true }); return source;
    } },
    { readZohoInboundStatus: async (db, organizationId, principalId) => {
      calls.push("status"); assert.equal(db, database); assert.equal(organizationId, "3001"); assert.equal(principalId, "1");
      if (options.denied) throw Object.assign(Error("private-database-value"), { code: "ACCESS_DENIED" });
      return { state: "idle", generation: 0, checkpointAvailable: false, lastAttemptAt: null, lastSuccessAt: null, counts: null, errorCode: null, leaseActive: false };
    } },
    { runZohoInboundSync: async input => {
      calls.push("run"); assert.equal(input.source, source); assert.equal(input.database, database); assert.equal(input.principalId, "1");
      assert.ok(input.signal instanceof AbortSignal);
      if (options.runFails) throw Object.assign(Error("private-provider-value"), { code: "RATE_LIMITED" });
      return { status: options.status ?? "completed", generation: 1, counts: { read: 5, applied: 5, skipped: 0, conflicts: 0, deleted: 0 }, secret: "private-provider-value" };
    } },
  ] } };
}

test("sync CLI help, invalid arguments and ambient vetoes never read configuration or construct dependencies", async () => {
  const dependencies = { loadEnvironment() { assert.fail("unexpected environment read"); }, modules() { assert.fail("unexpected module load"); } };
  assert.equal((await runZohoInbound(["--help"], {}, dependencies)).exitCode, 0);
  for (const args of [[], ["run", "extra"], ["apply"], ["--url=elsewhere"]]) assert.equal((await runZohoInbound(args, {}, dependencies)).exitCode, 1);
  for (const environment of [{ DEBUG: "1" }, { CRM_MYSQL_NETWORK_DISABLED: "1" }, { ZOHO_NETWORK_DISABLED: "1" }]) {
    assert.equal((await runZohoInbound(["run"], environment, dependencies)).exitCode, 1);
  }
});

test("sync CLI check is read-only and checks local principal before opening a pinned read-only source", async () => {
  const f = fixture(), result = await runZohoInbound(["check"], {}, f.dependencies);
  assert.equal(result.exitCode, 0); assert.equal(JSON.parse(result.stdout).status, "CHECKED_READ_ONLY");
  assert.deepEqual(f.calls, ["environment", "configuration", "database-create", "database-ready", "status", "source-open", "source-ready", "source-close", "database-close"]);
});

test("sync CLI run uses one coordinator pass and reports partial/busy without declaring completion", async () => {
  for (const status of ["completed", "partial", "busy"]) {
    const f = fixture({ status }), result = await runZohoInbound(["run"], {}, f.dependencies);
    assert.equal(result.exitCode, status === "completed" ? 0 : 2); assert.equal(JSON.parse(result.stdout).status, status);
    assert.equal(f.calls.filter(value => value === "run").length, 1); assert.doesNotMatch(result.stdout + result.stderr, /private-provider-value|synthetic-secret/);
    assert.deepEqual(f.calls.slice(-2), ["source-close", "database-close"]);
  }
});

test("sync CLI refuses revoked principal and root veto before any provider reads", async () => {
  for (const options of [{ denied: true }, { environment: { ZOHO_NETWORK_DISABLED: "1" } }]) {
    const f = fixture(options), result = await runZohoInbound(["run"], {}, f.dependencies);
    assert.equal(result.exitCode, 1); assert.equal(f.calls.includes("source-open"), false); assert.equal(f.calls.includes("run"), false);
    assert.doesNotMatch(result.stderr, /private-database-value/);
  }
});

test("sync CLI retains failure semantics, closes both owners and never exposes provider messages", async () => {
  for (const options of [{ runFails: true }, { closeFails: true }]) {
    const f = fixture(options), result = await runZohoInbound(["run"], {}, f.dependencies);
    assert.equal(result.exitCode, 1); assert.doesNotMatch(result.stdout + result.stderr, /private-provider-value/);
    assert.deepEqual(f.calls.slice(-2), ["source-close", "database-close"]);
  }
});

test("sync CLI pre-aborted invocation performs no dependency work", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  const result = await runZohoInbound(["run"], {}, { ...f.dependencies, signal: abort.signal });
  assert.equal(result.exitCode, 1); assert.deepEqual(f.calls, []);
});
