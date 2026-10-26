import assert from "node:assert/strict";
import test from "node:test";
import { allowedCurrentUserRequest, boundedBrowserOperation, validateCurrentUserBrowserOptions, type CurrentUserBrowserOptions } from "./current-user-browser.js";

const options: CurrentUserBrowserOptions = { origin: "http://127.0.0.1:3001", account: { email: "current@example.invalid", password: "synthetic test password" },
  fixture: { jobId: "1", leadId: "2", contractingTaskId: "3", switchgearTaskId: "4" } };
test("Current-user verifier refuses account mutations and only edits its newly created note", () => {
  for (const [path, method] of [["/api/settings/users", "POST"], ["/api/settings/users/15/status", "POST"],
    ["/api/settings/users/15/permissions", "PUT"], ["/api/settings/users/15/department", "PUT"], ["/api/jobs/1/assignments", "POST"],
    ["/api/leads/2/notes/7", "DELETE"], ["/api/leads/2/notes/8", "PATCH"], ["/api/jobs/9/remarks", "PATCH"], ["/api/leads/2/stage", "PATCH"]])
    assert.equal(allowedCurrentUserRequest(options, options.origin + path, method!, "7"), false);
  for (const [path, method] of [["/api/auth/login", "POST"], ["/api/auth/logout", "POST"], ["/api/items", "POST"],
    ["/api/leads/2/notes", "POST"], ["/api/leads/2/notes/7", "PATCH"], ["/api/jobs/1/remarks", "PATCH"],
    ["/api/jobs/1/status", "PATCH"], ["/api/leads/1/attachments", "POST"], ["/settings/users/departments", "GET"]])
    assert.equal(allowedCurrentUserRequest(options, options.origin + path, method!, "7"), true);
  for (const value of ["https://example.invalid/api/items", "http://127.0.0.1:3002/api/v1/items", options.origin + "/.env.local", options.origin + "/legacy/assets/script.js"])
    assert.equal(allowedCurrentUserRequest(options, value, "GET"), false);
});
test("Current-user verifier validates bounded in-memory inputs without requiring synthetic identity replacement", () => {
  assert.doesNotThrow(() => validateCurrentUserBrowserOptions({ ...options, account: { email: "authorized@company.example", password: "private" } }));
  assert.throws(() => validateCurrentUserBrowserOptions({ ...options, origin: "http://localhost:3001" }));
  assert.throws(() => validateCurrentUserBrowserOptions({ ...options, fixture: { ...options.fixture, jobId: "../1" } }));
  assert.throws(() => validateCurrentUserBrowserOptions({ ...options, account: { ...options.account, password: "" } }));
});
test("Current-user created-deal reads allow exact loopback prefetch and keep mutations and alternate origins refused", () => {
  for (const method of ["GET", "HEAD"])
    for (const path of ["/deals", "/deals?_rsc=synthetic", "/jobs?cohort=completed"])
      assert.equal(allowedCurrentUserRequest(options, options.origin + path, method), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    assert.equal(allowedCurrentUserRequest(options, options.origin + "/deals?_rsc=synthetic", method), false);
  for (const value of ["http://localhost:3001/deals", "http://127.0.0.1:3002/deals", "http://user@127.0.0.1:3001/deals",
    options.origin + "/deals/1", options.origin + "/%64eals", options.origin + "/deals%2f1"])
    assert.equal(allowedCurrentUserRequest(options, value, "GET"), false);
});
test("Read-only current-user mode permits normal auth only and refuses every supported business mutation", () => {
  const readOnly = { ...options, readOnly: true };
  for (const [path, method] of [["/api/items", "POST"], ["/api/leads/2/notes", "POST"], ["/api/leads/2/notes/7", "PATCH"],
    ["/api/jobs/1/remarks", "PATCH"], ["/api/jobs/1/status", "PATCH"], ["/api/leads/1/attachments", "POST"],
    ["/api/jobs/1/assignments", "POST"], ["/api/jobs/1/unassign", "POST"], ["/api/settings/users/15/permissions", "PUT"]])
    assert.equal(allowedCurrentUserRequest(readOnly, options.origin + path, method!, "7"), false);
  for (const path of ["/api/auth/login", "/api/auth/logout"])
    assert.equal(allowedCurrentUserRequest(readOnly, options.origin + path, "POST"), true);
  for (const path of ["/api/auth/csrf", "/api/jobs/1/assignments", "/api/quotations/3/pdf", "/api/jobs/export", "/deals?_rsc=synthetic"])
    assert.equal(allowedCurrentUserRequest(readOnly, options.origin + path, "GET"), true);
  assert.equal(allowedCurrentUserRequest(readOnly, "https://example.invalid/api/auth/login", "POST"), false);
  assert.throws(() => validateCurrentUserBrowserOptions({ ...options, readOnly: "true" as unknown as boolean }));
});
test("Browser deadline rejects a hung operation while preserving actual completion and failure", async () => {
  assert.equal(await boundedBrowserOperation(Promise.resolve(false), 50), false);
  const failure = new Error("Synthetic failure");
  await assert.rejects(boundedBrowserOperation(Promise.reject(failure), 50), error => error === failure);
  await assert.rejects(boundedBrowserOperation(new Promise<never>(() => undefined), 10), { name: "TimeoutError" });
});
