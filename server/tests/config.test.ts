import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError, loadConfig, validateConfig, type ApiConfig } from "../src/config.js";

const valid = { CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3002",
  APP_ORIGIN: "http://127.0.0.1:3001" };

test("explicit local configuration is immutable and does not include unrelated environment values", () => {
  const config = loadConfig({ ...valid, MYSQL_PASSWORD: "synthetic-secret-marker", DATABASE_PROVIDER: "sqlite" });
  assert.deepEqual(config, { environment: "test", host: "127.0.0.1", port: 3002, appOrigin: valid.APP_ORIGIN });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(JSON.stringify(config).includes("synthetic-secret-marker"), false);
  // No database provider is selected by this process-only foundation.
});

for (const key of Object.keys(valid)) {
  test(`missing required setting ${key} fails closed`, () => {
    const environment: Record<string, string> = { ...valid };
    delete environment[key];
    assert.throws(() => loadConfig(environment), ConfigurationError);
  });
}
for (const [description, overrides] of [
  ["external bind", { CRM_API_HOST: "0.0.0.0" }],
  ["hostname alias", { CRM_API_HOST: "localhost" }],
  ["staging mode", { CRM_API_ENVIRONMENT: "staging" }],
  ["production mode with local HTTP origin", { CRM_API_ENVIRONMENT: "production" }],
  ["ephemeral port", { CRM_API_PORT: "0" }],
  ["privileged port", { CRM_API_PORT: "1023" }],
  ["overflow port", { CRM_API_PORT: "65536" }],
  ["ambiguous port", { CRM_API_PORT: "03002" }],
  ["external origin", { APP_ORIGIN: "https://example.invalid" }],
  ["origin userinfo", { APP_ORIGIN: "http://synthetic-secret-marker@127.0.0.1:3001" }],
  ["origin path", { APP_ORIGIN: `${valid.APP_ORIGIN}/` }],
  ["origin query", { APP_ORIGIN: `${valid.APP_ORIGIN}?secret=synthetic-secret-marker` }],
  ["origin privileged port", { APP_ORIGIN: "http://127.0.0.1:80" }],
  ["origin hostname", { APP_ORIGIN: "http://localhost:3001" }],
  ["origin HTTPS", { APP_ORIGIN: "https://127.0.0.1:3001" }],
  ["unknown API key", { CRM_API_PASSWROD: "synthetic-secret-marker" }],
] as const) {
  test(`${description} is rejected without exposing values`, () => {
    assert.throws(() => loadConfig({ ...valid, ...overrides }), error => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.message, "Invalid local API configuration; no server was started.");
      assert.equal(error.stack?.includes("synthetic-secret-marker"), false);
      return true;
    });
  });
}

test("listener revalidation redacts malformed objects and throwing getters", () => {
  for (const value of [null, undefined, { get environment() { throw new Error("synthetic-secret-marker"); } }]) {
    assert.throws(() => validateConfig(value as unknown as ApiConfig), ConfigurationError);
  }
  assert.throws(() => validateConfig({ ...loadConfig(valid), host: "0.0.0.0" } as unknown as ApiConfig), ConfigurationError);
});

test("explicit routing identity survives listener validation and accepts only non-secret slugs", () => {
  const config = loadConfig({ ...valid, CRM_API_INSTANCE_ID: "hub-crm" });
  assert.equal(config.instanceId, "hub-crm");
  assert.deepEqual(validateConfig(config), config);
  for (const instanceId of ["", "HUB", "with space", "https://secret-marker.invalid", "x\nsecret-marker", "x".repeat(65)]) {
    assert.throws(() => loadConfig({ ...valid, CRM_API_INSTANCE_ID: instanceId }), ConfigurationError);
  }
});

test("explicit IPv6 loopback bind is supported while public and ambiguous binds refuse", () => {
  assert.equal(loadConfig({ ...valid, CRM_API_HOST: "::1" }).host, "::1");
  for (const host of ["::", "[::1]", "::ffff:127.0.0.1", "192.0.2.1"]) {
    assert.throws(() => loadConfig({ ...valid, CRM_API_HOST: host }), ConfigurationError);
  }
});
