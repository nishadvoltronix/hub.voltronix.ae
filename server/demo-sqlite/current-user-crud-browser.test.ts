import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { allowedCrudRequest, readCrudMutationBody, validateCrudOptions, validateCrudResumeReceipt, type CrudBrowserOptions, type CrudOwnedRecords } from "./current-user-crud-browser.js";

const origin = "http://127.0.0.1:3001";
const options: CrudBrowserOptions = { origin, mode: "create", account: { email: "synthetic@example.invalid", password: "only synthetic test data" },
  existingPdfTaskIds: { contracting: "1", switchgear: "2" } };
const created: CrudOwnedRecords = { taskId: "501", productId: "9" + "1".repeat(39), noteId: "601", quoteId: "local-701",
  attachmentId: "12345678-1234-4234-8234-123456789abc", accountsAssignmentId: "801" };

test("Observed refusals never await an unused response body; committed body reads remain bounded", async () => {
  let reads = 0;
  for (const status of [403, 409, 503]) assert.deepEqual(await readCrudMutationBody({ status: () => status,
    json: () => { reads++; return new Promise<never>(() => undefined); } }, 10), {});
  assert.equal(reads, 0);
  assert.deepEqual(await readCrudMutationBody({ status: () => 200, json: async () => ({ version: 1 }) }, 50), { version: 1 });
  await assert.rejects(readCrudMutationBody({ status: () => 200, json: () => new Promise<never>(() => undefined) }, 10), { name: "TimeoutError" });
  await assert.rejects(readCrudMutationBody({ status: () => 200, json: async () => "invalid result" }, 50));
});

test("CRUD guard only advances from create endpoints to server-confirmed new record IDs", () => {
  const empty = { origin, mode: "create" as const, created: {} };
  for (const path of ["/api/items", "/api/deals"]) assert.equal(allowedCrudRequest(empty, origin + path, "POST"), true);
  for (const [path, method] of [["/api/leads/1/notes", "POST"], ["/api/leads/1/stage", "PATCH"], ["/api/quotations", "POST"],
    ["/api/jobs/1/remarks", "PATCH"], ["/api/jobs/1/accounts", "POST"], ["/api/leads/1/attachments", "POST"]])
    assert.equal(allowedCrudRequest(empty, origin + path, method!), false);
  const parent = { ...empty, created: { taskId: "501", productId: created.productId } };
  for (const path of ["/api/leads/501/notes", "/api/quotations", "/api/jobs/501/accounts", "/api/leads/501/attachments"])
    assert.equal(allowedCrudRequest(parent, origin + path, "POST"), true);
  for (const path of ["/api/items", "/api/deals"]) assert.equal(allowedCrudRequest(parent, origin + path, "POST"), false);
  const full = { ...empty, created };
  for (const path of ["/api/leads/501/notes/601", "/api/leads/501/stage", "/api/quotations/501", "/api/jobs/501/remarks", "/api/jobs/501/status"])
    assert.equal(allowedCrudRequest(full, origin + path, "PATCH"), true);
  for (const path of ["/api/leads/501/notes", "/api/jobs/501/accounts", "/api/leads/501/attachments", "/api/quotations"])
    assert.equal(allowedCrudRequest(full, origin + path, "POST"), false);
});

test("CRUD guard refuses old fixture edits, account administration, delete, remote and ambiguous URL targets", () => {
  const state = { origin, mode: "create" as const, created };
  for (const [path, method] of [["/api/leads/1/notes/601", "PATCH"], ["/api/leads/501/notes/1", "PATCH"],
    ["/api/quotations/1", "PATCH"], ["/api/jobs/1/status", "PATCH"], ["/api/jobs/501/assignments", "POST"],
    ["/api/jobs/501/unassign", "POST"], ["/api/settings/users/15/permissions", "PUT"], ["/api/settings/users/15/department", "PUT"],
    ["/api/settings/users/15/status", "PATCH"], ["/api/auth/password", "POST"], ["/api/leads/501", "DELETE"], ["/api/items/1", "PATCH"]])
    assert.equal(allowedCrudRequest(state, origin + path, method!), false);
  for (const url of ["http://localhost:3001/api/jobs/501/status", "http://127.0.0.1:3002/api/jobs/501/status", "https://example.invalid/api/jobs/501/status",
    "http://user@127.0.0.1:3001/api/jobs/501/status", origin + "/api/jobs/%35%30%31/status", origin + "/api/jobs/501/status?override=1", origin + "/api/jobs/501/status#fragment"])
    assert.equal(allowedCrudRequest(state, url, "PATCH"), false);
  for (const path of ["/.env.local", "/legacy/assets/active.js", "/api/jobs%2f501", "/private/access.json"])
    assert.equal(allowedCrudRequest(state, origin + path, "GET"), false);
});

