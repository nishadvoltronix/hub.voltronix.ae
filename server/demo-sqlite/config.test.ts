import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgement, demoConfiguration, demoInstanceId } from "./storage.js";

test("SQLite demo requires explicit local selection and refuses MySQL/staging/debug mixing", () => {
  const valid = { CRM_SQLITE_DEMO: acknowledgement, CRM_API_ENVIRONMENT: "development", CRM_API_HOST: "127.0.0.1",
    CRM_API_PORT: "3002", APP_ORIGIN: "http://127.0.0.1:3001" };
  // Node's test workers can set --inspect-port=0 even without an inspector.
  // Test the exact argument input explicitly; runtime uses actual process args.
  assert.equal(demoConfiguration(valid, []).port, 3002);
  assert.equal(demoConfiguration(valid, []).instanceId, demoInstanceId);
  for (const extra of [{ CRM_SQLITE_DEMO: "" }, { CRM_API_ENVIRONMENT: "production" }, { NODE_ENV: "production" },
    { CRM_API_HOST: "0.0.0.0" }, { CRM_API_PORT: "3003" }, { APP_ORIGIN: "https://example.com" },
    { CRM_RUNTIME_ENABLE: "approved-local-mysql-crm-runtime" }, { CRM_RUNTIME_PROFILE: "anything" }, { DEBUG: "trace" }]) {
    assert.throws(() => demoConfiguration({ ...valid, ...extra }, []));
  }
  for (const argument of ["--inspect", "--inspect-brk", "--inspect-port=0"])
    assert.throws(() => demoConfiguration(valid, [argument]));
});
