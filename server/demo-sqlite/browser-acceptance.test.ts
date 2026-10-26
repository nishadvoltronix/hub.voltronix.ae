import assert from "node:assert/strict";
import test from "node:test";
import { allowedDemoBrowserRequest, safeBrowserFailure, validateBrowserOptions, type BrowserAcceptanceOptions } from "./browser-acceptance.js";

const origin = "http://127.0.0.1:3001";
test("SQLite browser diagnostics exclude error messages and string assertion values", () => {
  const secret = "synthetic-private-value-that-must-not-appear";
  const stringAssertion = new assert.AssertionError({ actual: secret, expected: secret + " expected", message: secret });
  assert.deepEqual(safeBrowserFailure(stringAssertion), { step: "Case assertions", kind: "assertion" });
  assert.deepEqual(safeBrowserFailure(new Error(secret)), { step: "Case assertions", kind: "operation" });
  const numericAssertion = new assert.AssertionError({ actual: 403, expected: 200, message: secret });
  assert.deepEqual(safeBrowserFailure(numericAssertion), { step: "Case assertions", kind: "assertion", actual: 403, expected: 200 });
  const booleanAssertion = new assert.AssertionError({ actual: true, expected: false, message: secret });
  assert.deepEqual(safeBrowserFailure(booleanAssertion), { step: "Case assertions", kind: "assertion", actual: true, expected: false });
});
test("SQLite browser egress allows only the exact demo origin and application paths", () => {
  for (const path of ["/", "/login", "/account", "/jobs/1", "/quotations/2/edit", "/departments/Electrical/jobs/1",
    "/settings/permissions/assign?userId=1", "/reports/employee-performance", "/api/jobs/export?query=synthetic", "/_next/static/chunks/main.js",
    "/legacy/assets/css/style.css", "/legacy/assets/fonts/tabler-icons.woff2", "/legacy/assets/images/authentication/img-auth-bg-2.jpg"]) {
    assert.equal(allowedDemoBrowserRequest(origin, origin + path), true);
  }
  for (const url of ["http://127.0.0.1:3002/api/v1/jobs", "http://localhost:3001/jobs", "https://example.invalid", origin + "/.env.local",
    origin + "/index.php", origin + "/_next/image?url=https://example.invalid", origin + "/api/%2fprivate", "file:///private",
    origin + "/legacy/assets/config.json", origin + "/legacy/assets/private.env", origin + "/legacy/assets/script.php",
    "http://synthetic:password@127.0.0.1:3001/jobs", "ws://127.0.0.1:3001/socket"]) assert.equal(allowedDemoBrowserRequest(origin, url), false);
  assert.equal(allowedDemoBrowserRequest("http://127.0.0.1:4001", "http://127.0.0.1:4001/jobs"), false);
});

test("SQLite browser options require distinct synthetic accounts and bounded fixture IDs", () => {
  const password = "synthetic-only-test-password";
  const options: BrowserAcceptanceOptions = { origin, verification: { mutationScope: "fixture-writes-and-auth", sessionPolicy: "preserve-existing" }, accounts: {
    browserManager: { email: "manager@example.invalid", password }, browserWorker: { email: "worker@example.invalid", password },
    browserDenied: { email: "denied@example.invalid", password },
  }, fixture: { jobId: "1", leadId: "2", contractingTaskId: "3", switchgearTaskId: "4", workerId: "5", workerName: "Synthetic worker" } };
  assert.doesNotThrow(() => validateBrowserOptions(options));
  assert.throws(() => validateBrowserOptions({ ...options, origin: "http://localhost:3001" }));
  assert.throws(() => validateBrowserOptions({ ...options, fixture: { ...options.fixture, jobId: "../1" } }));
  assert.throws(() => validateBrowserOptions({ ...options, accounts: { ...options.accounts, browserDenied: options.accounts.browserManager } }));
  assert.throws(() => validateBrowserOptions({ ...options, accounts: { ...options.accounts, browserManager: { email: "person@company.ae", password } } }));
});
