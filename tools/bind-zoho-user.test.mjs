import assert from "node:assert/strict";
import test from "node:test";
import { runZohoUserBinding } from "./bind-zoho-user.mjs";

function fixture(overrides = {}) {
  const events = [];
  const values = { NODE_ENV: "production", APP_ORIGIN: "https://synthetic.invalid", CRM_API_INSTANCE_ID: "synthetic",
    CRM_DATABASE_MODE: "mysql-native", CRM_MYSQL_NETWORK_DISABLED: "0", ZOHO_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1",
    CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "18731",
    CRM_RUNTIME_ENABLE: "approved-production-mysql-crm-runtime", CRM_RUNTIME_SOURCE: "environment",
    CRM_MYSQL_HOST: "127.0.0.1", CRM_MYSQL_PORT: "3308", CRM_MYSQL_DATABASE: "synthetic_binding", CRM_MYSQL_USER: "synthetic_app",
    CRM_MYSQL_PASSWORD: "synthetic private marker", CRM_MYSQL_SERVER_UUID: "550e8400-e29b-41d4-a716-446655440000", CRM_MYSQL_APPROVED: "true",
    CRM_MYSQL_APPROVAL_REFERENCE: "synthetic review", CRM_MYSQL_PROVISIONING_REFERENCE: "synthetic provision",
    CRM_MYSQL_ISSUER_COMPANY: "VOLTRONIX CONTRACTING LLC", CRM_MYSQL_ISSUER_SALESPERSON: "TEST ONLY" };
  const request = { requestId: "synthetic", target: {} };
  const zoho = { credentials: { clientId: "synthetic-client", clientSecret: "synthetic-secret", refreshToken: "synthetic-refresh" },
    organizationId: "3001", accountOwnerId: "4001", dealPipeline: "Synthetic Pipeline" };
  const dependencies = { root: "synthetic-root",
    modules: async () => [{ zohoUserBindingRequestPath: ".local-data/operators/zoho-user-binding.json",
      validateZohoBindingRequest: (_config, organization, input) => { events.push("validate"); assert.equal(organization, "3001"); assert.equal(input, request); return input; },
      bindZohoApplicationUser: async (_config, input, session, mode) => { events.push(mode); assert.equal(input, request); assert.ok(session.close); return { status: "PASS" }; } },
    { readPrivateZohoBindingRequest: (_root, path) => { events.push("read-request"); assert.equal(path, ".local-data/operators/zoho-user-binding.json"); return request; }, assertPrivateAccess: () => {} },
    { productionZohoConfigurationFromEnvironment: environment => { assert.equal(environment, values); events.push("zoho-config"); return zoho; } },
    { openZohoSession: async (configuration, network) => { events.push("open"); assert.deepEqual(network, { networkEnabled: true }); assert.deepEqual(configuration, { ...zoho, environment: "production", mode: "read-only",
      accountPayloadProfile: "standard-account-contact-email-v1", dealPayloadProfile: "legacy-conversion-fields-v1", stagePayloadProfile: "voltronix-stage-labels-v1" });
      return { close: () => events.push("close") }; } }],
    loadEnvironment: (_root, ambient) => { events.push("root-env"); assert.deepEqual(ambient, {}); return values; },
    loadConfiguration: async (_root, profile) => { events.push("config"); assert.equal(profile.databaseMode, "mysql-native"); return {}; },
    receiptWriter: () => ({ attempted: () => { events.push("attempted"); return false; }, write: phase => events.push(phase) }),
    ...overrides,
  };
  return { events, dependencies };
}
test("custom-user binding command refuses unsafe arguments/debug/network veto before private loading", async () => {
  const f = fixture();
  for (const [args, environment] of [[[], {}], [["apply", "extra"], {}], [["check"], { DEBUG: "*" }], [["apply"], { CRM_MYSQL_NETWORK_DISABLED: "1" }], [["check"], { ZOHO_NETWORK_DISABLED: "1" }]]) {
    assert.equal((await runZohoUserBinding(args, environment, f.dependencies)).exitCode, 1);
  }
  assert.deepEqual(f.events, []); assert.equal((await runZohoUserBinding(["--help"], {}, f.dependencies)).exitCode, 0);
});
test("custom-user binding loaded root Zoho network veto prevents request and provider loading", async () => {
  const f = fixture(), original = f.dependencies.loadEnvironment;
  f.dependencies.loadEnvironment = (...args) => ({ ...original(...args), ZOHO_NETWORK_DISABLED: "1" });
  assert.equal((await runZohoUserBinding(["check"], {}, f.dependencies)).exitCode, 1);
  assert.deepEqual(f.events, ["root-env"]);
});
test("custom-user binding check reads root-only config with runtime disabled, opens pinned read-only session and closes without receipts", async () => {
  const f = fixture(); const result = await runZohoUserBinding(["check"], { ZOHO_CLIENT_SECRET: "ambient marker" }, f.dependencies);
  assert.equal(result.exitCode, 0); assert.deepEqual(f.events, ["root-env", "config", "zoho-config", "read-request", "validate", "open", "check", "close"]);
  assert.doesNotMatch(JSON.stringify(result), /private marker|ambient marker|synthetic-secret|synthetic-refresh/);
});
test("custom-user binding apply preserves attempt before network/DML and completion only after close", async () => {
  const f = fixture(); assert.equal((await runZohoUserBinding(["apply"], {}, f.dependencies)).exitCode, 0);
  assert.deepEqual(f.events, ["root-env", "config", "zoho-config", "read-request", "validate", "attempted", "attempt", "open", "apply", "close", "complete"]);
});
test("custom-user binding existing attempt prevents network and DML", async () => {
  const f = fixture({ receiptWriter: () => ({ attempted: () => true, write: () => assert.fail() }) });
  const result = await runZohoUserBinding(["apply"], {}, f.dependencies);
  assert.equal(result.exitCode, 1); assert.equal(f.events.includes("open"), false); assert.equal(f.events.includes("apply"), false);
});
test("custom-user binding failure is redacted, preserved and session closed without retry", async () => {
  const f = fixture(), original = f.dependencies.modules;
  f.dependencies.modules = async () => { const modules = await original(); modules[0].bindZohoApplicationUser = async () => {
    f.events.push("failed-dml"); throw Object.assign(Error("synthetic private driver detail"), { code: "DATABASE" });
  }; return modules; };
  const result = await runZohoUserBinding(["apply"], {}, f.dependencies);
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /DATABASE/); assert.doesNotMatch(result.stderr, /private driver/);
  assert.equal(f.events.filter(value => value === "failed-dml").length, 1); assert.deepEqual(f.events.slice(-2), ["failed", "close"]);
});
