import assert from "node:assert/strict";
import test from "node:test";
import { runNativeAdminBootstrap } from "./bootstrap-native-admin.mjs";

function fixture(overrides = {}) {
  const events = [];
  const values = { NODE_ENV: "production", APP_ORIGIN: "https://synthetic.invalid", CRM_API_INSTANCE_ID: "synthetic",
    CRM_DATABASE_MODE: "mysql-native", CRM_MYSQL_NETWORK_DISABLED: "0", ZOHO_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1",
    CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "18731",
    CRM_RUNTIME_ENABLE: "approved-production-mysql-crm-runtime", CRM_RUNTIME_SOURCE: "environment",
    CRM_MYSQL_HOST: "127.0.0.1", CRM_MYSQL_PORT: "3308", CRM_MYSQL_DATABASE: "synthetic_bootstrap", CRM_MYSQL_USER: "synthetic_app",
    CRM_MYSQL_PASSWORD: "synthetic private marker", CRM_MYSQL_SERVER_UUID: "550e8400-e29b-41d4-a716-446655440000", CRM_MYSQL_APPROVED: "true",
    CRM_MYSQL_APPROVAL_REFERENCE: "synthetic review", CRM_MYSQL_PROVISIONING_REFERENCE: "synthetic provision",
    CRM_MYSQL_ISSUER_COMPANY: "VOLTRONIX CONTRACTING LLC", CRM_MYSQL_ISSUER_SALESPERSON: "TEST ONLY" };
  const request = { requestId: "synthetic", target: {}, administrator: { password: "synthetic private marker" } };
  const dependencies = { root: "synthetic-root",
    modules: async () => [{ nativeAdminRequestPath: ".local-data/operators/native-admin-bootstrap.json",
      validateNativeAdminRequest: (_config, input) => { events.push("validate"); assert.equal(input, request); return input; },
      bootstrapNativeAdministrator: async (_config, input, mode) => { events.push(mode); assert.equal(input, request); return { status: "PASS" }; } },
    { readPrivateNativeAdminRequest: (_root, path) => { events.push("read-request"); assert.equal(path, ".local-data/operators/native-admin-bootstrap.json"); return request; }, assertPrivateAccess: () => {} }],
    loadEnvironment: (_root, ambient) => { events.push("root-env"); assert.deepEqual(ambient, {}); return values; },
    loadConfiguration: async (_root, profile, development) => { events.push("config"); assert.equal(profile.databaseMode, "mysql-native"); assert.equal(development, true); return {}; },
    receiptWriter: () => ({ attempted: () => { events.push("attempted"); return false; }, write: phase => events.push(phase) }),
    ...overrides,
  };
  return { events, dependencies };
}
test("native administrator command refuses unsafe arguments/debug/network veto before loading private files", async () => {
  const f = fixture();
  for (const [args, environment] of [[[], {}], [["apply", "extra"], {}], [["check"], { DEBUG: "*" }], [["apply"], { CRM_MYSQL_NETWORK_DISABLED: "1" }]]) {
    assert.equal((await runNativeAdminBootstrap(args, environment, f.dependencies)).exitCode, 1);
  }
  assert.deepEqual(f.events, []); assert.equal((await runNativeAdminBootstrap(["--help"], {}, f.dependencies)).exitCode, 0);
});
test("native administrator check reads root-only configuration and protected request without receipts", async () => {
  const f = fixture(); const result = await runNativeAdminBootstrap(["check"], { CRM_MYSQL_PASSWORD: "ambient marker" }, f.dependencies);
  assert.equal(result.exitCode, 0, JSON.stringify(f.events)); assert.deepEqual(f.events, ["root-env", "config", "read-request", "validate", "check"]);
  assert.doesNotMatch(JSON.stringify(result), /private marker|ambient marker/);
});
test("native administrator apply records attempt before DML and completion only after success", async () => {
  const f = fixture(); assert.equal((await runNativeAdminBootstrap(["apply"], {}, f.dependencies)).exitCode, 0);
  assert.deepEqual(f.events, ["root-env", "config", "read-request", "validate", "attempted", "attempt", "apply", "complete"]);
});
test("native administrator existing attempt or failed attempt receipt prevents execution", async () => {
  for (const receipts of [{ attempted: () => true, write: () => assert.fail() },
    { attempted: () => false, write: () => { throw Error("private filesystem detail"); } }]) {
    const f = fixture({ receiptWriter: () => receipts });
    const result = await runNativeAdminBootstrap(["apply"], {}, f.dependencies);
    assert.equal(result.exitCode, 1); assert.equal(f.events.includes("apply"), false); assert.doesNotMatch(result.stderr, /private filesystem/);
  }
});
test("native administrator failed database operation records a retained safe failure and never retries", async () => {
  const f = fixture(), original = f.dependencies.modules;
  f.dependencies.modules = async () => { const modules = await original(); modules[0].bootstrapNativeAdministrator = async () => {
    f.events.push("failed-dml"); throw Object.assign(Error("synthetic private driver detail"), { code: "DATABASE" });
  }; return modules; };
  const result = await runNativeAdminBootstrap(["apply"], {}, f.dependencies);
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /DATABASE/); assert.doesNotMatch(result.stderr, /private driver/);
  assert.equal(f.events.filter(value => value === "failed-dml").length, 1); assert.equal(f.events.at(-1), "failed");
});
