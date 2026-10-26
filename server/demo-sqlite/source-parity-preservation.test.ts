import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { assertSourceParityBrowser, assertSourceParityBusinessPreserved, assertSourceParityContinuation, assertSourceParitySessionPreserved,
  assertSourceParitySnapshotBinding, assertSourceParityImageHeader, parseSourceParityProofArguments, sourceParityBaseline, sourceParityScope,
  sourceParityContinuationScope, sourceParitySnapshot, type SourceParityBrowserReceipt, type SourceParitySnapshot } from "./source-parity-preservation.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function snapshot(): SourceParitySnapshot {
  const tables = Object.fromEntries(Array.from({ length: 35 }, (_, index) => ["business_" + index,
    { count: 1, sha256: hash([index]), rows: { "1": hash({ value: index }) } }]));
  tables.crm_sessions = { count: 1, sha256: hash("unchanged-session"), rows: { "1": hash("private-token-digest") } };
  tables.crm_login_attempts = { count: 2, sha256: hash("old-login-buckets"), rows: { "1": hash("old-bucket") } };
  return { tables, rows: 38, tableCount: 37, schema: hash("synthetic-schema"), ownerSession: hash([]), integrity: "ok", foreignKeyViolations: 0,
    sessions: [{ userId: 2, createdAt: 1000, expiresAt: 10000 }] };
}
function browser(): SourceParityBrowserReceipt {
  const before = snapshot();
  const captured = { rows: before.rows, schema: before.schema, ownerSession: before.ownerSession,
    tables: Object.fromEntries(Object.entries(before.tables).map(([name, table]) => [name, { count: table.count, sha256: table.sha256 }])) };
  return { status: "PASS", scope: sourceParityScope, directory: "synthetic-only", startedAt: "2026-10-13T11:20:00.000Z", finishedAt: "2026-10-13T11:21:00.000Z",
    checks: [...[15, 6, 7, 8, 9, 10, 5].flatMap(id => ["normal unchanged-credential login", "normal test-session logout"].map(action => ({ name: `User ${id}: ${action}`, status: "PASS" }))),
      { name: "Zero business writes; complete schema/accounts/grants/files/records/owner-session preservation", status: "PASS" }],
    businessWrites: 0, logins: 7, logouts: 7, pageErrors: 0, blockedRequests: 0, before: captured, after: structuredClone(captured),
    images: [1440, 768, 390].map(width => ({ filename: `synthetic-${width}.png`, width, documentWidth: width })) };
}
function continuationChain() {
  const first = structuredClone(browser()), continuation = structuredClone(browser());
  const auth = (ids: number[]) => ids.flatMap(id => ["normal unchanged-credential login", "normal test-session logout"]
    .map(action => ({ name: `User ${id}: ${action}`, status: "PASS" })));
  const preservation = { name: "Zero business writes; complete schema/accounts/grants/files/records/owner-session preservation", status: "PASS" };
  first.status = "FAIL"; first.logins = first.logouts = 4;
  first.checks = [...auth([15, 6, 7, 8]), preservation, ...Array.from({ length: 13 }, (_, index) => ({ name: `Previously completed ${index}`, status: "PASS" })),
    { name: "User 8: PM recorded details and original status labels", status: "FAIL" }];
  first.diagnostic = "Expected values to be strictly equal:\n+ actual - expected\n\n+ 'Completed'\n- 'COMPLETED'\n";
  first.images = Array.from({ length: 16 }, (_, index) => browser().images.map(image => ({ ...image, filename: `partial-${index}-${image.width}.png` }))).flat();
  first.after.tables.crm_login_attempts = { count: 5, sha256: hash("first normal logins") }; first.after.rows += 3;
  continuation.scope = sourceParityContinuationScope; continuation.logins = continuation.logouts = 5;
  continuation.startedAt = "2026-10-13T11:22:00.000Z"; continuation.finishedAt = "2026-10-13T11:23:00.000Z";
  continuation.before = structuredClone(first.after); continuation.after = structuredClone(first.after);
  continuation.after.tables.crm_login_attempts = { count: 8, sha256: hash("continuation normal logins") }; continuation.after.rows += 3;
  continuation.checks = [...auth([15, 8, 9, 10, 5]), preservation,
    ...["Owner: corrected source quotation account wrapping and status colours at three widths",
      ...[9, 10, 5].map(id => `User ${id}: PHP Home and logo use the authorized landing page`),
      "User 8: PM recorded details and original status labels", "User 9: Switchgear recorded details and original status labels",
      "User 10: Maintenance recorded details and original status labels", "User 5: restricted landing and protected job/settings/foreign quotation refusals"]
      .map(name => ({ name, status: "PASS" }))];
  continuation.images = Array.from({ length: 9 }, (_, index) => browser().images.map(image => ({ ...image, filename: `continuation-${index}-${image.width}.png` }))).flat();
  return { first, continuation };
}

