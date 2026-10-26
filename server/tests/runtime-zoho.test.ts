import assert from "node:assert/strict";
import test from "node:test";
import { createCrmRuntime, openCrmRuntime } from "../src/runtime/composition.js";
import { RuntimeConfigurationError, validateRuntimeConfiguration } from "../src/runtime/configuration.js";
import { loadRuntimeZohoConfiguration, productionZohoConfigurationFromEnvironment, RuntimeIntegrationError } from "../src/runtime/zoho-configuration.js";
import type { CrmIntegration } from "../src/crm/router.js";
import { syntheticProductionZohoConfiguration } from "./helpers/production-zoho.js";

const zoho = syntheticProductionZohoConfiguration();
const environment = { CRM_API_ENVIRONMENT: "production", CRM_RUNTIME_ENABLE: "approved-production-mysql-crm-runtime", ZOHO_ENABLED: "true",
  ZOHO_CLIENT_ID: zoho.credentials.clientId, ZOHO_CLIENT_SECRET: zoho.credentials.clientSecret, ZOHO_REFRESH_TOKEN: zoho.credentials.refreshToken,
  ZOHO_ORGANIZATION_ID: zoho.organizationId, ZOHO_ACCOUNT_OWNER_ID: zoho.accountOwnerId, ZOHO_PROFILE: zoho.profile,
  ZOHO_DEAL_PIPELINE: zoho.dealPipeline, ZOHO_AUTOMATION_POLICY: zoho.automationPolicy };
