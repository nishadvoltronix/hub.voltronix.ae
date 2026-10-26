import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig, ConfigurationError } from "../src/config.js";
import { parseBackendEnvironment, isMysqlRuntimeSelected } from "../src/environment.js";
import { loadRuntimeConfiguration, RuntimeConfigurationError } from "../src/runtime/configuration.js";
import { mysqlEnvironmentKeys } from "../src/runtime/environment-settings.js";
import { syntheticChildEnvironment } from "./helpers/child-environment.js";

const env = { CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3002",
  APP_ORIGIN: "https://hub.voltronix.ae", CRM_RUNTIME_ENABLE: "approved-production-mysql-crm-runtime",
  CRM_RUNTIME_SOURCE: "environment", CRM_RUNTIME_PROFILE: "", CRM_MYSQL_NETWORK_DISABLED: "1",
  CRM_MYSQL_HOST: "127.0.0.1", CRM_MYSQL_PORT: "3306", CRM_MYSQL_DATABASE: "crm_synthetic_test",
  CRM_MYSQL_USER: "crm_runtime", CRM_MYSQL_PASSWORD: "synthetic-secret-marker",
  CRM_MYSQL_SERVER_UUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", CRM_MYSQL_APPROVED: "true",
  CRM_MYSQL_APPROVAL_REFERENCE: "Synthetic offline approval", CRM_MYSQL_PROVISIONING_REFERENCE: "Synthetic receipt",
  CRM_MYSQL_ISSUER_COMPANY: "VOLTRONIX CONTRACTING LLC", CRM_MYSQL_ISSUER_SALESPERSON: "Synthetic salesperson",
  ZOHO_ENABLED: "false" };
const noRead = () => { assert.fail("Environment mode must not read a profile"); };

test("production dotenv feeds the existing runtime validator without a JSON read or DB connection", () => {
  const parsed = parseBackendEnvironment(Object.entries(env).map(([k, v]) => `${k}='${v}'`).join("\n"));
  assert(isMysqlRuntimeSelected(parsed));
  const config = loadRuntimeConfiguration("unused", parsed, noRead);
  assert.equal(config.api.appOrigin, env.APP_ORIGIN);
  assert.equal(config.mysql.password, env.CRM_MYSQL_PASSWORD);
  assert.equal(config.serverUuid, env.CRM_MYSQL_SERVER_UUID);
  assert.equal(config.issuer?.salesperson, env.CRM_MYSQL_ISSUER_SALESPERSON);
  assert(Object.isFrozen(config.mysql));
});

test("each missing production field refuses with redacted errors", () => {
  for (const key of mysqlEnvironmentKeys) {
    assert.throws(() => loadRuntimeConfiguration("unused", { ...env, [key]: "" }, noRead), error => {
      assert(error instanceof RuntimeConfigurationError);
      assert(!error.message.includes(env.CRM_MYSQL_PASSWORD)); return true;
    });
  }
});

test("production environment retains host, root-user, schema, UUID, approval and issuer restrictions", () => {
  for (const patch of [{ CRM_MYSQL_HOST: "remote.example.invalid" }, { CRM_MYSQL_PORT: "3307" },
    { CRM_MYSQL_USER: "root" }, { CRM_MYSQL_DATABASE: "mysql" }, { CRM_MYSQL_SERVER_UUID: "invalid" },
    { CRM_MYSQL_APPROVED: "false" }, { CRM_MYSQL_ISSUER_COMPANY: "unknown" }, { DEBUG: "1" },
    { CRM_MYSQL_PASSWORD: "x\nsecret" }, { CRM_MYSQL_PASSWORD: "x".repeat(4097) },
    { CRM_MYSQL_UNREVIEWED: "value" }, { APP_ORIGIN: "https://hub.voltronix.ae/" }]) {
    assert.throws(() => loadRuntimeConfiguration("unused", { ...env, ...patch }, noRead), RuntimeConfigurationError);
  }
});

test("mixed, unknown and local-demo credential sources fail closed", () => {
  for (const patch of [{ CRM_RUNTIME_PROFILE: ".local-data/operators/mysql-crm-runtime.json" },
    { CRM_RUNTIME_SOURCE: "unknown" }, { CRM_RUNTIME_SOURCE: "" },
    { CRM_API_ENVIRONMENT: "development", APP_ORIGIN: "http://127.0.0.1:3001", CRM_RUNTIME_ENABLE: "approved-local-mysql-crm-runtime" }]) {
    assert.throws(() => loadRuntimeConfiguration("unused", { ...env, ...patch }, noRead), RuntimeConfigurationError);
  }
  assert(isMysqlRuntimeSelected({ CRM_MYSQL_PASSWORD: "synthetic" }));
  assert(!isMysqlRuntimeSelected({ CRM_MYSQL_NETWORK_DISABLED: "1" }));
});

test("Zoho settings are backend-only inactive configuration, never a pretend enabled integration", () => {
  const parsed = parseBackendEnvironment("ZOHO_ENABLED=false\nZOHO_CLIENT_ID=synthetic\nZOHO_CLIENT_SECRET=synthetic-secret-marker\nZOHO_REFRESH_TOKEN=synthetic-token\n");
  assert.doesNotThrow(() => loadConfig({ ...env, ...parsed }));
  for (const patch of [{ ZOHO_ENABLED: "true" }, { ZOHO_ENABLED: "1" }, { ZOHO_UNSUPPORTED: "value" },
    { ZOHO_CLIENT_SECRET: "x\nsecret" }, { ZOHO_REFRESH_TOKEN: "x".repeat(4097) }]) {
    assert.throws(() => loadConfig({ ...env, ...patch }), ConfigurationError);
  }
});

test("offline config checker accepts production environment and never outputs credentials", () => {
  const entry = fileURLToPath(new URL("../scripts/check-runtime.ts", import.meta.url));
  for (const enabled of ["false", "true"]) {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), entry], {
      env: syntheticChildEnvironment({ ...env, ZOHO_ENABLED: enabled }), encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    assert.equal(result.status, enabled === "false" ? 0 : 1);
    assert(!(result.stdout + result.stderr).includes(env.CRM_MYSQL_PASSWORD));
    if (enabled === "false") {
      const report = JSON.parse(result.stdout);
      assert.equal(report.configurationSource, "backend-environment");
      assert.equal(report.profileValidated, false);
      assert.equal(report.databaseConnections, 0);
      assert.equal(report.databaseWrites, 0);
    }
  }
});