test("source preservation CLI accepts exact read-only basenames and refuses traversal or baseline overwrite before I/O", () => {
  const backup = "crm-demo-00000000-0000-0000-0000-000000000001.sqlite", receipt = "remaining-parity-00000000-0000-0000-0000-000000000002";
  assert.deepEqual(parseSourceParityProofArguments(["--read-only", backup, receipt]), { finalBackup: backup, browserDirectory: receipt });
  for (const args of [[], [backup, receipt], ["--read-write", backup, receipt], ["--read-only", "../" + backup, receipt],
    ["--read-only", backup, "../" + receipt], ["--read-only", sourceParityBaseline, receipt], ["--read-only", backup, receipt, "extra"]]) {
    assert.throws(() => parseSourceParityProofArguments(args));
  }
});

test("source snapshot refuses a writable handle before any SQL can execute", () => {
  const database = { readonly: false, transaction() { throw new Error("SQL must not run"); } } as unknown as SqliteDatabase;
  assert.throws(() => sourceParitySnapshot(database), { code: "ERR_ASSERTION" });
});

test("source proof catches equal-count business changes, row fingerprint changes, replaced tables and schema drift", () => {
  const before = snapshot();
  assert.doesNotThrow(() => assertSourceParityBusinessPreserved(before, structuredClone(before)));
  for (const change of [
    (after: SourceParitySnapshot) => { after.tables.business_0!.sha256 = hash("different same-count value"); },
    (after: SourceParitySnapshot) => { after.tables.business_0!.rows["1"] = hash("changed row fingerprint"); },
    (after: SourceParitySnapshot) => { after.tables.unexpected = after.tables.business_0!; delete after.tables.business_0; },
    (after: SourceParitySnapshot) => { after.schema = hash("different schema"); },
  ]) { const after = structuredClone(before); change(after); assert.throws(() => assertSourceParityBusinessPreserved(before, after)); }
  const allowed = structuredClone(before); allowed.tables.crm_login_attempts!.sha256 = hash("new normal buckets");
  assert.doesNotThrow(() => assertSourceParityBusinessPreserved(before, allowed));
});

test("source session proof refuses token replacement, metadata drift or restored owner even when row count is unchanged", () => {
  const before = snapshot(); assert.doesNotThrow(() => assertSourceParitySessionPreserved(before, structuredClone(before)));
  for (const change of [
    (after: SourceParitySnapshot) => { after.tables.crm_sessions!.sha256 = hash("new token same user"); },
    (after: SourceParitySnapshot) => { after.sessions[0]!.expiresAt++; },
    (after: SourceParitySnapshot) => { after.sessions[0]!.userId = 15; },
    (after: SourceParitySnapshot) => { after.ownerSession = hash(["restored owner"]); },
  ]) { const after = structuredClone(before); change(after); assert.throws(() => assertSourceParitySessionPreserved(before, after)); }
});

test("source browser proof cannot relabel a failed, write-capable, incomplete-role or unsafe-image receipt PASS", () => {
  assert.doesNotThrow(() => assertSourceParityBrowser(browser()));
  for (const change of [
    (receipt: SourceParityBrowserReceipt) => { receipt.status = "FAIL"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.scope = "broad write scope"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.businessWrites = 1; },
    (receipt: SourceParityBrowserReceipt) => { receipt.logouts = 6; },
    (receipt: SourceParityBrowserReceipt) => { receipt.checks[0]!.status = "FAIL"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.checks.splice(0, 1); },
    (receipt: SourceParityBrowserReceipt) => { receipt.blockedRequests = 1; },
    (receipt: SourceParityBrowserReceipt) => { receipt.images[0]!.filename = "../secret.png"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.images[0]!.filename = receipt.images[1]!.filename; },
    (receipt: SourceParityBrowserReceipt) => { receipt.images[0]!.documentWidth = 2000; },
    (receipt: SourceParityBrowserReceipt) => { receipt.images.splice(0, 1); },
  ]) { const receipt = browser(); change(receipt); assert.throws(() => assertSourceParityBrowser(receipt)); }
});