test("Restart mode permits exact local reads and normal auth but denies every business write", () => {
  const state = { origin, mode: "resume" as const, created };
  for (const path of ["/api/auth/login", "/api/auth/logout"]) assert.equal(allowedCrudRequest(state, origin + path, "POST"), true);
  for (const path of ["/deals?_rsc=synthetic", "/jobs/501", "/api/leads/501/notes", "/api/jobs/501/assignments", "/api/quotations/1/pdf"])
    assert.equal(allowedCrudRequest(state, origin + path, "GET"), true);
  for (const path of ["/api/items", "/api/deals", "/api/leads/501/notes", "/api/leads/501/stage", "/api/quotations", "/api/quotations/501",
    "/api/jobs/501/accounts", "/api/jobs/501/status", "/api/jobs/501/remarks", "/api/leads/501/attachments"])
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal(allowedCrudRequest(state, origin + path, method), false);
});

test("CRUD input requires explicit mode, bounded memory credentials and an explicit resume receipt", () => {
  assert.doesNotThrow(() => validateCrudOptions(options));
  assert.doesNotThrow(() => validateCrudOptions({ ...options, mode: "resume", priorReceipt: "private receipt path" }));
  for (const invalid of [{ ...options, origin: "http://localhost:3001" }, { ...options, mode: undefined },
    { ...options, priorReceipt: "unexpected" }, { ...options, mode: "resume" },
    { ...options, account: { ...options.account, password: "x".repeat(73) } },
    { ...options, existingPdfTaskIds: { contracting: "../1", switchgear: "2" } }])
    assert.throws(() => validateCrudOptions(invalid as CrudBrowserOptions));
});

test("Restart provenance refuses unresolved/failed receipts, alternate read paths and changed attachment claims", () => {
  const runId = "12345678-1234-4234-8234-123456789abc", marker = `LOCAL CRUD ACCEPTANCE ${runId}`;
  const bytes = Buffer.from(`${marker}\nPersistent acceptance attachment.\n`);
  const paths = [`/api/items/${created.productId}`, "/api/leads/501", "/api/leads/501/capabilities", "/api/leads/501/notes",
    "/api/leads/501/history", "/api/quotations/501", "/api/jobs/501", "/api/jobs/501/assignments", "/api/leads/501/attachments"];
  const record = { schemaVersion: 1, kind: "current-user-local-crud", mode: "create", status: "PASS", actorId: "15", runId, marker, created,
    operations: Array.from({ length: 10 }, () => ({ status: "COMMITTED", eventId: runId, requestSha256: "a".repeat(64) })),
    snapshots: paths.map(path => ({ path, sha256: "b".repeat(64) })), ownSessionCleanup: "PASS",
    attachment: { filename: `local-crud-${runId}.txt`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
  assert.doesNotThrow(() => validateCrudResumeReceipt(record));
  for (const patch of [{ status: "FAIL" }, { mode: "resume" }, { actorId: "1" }, { marker: "historical fixture" }, { ownSessionCleanup: "FAIL" },
    { operations: [{ ...record.operations[0], status: "UNRESOLVED" }] }, { created: { ...created, taskId: "../501" } },
    { snapshots: [{ path: "/api/settings/users/15", sha256: "b".repeat(64) }, ...record.snapshots.slice(1)] },
    { attachment: { ...record.attachment, sha256: "c".repeat(64) } }]) assert.throws(() => validateCrudResumeReceipt({ ...record, ...patch }));
});
