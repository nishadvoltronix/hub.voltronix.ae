import assert from "node:assert/strict";
import test from "node:test";
import { permittedRoleWriteRequest, retainedFilePlan, workerPlan } from "./approved-role-write-browser.js";
import { LOG_OPTIONS } from "../../tests/sqlite-reference/departments/contracts.js";
const origin = "http://127.0.0.1:3001";
test("role-write browser refuses unrelated account/grant/history and nonlocal mutations", () => {
  for (const path of ["/api/settings/users", "/api/settings/users/5/status", "/api/settings/grants/5", "/api/jobs/1/assignments", "/api/jobs/7/unassign", "/api/leads/1/attachments", "/api/departments/Electrical/jobs/1/logs", "/api/items", "/api/quotations/7"])
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal(permittedRoleWriteRequest(origin + path, method), false, method + " " + path);
  for (const value of ["https://crm.voltronix.ae/api/auth/login", "http://127.0.0.1:3002/api/auth/login", origin + "/api/%2e%2e/auth/login", "http://user:pass@127.0.0.1:3001/api/auth/login"])
    assert.equal(permittedRoleWriteRequest(value, "POST"), false);
});
test("role-write browser admits only documented task4/task7 write endpoints and source-valid log choices", () => {
  for (const path of ["/api/auth/login", "/api/auth/logout", "/api/jobs/7/assignments", "/api/leads/4/attachments", "/api/leads/7/attachments"])
    assert.equal(permittedRoleWriteRequest(origin + path, "POST"), true);
  for (const worker of workerPlan) {
    assert.equal(permittedRoleWriteRequest(origin + `/api/departments/${worker.department}/jobs/7/logs`, "POST"), true);
    assert.equal(permittedRoleWriteRequest(origin + `/api/departments/${worker.department}/jobs/7/status`, "PATCH"), true);
    const options = LOG_OPTIONS[worker.department]; const selections: readonly string[] = "authority" in options ? options.authority : options.scope;
    assert.ok(selections.includes(worker.selection)); assert.ok((options.status as readonly string[]).includes(worker.status));
  }
  assert.equal(retainedFilePlan.restrictive.buffer.toString(), "CRM SQLite role acceptance only. user=5 task=4 date=2026-10-13\n");
  assert.equal(retainedFilePlan.log.buffer.length, 35);
});