test("source snapshot binding rejects equal row totals with changed table data or a missing table", () => {
  const saved = snapshot(), receipt = browser();
  assert.doesNotThrow(() => assertSourceParitySnapshotBinding(receipt.before, saved));
  receipt.before.tables.business_0!.sha256 = hash("same count different account");
  assert.throws(() => assertSourceParitySnapshotBinding(receipt.before, saved));
  const missing = browser(); delete missing.before.tables.business_0;
  assert.throws(() => assertSourceParitySnapshotBinding(missing.before, saved));
});

test("source image proof binds PNG dimensions to the claimed viewport rather than trusting the filename", () => {
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(390, 16); bytes.writeUInt32BE(1024, 20);
  assert.doesNotThrow(() => assertSourceParityImageHeader(bytes, 390));
  assert.throws(() => assertSourceParityImageHeader(bytes, 1440));
  assert.throws(() => assertSourceParityImageHeader(bytes.subarray(0, 23), 390));
  bytes.writeUInt32BE(0, 20); assert.throws(() => assertSourceParityImageHeader(bytes, 390));
});

test("source continuation proves the partial failure and newly outstanding checks without relabelling either receipt", () => {
  const { first, continuation } = continuationChain();
  assert.doesNotThrow(() => assertSourceParityContinuation(first, continuation));
  assert.equal(first.status, "FAIL"); assert.equal(first.checks.filter(check => check.status === "FAIL").length, 1);
  assert.equal(continuation.status, "PASS"); assert.equal(first.logins + continuation.logins, 9);
  assert.throws(() => assertSourceParityBrowser(first)); assert.throws(() => assertSourceParityBrowser(continuation));
});

test("source continuation refuses an unrelated failure, hidden additional failure or changed read-only scope", () => {
  for (const change of [
    (receipt: SourceParityBrowserReceipt) => { receipt.status = "PASS"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.checks.at(-1)!.name = "Unrelated application failure"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.checks[0]!.status = "FAIL"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.diagnostic = "Different failure"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.businessWrites = 1; },
    (receipt: SourceParityBrowserReceipt) => { receipt.logouts = 3; },
    (receipt: SourceParityBrowserReceipt) => { receipt.images.pop(); },
  ]) { const { first, continuation } = continuationChain(); change(first); assert.throws(() => assertSourceParityContinuation(first, continuation)); }
});

test("source continuation refuses missing boundary evidence and detects intermediate business or session changes even if restored", () => {
  for (const change of [
    (first: SourceParityBrowserReceipt, second: SourceParityBrowserReceipt) => { second.before.tables.crm_login_attempts!.sha256 = hash("missing intervening activity"); },
    (first: SourceParityBrowserReceipt, second: SourceParityBrowserReceipt) => { first.after.tables.business_0!.sha256 = hash("temporarily changed"); second.before = structuredClone(first.after); },
    (first: SourceParityBrowserReceipt, second: SourceParityBrowserReceipt) => { first.after.tables.crm_sessions!.sha256 = hash("temporarily replaced session"); second.before = structuredClone(first.after); },
    (first: SourceParityBrowserReceipt, second: SourceParityBrowserReceipt) => { second.startedAt = first.startedAt; },
    (_first: SourceParityBrowserReceipt, second: SourceParityBrowserReceipt) => { second.after.rows++; },
    (_first: SourceParityBrowserReceipt, second: SourceParityBrowserReceipt) => { delete second.before.tables.business_0; },
  ]) { const { first, continuation } = continuationChain(); change(first, continuation); assert.throws(() => assertSourceParityContinuation(first, continuation)); }
});

test("source continuation refuses incomplete roles, replayed completed checks, wrong screenshot count or new errors", () => {
  for (const change of [
    (receipt: SourceParityBrowserReceipt) => { receipt.checks[0]!.name = "User 6: normal unchanged-credential login"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.checks.at(-1)!.name = "Owner: previously completed checks replayed"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.checks[11]!.name = "Owner: source quotation list columns and actual deal/download links"; },
    (receipt: SourceParityBrowserReceipt) => { receipt.logins = receipt.logouts = 4; },
    (receipt: SourceParityBrowserReceipt) => { receipt.checks.pop(); },
    (receipt: SourceParityBrowserReceipt) => { receipt.scope = sourceParityScope; },
    (receipt: SourceParityBrowserReceipt) => { receipt.pageErrors = 1; },
    (receipt: SourceParityBrowserReceipt) => { receipt.images.pop(); },
  ]) { const { first, continuation } = continuationChain(); change(continuation); assert.throws(() => assertSourceParityContinuation(first, continuation)); }
});