function nativeConfiguration() {
  return validateRuntimeConfiguration({ version: 2, mysql: { provider: "mysql", environment: "production", host: "127.0.0.1", port: 3308,
    database: "crm_synthetic_production", user: "synthetic_runtime", password: "synthetic-native-password" },
  approval: { approved: true, reference: "Synthetic test", provisioningReference: "Synthetic receipt", serverUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  issuer: { company: "VOLTRONIX CONTRACTING LLC", salesperson: "Synthetic salesperson" } },
  { environment: "production", host: "127.0.0.1", port: 4000, appOrigin: "https://synthetic.example.invalid" });
}
const request = async () => ({ status: 200, body: {} });
const integration: CrmIntegration = { leads: { request }, commercial: { request }, accountOwnerId: zoho.accountOwnerId,
  production: { organizationId: zoho.organizationId, quotationProfile: "voltronix-custom-quoted-items-v8", numberingProfile: "voltronix-hub-local-references-v1", dealLayoutId: "6001" } };
function dependencies() {
  const calls: string[] = [];
  const runtime = createCrmRuntime(nativeConfiguration()); // Pure: no real connection is opened.
  let dbReady = true, zohoReady = true, closeFailure = false;
  const owned = { ...runtime, readiness: async () => { calls.push("database-ready"); return dbReady; },
    close: async () => { calls.push("database-close"); await runtime.close(); if (closeFailure) throw new Error("private-driver-message"); } };
  const value = { networkEnabled: true,
    createRuntime: ((_config, options) => { calls.push("database-create"); assert.equal(options?.integration, integration); return owned; }) as typeof createCrmRuntime,
    openIntegration: async () => { calls.push("integration-open"); return { crmIntegration: integration,
      readiness: async () => { calls.push("integration-ready"); if (!zohoReady) throw new Error("private-provider-message"); },
      close: () => { calls.push("integration-close"); } }; } };
  return { calls, value, runtime, setDatabaseReady: (value: boolean) => { dbReady = value; }, setZohoReady: (value: boolean) => { zohoReady = value; },
    failClose: () => { closeFailure = true; } };
}

test("runtime integration selection is explicit; binding setup validates stored profile without enabling runtime", () => {
  assert.deepEqual(loadRuntimeZohoConfiguration(environment), zoho);
  assert.equal(loadRuntimeZohoConfiguration({ ...environment, ZOHO_ENABLED: "false" }), undefined);
  assert.deepEqual(productionZohoConfigurationFromEnvironment({ ...environment, ZOHO_ENABLED: "false" }), zoho);
  for (const patch of [{ ZOHO_ENABLED: "1" }, { ZOHO_PROFILE: "automatic" }, { ZOHO_ACCOUNT_OWNER_ID: "" },
    { ZOHO_DEAL_PIPELINE: " bad " }, { CRM_API_ENVIRONMENT: "test" }, { ZOHO_UNSUPPORTED: "private-marker" }]) {
    assert.throws(() => loadRuntimeZohoConfiguration({ ...environment, ...patch }), error => error instanceof RuntimeIntegrationError && !String(error.stack).includes("private-marker"));
  }
});

test("native-only runtime construction never opens an integration and selected networking requires explicit permission", async () => {
  let calls = 0;
  const runtime = await openCrmRuntime(nativeConfiguration(), undefined, { openIntegration: async () => { calls++; throw new Error(); } });
  await runtime.close(); assert.equal(calls, 0);
  await assert.rejects(openCrmRuntime(nativeConfiguration(), zoho, { openIntegration: async () => { calls++; throw new Error(); } }), RuntimeConfigurationError);
  assert.equal(calls, 0);
});

test("owned native readiness includes both dependencies and shutdown closes each once, even after failure", async () => {
  const f = dependencies(), runtime = await openCrmRuntime(nativeConfiguration(), zoho, f.value);
  assert.deepEqual(f.calls, ["integration-open", "database-create"]);
  assert.equal(await runtime.readiness(), true);
  f.setZohoReady(false); assert.equal(await runtime.readiness(), false);
  f.setZohoReady(true); f.setDatabaseReady(false); assert.equal(await runtime.readiness(), false);
  f.failClose();
  const closing = runtime.close(); assert.strictEqual(runtime.close(), closing);
  await assert.rejects(closing, error => error instanceof RuntimeConfigurationError && !String(error.stack).includes("private-driver-message"));
  assert.equal(f.calls.filter(value => value === "integration-close").length, 1);
  assert.equal(f.calls.filter(value => value === "database-close").length, 1);
  const checks = f.calls.length;
  assert.equal(await runtime.readiness(), false); assert.equal(f.calls.length, checks);
});

test("failed integration opening cannot construct native services or select a local fallback", async () => {
  let creates = 0;
  await assert.rejects(openCrmRuntime(nativeConfiguration(), zoho, { networkEnabled: true,
    openIntegration: async () => { throw new Error("private-provider-message"); },
    createRuntime: (() => { creates++; throw new Error(); }) as typeof createCrmRuntime }),
  error => error instanceof RuntimeConfigurationError && !String(error.stack).includes("private-provider-message"));
  assert.equal(creates, 0);
});

test("database construction failure closes the already opened remote session without retry", async () => {
  const f = dependencies();
  try {
    await assert.rejects(openCrmRuntime(nativeConfiguration(), zoho, { ...f.value,
      createRuntime: (() => { throw new Error("private-constructor-message"); }) as typeof createCrmRuntime }), RuntimeConfigurationError);
    assert.deepEqual(f.calls, ["integration-open", "integration-close"]);
  } finally { await f.runtime.close(); }
});

test("inbound runtime check never applies; explicit serving starts polling and shutdown drains it before database close", async () => {
  const calls: string[] = [], db = createCrmRuntime(nativeConfiguration());
  let finish!: () => void;
  const source = { readiness: async () => { calls.push("source-ready"); },
    readChanges: async () => { throw Error("coordinator fixture owns pass"); }, close() { calls.push("source-close"); finish?.(); } };
  const sync = { credentials: zoho.credentials, organizationId: zoho.organizationId, principalId: "1", intervalMs: 60_000 };
  const runtime = await openCrmRuntime(nativeConfiguration(), undefined, { networkEnabled: true,
    createRuntime: () => ({ ...db, readiness: async () => true, close: async () => { calls.push("database-close"); await db.close(); } }),
    openInboundSource: async (_config, dependencies) => { assert.equal(dependencies?.networkEnabled, true); calls.push("source-open"); return source; },
    readInboundStatus: async () => { calls.push("principal-status"); return { state: "idle", generation: 0, checkpointAvailable: false,
      lastAttemptAt: null, lastSuccessAt: null, counts: null, errorCode: null, leaseActive: false, leaseExpiresAt: null }; },
    runInboundSync: async input => {
      calls.push("pass"); assert.equal(input.source, source); assert.equal(input.principalId, "1");
      await new Promise<void>(resolve => { finish = resolve; }); assert.equal(input.signal?.aborted, true);
      calls.push("pass-drained"); return { status: "busy" };
    },
  }, sync);
  assert.deepEqual(calls, ["source-open", "source-ready", "principal-status"]);
  assert.equal(await runtime.readiness(), true); assert.equal(calls.includes("pass"), false);
  runtime.startBackground?.(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls.includes("pass"), true);
  await runtime.close(); await runtime.close();
  assert.deepEqual(calls.slice(-3), ["source-close", "pass-drained", "database-close"]);
});

test("inbound principal refusal closes both owners without applying or constructing a fallback", async () => {
  const calls: string[] = [], db = createCrmRuntime(nativeConfiguration());
  await assert.rejects(openCrmRuntime(nativeConfiguration(), undefined, { networkEnabled: true,
    createRuntime: () => ({ ...db, close: async () => { calls.push("database-close"); await db.close(); } }),
    openInboundSource: async () => ({ readiness: async () => {}, readChanges: async () => { throw Error(); }, close() { calls.push("source-close"); } }),
    readInboundStatus: async () => { throw Error("synthetic-private-database-message"); },
    runInboundSync: async () => assert.fail("unauthorized principal must not import"),
  }, { credentials: zoho.credentials, organizationId: zoho.organizationId, principalId: "1", intervalMs: 60_000 }),
  error => error instanceof RuntimeConfigurationError && !String(error.stack).includes("synthetic-private"));
  assert.deepEqual(calls, ["source-close", "database-close"]);
});

test("inbound and outbound organization mismatch is refused before either provider is opened", async () => {
  await assert.rejects(openCrmRuntime(nativeConfiguration(), zoho, { networkEnabled: true,
    openIntegration: async () => assert.fail("configuration mismatch must precede network"),
    openInboundSource: async () => assert.fail("configuration mismatch must precede network"),
  }, { credentials: zoho.credentials, organizationId: "999", principalId: "1", intervalMs: 60_000 }), RuntimeConfigurationError);
});
