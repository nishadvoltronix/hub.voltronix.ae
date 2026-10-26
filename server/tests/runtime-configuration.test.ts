import assert from "node:assert/strict";
import test from "node:test";
import { createCrmRuntime, verifyCrmRuntimeConnection } from "../src/runtime/composition.js";
import { assertValidatedRuntimeConfiguration, loadRuntimeConfiguration, RuntimeConfigurationError, runtimeAcknowledgement,
  runtimeProfilePath, validateRuntimeConfiguration, type RuntimeConfiguration } from "../src/runtime/configuration.js";
import { readPrivateRuntimeProfile } from "../src/runtime/private-profile.js";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";

const now = 1_800_000_000_000, id = "01234567-89ab-4def-8123-456789abcdef";
const api = { environment: "test", host: "127.0.0.1", port: 4000, appOrigin: "http://127.0.0.1:3000" } as const;
const environment = { CRM_API_ENVIRONMENT: "test", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "4000", APP_ORIGIN: api.appOrigin,
  CRM_RUNTIME_ENABLE: runtimeAcknowledgement, CRM_RUNTIME_PROFILE: runtimeProfilePath };
function profile(timestamp = now) {
  return { version: 1, mysql: { provider: "mysql", environment: "test", host: "127.0.0.1", port: 3308,
    database: `crm_local_crm_${id.replaceAll("-", "")}`, user: "crm_r_0123456789ab4def81234567", password: "synthetic-test-only" },
  approval: { approved: true, reference: "Synthetic offline test", validFrom: new Date(timestamp - 60_000).toISOString(),
    validUntil: new Date(timestamp + 60_000).toISOString(), localRuntime: true, syntheticWrites: true,
    serverUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", provisioningReference: "Synthetic test receipt", fixtureId: id } };
}

test("OFFLINE runtime explicit selection validates a synthetic private input without reading a real profile", () => {
  const seen: string[] = [];
  const value = loadRuntimeConfiguration("synthetic-public-root", environment, (root, name) => { seen.push(root, name); return profile(); }, now);
  assert.deepEqual(seen, ["synthetic-public-root", runtimeProfilePath]);
  assert.equal(value.mysql.database, profile().mysql.database);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.mysql)); assert.ok(Object.isFrozen(value.api));
  assertValidatedRuntimeConfiguration(value, now);
});

test("OFFLINE native runtime preserves explicit API instance identity through profile validation", () => {
  const value = loadRuntimeConfiguration("synthetic-public-root", { ...environment, CRM_API_INSTANCE_ID: "hub-crm" }, () => profile(), now);
  assert.equal(value.api.instanceId, "hub-crm");
  assert.equal(validateRuntimeConfiguration(profile(), { ...api, instanceId: "hub-crm" }, now).api.instanceId, "hub-crm");
});

test("OFFLINE Hub database modes refuse native runtime before credentials or a private profile can be read", () => {
  for (const mode of ["disabled", "legacy", "mysql", "", " "]) {
    let reads = 0;
    const values = { ...environment, CRM_DATABASE_MODE: mode,
      get CRM_RUNTIME_ENABLE(): string { return assert.fail("Mode refusal must precede native runtime selector access"); } };
    assert.throws(() => loadRuntimeConfiguration("unused", values, () => { reads++; return profile(); }, now), RuntimeConfigurationError);
    assert.equal(reads, 0);
    assert.throws(() => loadRuntimeConfiguration("unused", { ...environment, CRM_DATABASE_MODE: mode,
      CRM_RUNTIME_SOURCE: "environment", CRM_MYSQL_PASSWORD: "synthetic-secret-marker" }, () => { reads++; return profile(); }, now),
    error => error instanceof RuntimeConfigurationError && !error.message.includes("synthetic-secret-marker"));
    assert.equal(reads, 0);
  }
});

test("OFFLINE runtime requires explicit selector, no debug settings and no alternate profile fallback", () => {
  for (const patch of [{ CRM_RUNTIME_ENABLE: undefined }, { CRM_RUNTIME_ENABLE: "true" },
    { CRM_RUNTIME_PROFILE: undefined }, { CRM_RUNTIME_PROFILE: "../nextjs/.env.mysql.runtime.local" },
    { CRM_RUNTIME_EXTRA: "ignored" }, { DEBUG: "synthetic" }, { NODE_OPTIONS: "--inspect" }, { CRM_API_HOST: "0.0.0.0" }]) {
    let reads = 0;
    assert.throws(() => loadRuntimeConfiguration("unused", { ...environment, ...patch }, () => { reads++; return profile(); }, now), RuntimeConfigurationError);
    assert.equal(reads, 0);
  }
});

