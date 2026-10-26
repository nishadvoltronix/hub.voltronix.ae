import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeZohoSyncConfiguration, zohoSyncConfigurationFromEnvironment, RuntimeIntegrationError } from "../src/runtime/zoho-configuration.js";

const environment = { CRM_API_ENVIRONMENT: "production", CRM_RUNTIME_ENABLE: "approved-production-mysql-crm-runtime",
  ZOHO_ENABLED: "false", ZOHO_SYNC_ENABLED: "true", ZOHO_SYNC_INTERVAL_SECONDS: "300", ZOHO_SYNC_PRINCIPAL_ID: "1",
  ZOHO_ORGANIZATION_ID: "3001", ZOHO_CLIENT_ID: "synthetic-client", ZOHO_CLIENT_SECRET: "synthetic-secret", ZOHO_REFRESH_TOKEN: "synthetic-refresh" };

test("inbound configuration requires explicit polling selection independently of outbound write authority", () => {
  const selected = loadRuntimeZohoSyncConfiguration(environment)!;
  assert.equal(selected.principalId, "1"); assert.equal(selected.organizationId, "3001"); assert.equal(selected.intervalMs, 300000);
  assert.equal(Object.isFrozen(selected), true); assert.equal(Object.isFrozen(selected.credentials), true);
  assert.equal(loadRuntimeZohoSyncConfiguration({ ...environment, ZOHO_SYNC_ENABLED: "false" }), undefined);
  assert.deepEqual(zohoSyncConfigurationFromEnvironment({ ...environment, ZOHO_SYNC_ENABLED: "false" }), selected);
});

test("inbound configuration refuses absent principal, malformed interval and credentials without exposing supplied data", () => {
  for (const patch of [{ ZOHO_SYNC_ENABLED: "1" }, { ZOHO_SYNC_PRINCIPAL_ID: "" }, { ZOHO_SYNC_PRINCIPAL_ID: "0" },
    { ZOHO_SYNC_INTERVAL_SECONDS: "59" }, { ZOHO_SYNC_INTERVAL_SECONDS: "86401" }, { ZOHO_SYNC_INTERVAL_SECONDS: "60.5" },
    { ZOHO_SYNC_INTERVAL_SECONDS: "0300" }, { ZOHO_ORGANIZATION_ID: "" }, { CRM_API_ENVIRONMENT: "development" },
    { CRM_RUNTIME_ENABLE: "" }, { ZOHO_CLIENT_SECRET: "private-marker\n" }]) {
    assert.throws(() => loadRuntimeZohoSyncConfiguration({ ...environment, ...patch }), error => error instanceof RuntimeIntegrationError && !String(error.stack).includes("private-marker"));
  }
});