test("OFFLINE runtime refuses other hosts ports databases accounts, extra driver keys and environment mismatch", () => {
  for (const patch of [{ host: "localhost" }, { host: "::1" }, { host: "production.invalid" }, { port: 3306 },
    { database: "crm_local_dev" }, { database: "crm_nextjs_development" }, { database: "crm_local_auth_0123456789ab4def8123456789abcdef" },
    { user: "root" }, { user: "other_account" }, { environment: "development" }, { provider: "sqlite" }, { socketPath: "ignored" },
    { password: "" }, { password: "x\0y" }]) {
    const input = profile(); Object.assign(input.mysql, patch);
    assert.throws(() => validateRuntimeConfiguration(input, api, now), RuntimeConfigurationError);
  }
});

test("OFFLINE runtime approval must be current, scoped and tied to a new isolated fixture", () => {
  for (const patch of [{ approved: false }, { localRuntime: false }, { syntheticWrites: false }, { fixtureId: null },
    { fixtureId: "01234567-89ab-4def-8123-456789abcdee" }, { validUntil: new Date(now).toISOString() },
    { validFrom: new Date(now + 1).toISOString() }, { validFrom: new Date(now - 86_400_000).toISOString() },
    { provisioningReference: "" }, { serverUuid: "placeholder" }]) {
    const input = profile(); Object.assign(input.approval, patch);
    assert.throws(() => validateRuntimeConfiguration(input, api, now), RuntimeConfigurationError);
  }
  assert.throws(() => validateRuntimeConfiguration(profile(), api, Number.NaN), RuntimeConfigurationError);
});

test("OFFLINE development contract names only crm_local_dev and forbids synthetic fixture approval", () => {
  const input = profile(); Object.assign(input.mysql, { environment: "development", database: "crm_local_dev", user: "synthetic_runtime" });
  Object.assign(input.approval, { fixtureId: null, syntheticWrites: false });
  assert.equal(validateRuntimeConfiguration(input, { ...api, environment: "development" }, now).mysql.database, "crm_local_dev");
  assert.throws(() => validateRuntimeConfiguration(input, api, now), RuntimeConfigurationError);
});

test("OFFLINE composition is pure and rejects typed bypass, stale or cloned validation results", async () => {
  const timestamp = Date.now(), valid = validateRuntimeConfiguration(profile(timestamp), api, timestamp);
  const runtime = createCrmRuntime(valid);
  assert.equal(typeof runtime.database.authTransaction, "function");
  await runtime.close();
  assert.throws(() => createCrmRuntime({ ...valid }), RuntimeConfigurationError);
  assert.throws(() => assertValidatedRuntimeConfiguration(valid, valid.validUntil), RuntimeConfigurationError);
  assert.throws(() => createCrmRuntime({ mysql: { host: "production.invalid" } } as unknown as RuntimeConfiguration), RuntimeConfigurationError);
});

test("OFFLINE private reader refuses alternate env/profile paths before opening them", () => {
  for (const name of [".env.local", "../nextjs/.env.mysql.runtime.local", ".local-data/operators/other.json", "/absolute.json"]) {
    assert.throws(() => readPrivateRuntimeProfile("unused", name), RuntimeConfigurationError);
  }
});

test("OFFLINE identity mismatch and unavailable driver fail closed before grants/schema or mutations", async () => {
  const config = validateRuntimeConfiguration(profile(), api, now);
  let calls = 0;
  const connection = { async query() { calls++; return [[{ serverUuid: "wrong", identity: "wrong" }], []]; } } as unknown as MysqlWireConnection;
  await assert.rejects(verifyCrmRuntimeConnection(connection, config, now), RuntimeConfigurationError);
  assert.equal(calls, 1);
  await assert.rejects(verifyCrmRuntimeConnection(connection, config, config.validUntil), RuntimeConfigurationError);
  assert.equal(calls, 1);
  connection.query = async () => { throw new Error("synthetic-private-driver-message"); };
  await assert.rejects(verifyCrmRuntimeConnection(connection, config, now), error => error instanceof RuntimeConfigurationError
    && !error.message.includes("private-driver"));
});
