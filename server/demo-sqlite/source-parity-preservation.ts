import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { assertOrdinaryPath, privateAccess } from "../scripts/mysql-auth/files.js";
import { databaseConfig, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";

// Independent read-only proof. Never imports credentials, authenticates, restores
// sessions, or executes any mutating SQL; only a new private proof receipt is written.
export const sourceParityBaseline = "crm-demo-19aeabfa-b055-407e-ad5a-d54903dc6e68.sqlite";
export const sourceParityScope = "PHP-source navigation, lists, permission target and recorded job details; GET/HEAD and normal login/logout only";
export const sourceParityContinuationScope = "Outstanding quotation layout and PM/Switchgear/Maintenance/restrictive source checks; GET/HEAD and normal login/logout only";
const partialDirectory = "remaining-parity-6095bae2-fd50-476e-b89c-a5e92e2394dd";
const partialReceiptSha256 = "d580b4065e44d61161facb3e25ea0eeb985ed6433b3f75cccf68223a72401593";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Table = { count: number; sha256: string; rows: Record<string, string> };
export interface SourceParitySnapshot {
  tables: Record<string, Table>; rows: number; tableCount: number; schema: string; ownerSession: string;
  integrity: unknown; foreignKeyViolations: number;
  sessions: { userId: number; createdAt: number; expiresAt: number }[];
}
type BrowserSnapshot = { tables: Record<string, { count: number; sha256: string }>; rows: number; schema: string; ownerSession: string };
export interface SourceParityBrowserReceipt {
  status: string; scope: string; directory: string; startedAt: string; finishedAt: string;
  checks: { name: string; status: string }[]; businessWrites: number; logins: number; logouts: number;
  pageErrors: number; blockedRequests: number; before: BrowserSnapshot; after: BrowserSnapshot;
  images: { filename: string; width: number; documentWidth: number }[];
  diagnostic?: string;
}
export function parseSourceParityProofArguments(args: readonly string[]) {
  assert.equal(args.length, 3); assert.equal(args[0], "--read-only");
  const finalBackup = args[1]!, browserDirectory = args[2]!;
  assert.match(finalBackup, /^crm-demo-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.sqlite$/);
  assert.match(browserDirectory, /^remaining-parity-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.notEqual(finalBackup, sourceParityBaseline);
  return { finalBackup, browserDirectory };
}
export function sourceParitySnapshot(db: SqliteDatabase): SourceParitySnapshot {
  assert.equal(db.readonly, true);
  return db.transaction(() => {
    const tables: Record<string, Table> = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]) {
      assert.match(name, /^[a-z_]+$/i);
      const values = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      const indexed = db.prepare(`SELECT rowid AS __rowid,* FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[];
      tables[name] = { count: values.length, sha256: hash(values), rows: Object.fromEntries(indexed.map(row => [String(row.__rowid), hash(row)])) };
    }
    return { tables, rows: Object.values(tables).reduce((sum, table) => sum + table.count, 0), tableCount: Object.keys(tables).length,
      schema: hash(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()),
      ownerSession: hash(db.prepare("SELECT * FROM crm_sessions WHERE user_id=15 ORDER BY token_hash").all()),
      integrity: db.pragma("integrity_check", { simple: true }), foreignKeyViolations: (db.pragma("foreign_key_check") as unknown[]).length,
      sessions: (db.prepare("SELECT user_id,created_at,expires_at FROM crm_sessions ORDER BY user_id,created_at").all() as { user_id: number; created_at: number; expires_at: number }[])
        .map(row => ({ userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at })),
    };
  })();
}
export function assertSourceParityBusinessPreserved(before: SourceParitySnapshot, after: SourceParitySnapshot) {
  assert.equal(before.tableCount, 37); assert.equal(after.tableCount, 37);
  assert.deepEqual(Object.keys(after.tables).sort(), Object.keys(before.tables).sort());
  assert.equal(after.schema, before.schema);
  const business = Object.keys(before.tables).filter(name => !["crm_sessions", "crm_login_attempts"].includes(name));
  assert.equal(business.length, 35);
  for (const name of business) assert.deepEqual(after.tables[name], before.tables[name]);
}
export function assertSourceParitySessionPreserved(before: SourceParitySnapshot, after: SourceParitySnapshot) {
  assert.equal(before.sessions.length, 1); assert.equal(before.sessions[0]!.userId, 2);
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.tables.crm_sessions, before.tables.crm_sessions);
  assert.equal(before.ownerSession, hash([])); assert.equal(after.ownerSession, before.ownerSession);
}
export function assertSourceParityBrowser(receipt: SourceParityBrowserReceipt) {
  assert.equal(receipt.status, "PASS"); assert.equal(receipt.scope, sourceParityScope);
  assert.equal(receipt.businessWrites, 0); assert.equal(receipt.pageErrors, 0); assert.equal(receipt.blockedRequests, 0);
  assert.equal(receipt.logins, 7); assert.equal(receipt.logouts, 7);
  assert.ok(receipt.checks.length > 0); assert.ok(receipt.checks.every(check => check.status === "PASS"));
  for (const userId of [15, 6, 7, 8, 9, 10, 5]) for (const action of ["normal unchanged-credential login", "normal test-session logout"]) {
    assert.equal(receipt.checks.filter(check => check.name === `User ${userId}: ${action}` && check.status === "PASS").length, 1);
  }
  assert.equal(receipt.checks.filter(check => check.name === "Zero business writes; complete schema/accounts/grants/files/records/owner-session preservation" && check.status === "PASS").length, 1);
  assertSourceParityImages(receipt);
}
function assertSourceParityImages(receipt: SourceParityBrowserReceipt) {
  assert.ok(receipt.images.length > 0);
  assert.equal(new Set(receipt.images.map(image => image.filename)).size, receipt.images.length);
  assert.deepEqual([...new Set(receipt.images.map(image => image.width))].sort((a, b) => a - b), [390, 768, 1440]);
  for (const image of receipt.images) {
    assert.match(image.filename, /^[a-zA-Z0-9_-]+\.png$/);
    assert.ok(Number.isFinite(image.documentWidth) && image.documentWidth > 0 && image.documentWidth <= image.width + 1);
  }
}
export function assertSourceParityContinuation(first: SourceParityBrowserReceipt, continuation: SourceParityBrowserReceipt) {
  assert.equal(first.status, "FAIL"); assert.equal(first.scope, sourceParityScope);
  assert.equal(first.checks.filter(check => check.status === "PASS").length, 22);
  assert.deepEqual(first.checks.filter(check => check.status !== "PASS"), [{ name: "User 8: PM recorded details and original status labels", status: "FAIL" }]);
  assert.equal(first.diagnostic, "Expected values to be strictly equal:\n+ actual - expected\n\n+ 'Completed'\n- 'COMPLETED'\n");
  assert.equal(first.images.length, 48);
  assert.equal(continuation.status, "PASS"); assert.equal(continuation.scope, sourceParityContinuationScope);
  assert.equal(continuation.checks.length, 19); assert.equal(continuation.images.length, 27);
  assert.ok(continuation.checks.every(check => check.status === "PASS"));
  for (const [receipt, ids] of [[first, [15, 6, 7, 8]], [continuation, [15, 8, 9, 10, 5]]] as const) {
    assert.equal(receipt.businessWrites, 0); assert.equal(receipt.pageErrors, 0); assert.equal(receipt.blockedRequests, 0);
    assert.equal(receipt.logins, ids.length); assert.equal(receipt.logouts, ids.length);
    for (const id of ids) for (const action of ["normal unchanged-credential login", "normal test-session logout"]) {
      assert.equal(receipt.checks.filter(check => check.name === `User ${id}: ${action}` && check.status === "PASS").length, 1);
    }
    assert.equal(receipt.checks.filter(check => check.name === "Zero business writes; complete schema/accounts/grants/files/records/owner-session preservation" && check.status === "PASS").length, 1);
    assertSourceParityImages(receipt);
    // Compare each interval, not just the final aggregate: a business/session
    // change followed by restoration must not disappear at the chain boundary.
    assert.equal(Object.keys(receipt.before.tables).length, 37);
    assert.deepEqual(Object.keys(receipt.after.tables).sort(), Object.keys(receipt.before.tables).sort());
    assert.equal(receipt.after.schema, receipt.before.schema); assert.equal(receipt.after.ownerSession, receipt.before.ownerSession);
    for (const name of Object.keys(receipt.before.tables).filter(name => name !== "crm_login_attempts")) {
      assert.deepEqual(receipt.after.tables[name], receipt.before.tables[name]);
    }
    assert.equal(receipt.after.rows - receipt.before.rows, receipt.after.tables.crm_login_attempts!.count - receipt.before.tables.crm_login_attempts!.count);
  }
  const required = ["Owner: corrected source quotation account wrapping and status colours at three widths",
    ...[9, 10, 5].map(id => `User ${id}: PHP Home and logo use the authorized landing page`),
    "User 8: PM recorded details and original status labels", "User 9: Switchgear recorded details and original status labels",
    "User 10: Maintenance recorded details and original status labels", "User 5: restricted landing and protected job/settings/foreign quotation refusals"];
  for (const name of required) {
    assert.equal(continuation.checks.filter(check => check.name === name && check.status === "PASS").length, 1);
  }
  assert.deepEqual(continuation.before, first.after);
  assert.ok(Date.parse(first.startedAt) <= Date.parse(first.finishedAt) && Date.parse(first.finishedAt) <= Date.parse(continuation.startedAt)
    && Date.parse(continuation.startedAt) <= Date.parse(continuation.finishedAt));
}
export function assertSourceParitySnapshotBinding(captured: BrowserSnapshot, saved: SourceParitySnapshot) {
  assert.equal(captured.rows, saved.rows); assert.equal(captured.schema, saved.schema); assert.equal(captured.ownerSession, saved.ownerSession);
  assert.deepEqual(captured.tables, Object.fromEntries(Object.entries(saved.tables).map(([name, table]) => [name, { count: table.count, sha256: table.sha256 }])));
}
export function assertSourceParityImageHeader(bytes: Buffer, viewportWidth: number) {
  assert.ok(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  assert.equal(bytes.readUInt32BE(16), viewportWidth); assert.ok(bytes.readUInt32BE(20) > 0);
}
export function runSourceParityProof(args: readonly string[]) {
  const { finalBackup, browserDirectory } = parseSourceParityProofArguments(args);
  const backups = privateDirectory(["backups"]), evidence = privateDirectory(["evidence"]);
  const outputDirectory = privateDirectory(["evidence", "source-parity-preservation-" + randomUUID()], true);
  const browserPath = join(evidence, browserDirectory, "receipt.json");
  const output: { status: string; checkedAtUtc: string; checks: { name: string; status: string }[]; databaseWrites: number;
    authenticationAttempts: number; baseline: string; finalBackup: string; browserReceipt: string; historicalSessionContinuity: string;
    failedCheck?: string; snapshots?: unknown; rowFingerprints?: unknown; loginDelta?: unknown; images?: unknown; historicalFailureSha256?: string; browserChain?: unknown } = {
    status: "FAIL", checkedAtUtc: new Date().toISOString(), checks: [], databaseWrites: 0, authenticationAttempts: 0,
    baseline: sourceParityBaseline, finalBackup, browserReceipt: browserPath,
    historicalSessionContinuity: "Original expired-owner session-continuity failure remains FAIL. This proof only checks preservation since the verified 19aeabfa checkpoint.",
  };
  let stage = "Read-only verified backups and live integrity";
  function check(name: string, action: () => void) { stage = name; action(); output.checks.push({ name, status: "PASS" }); }
  try {
    const snapshots: Record<string, SourceParitySnapshot> = {}, verifiedAt: Record<string, string> = {};
    check(stage, () => {
      for (const name of [sourceParityBaseline, finalBackup]) {
        const receipt = readPrivate(join(backups, name + ".json")) as { status: string; integrityVerified: boolean; filename: string; verifiedAt: string };
        assert.equal(receipt.status, "SQLITE_DEMO_BACKUP_CREATED"); assert.equal(receipt.integrityVerified, true);
        assert.equal(receipt.filename, join(backups, name)); assert.ok(Number.isFinite(Date.parse(receipt.verifiedAt))); verifiedAt[name] = receipt.verifiedAt;
        const db = openDatabase({ ...databaseConfig, filename: join(backups, name) }, { readonly: true });
        try { snapshots[name] = sourceParitySnapshot(db); } finally { db.close(); }
      }
      const db = openDatabase(databaseConfig, { readonly: true });
      try { snapshots.live = sourceParitySnapshot(db); } finally { db.close(); }
      for (const value of Object.values(snapshots)) { assert.equal(value.integrity, "ok"); assert.equal(value.foreignKeyViolations, 0); assert.equal(value.tableCount, 37); }
    });
    const before = snapshots[sourceParityBaseline]!, final = snapshots[finalBackup]!, live = snapshots.live!;
    output.rowFingerprints = { before: before.tables, after: final.tables };
    output.snapshots = Object.fromEntries(Object.entries(snapshots).map(([name, snapshot]) => [name, { ...snapshot,
      tables: Object.fromEntries(Object.entries(snapshot.tables).map(([table, value]) => [table, { count: value.count, sha256: value.sha256 }])) }]));
    check("Exact baseline retains 37 tables and 418 rows", () => { assert.equal(before.tableCount, 37); assert.equal(before.rows, 418); });
    check("Baseline binds to the retained 11-check recovery proof, without replacing its historical failure record", () => {
      const prior = readPrivate(join(evidence, "session-recovery-preservation-bf7673d8-e16a-40b2-bad5-c5da2a74e7a0", "receipt.json")) as {
        status: string; checks: { status: string }[]; databaseWrites: number; authenticationAttempts: number;
        finalBackup: string; snapshots: Record<string, { rows: number; schema: string; ownerSession: string }>;
        rowFingerprints: { after: SourceParitySnapshot["tables"] };
      };
      assert.equal(prior.status, "PASS"); assert.equal(prior.checks.length, 11); assert.ok(prior.checks.every(value => value.status === "PASS"));
      assert.equal(prior.databaseWrites, 0); assert.equal(prior.authenticationAttempts, 0); assert.equal(prior.finalBackup, sourceParityBaseline);
      const retained = prior.snapshots[sourceParityBaseline]!;
      assert.equal(retained.rows, before.rows); assert.equal(retained.schema, before.schema); assert.equal(retained.ownerSession, before.ownerSession);
      assert.deepEqual(prior.rowFingerprints.after, before.tables);
    });
    check("Complete schema and all 35 non-authentication tables unchanged", () => {
      for (const value of [final, live]) assertSourceParityBusinessPreserved(before, value);
    });
    check("Unrelated user2 session preserved byte-for-byte without owner-token restoration", () => {
      for (const value of [final, live]) assertSourceParitySessionPreserved(before, value);
    });
    const browser = readPrivate(browserPath) as SourceParityBrowserReceipt;
    const continuation = browser.scope === sourceParityContinuationScope;
    const first = continuation ? readPrivate(join(evidence, partialDirectory, "receipt.json")) as SourceParityBrowserReceipt : browser;
    const chain = continuation ? [first, browser] : [browser];
    check(continuation ? "Pinned 22-PASS/1-FAIL receipt plus passing outstanding continuation; nine normal login/logout pairs and zero writes"
      : "Source-only browser PASS, seven normal login/logout pairs and zero business writes or unexpected errors", () => {
      assert.equal(browser.directory, join(evidence, browserDirectory));
      if (continuation) {
        assert.equal(first.directory, join(evidence, partialDirectory)); assert.equal(hash(first), partialReceiptSha256);
        assertSourceParityContinuation(first, browser);
      } else assertSourceParityBrowser(browser);
      output.browserChain = chain.map(receipt => ({ directory: receipt.directory, status: receipt.status, scope: receipt.scope,
        passed: receipt.checks.filter(check => check.status === "PASS").length, failed: receipt.checks.filter(check => check.status === "FAIL").length,
        logins: receipt.logins, logouts: receipt.logouts, images: receipt.images.length, sha256: hash(receipt) }));
    });
    check("Browser before and after snapshots bind exactly to immutable baseline and final backup", () => {
      assertSourceParitySnapshotBinding(first.before, before); assertSourceParitySnapshotBinding(browser.after, final);
    });
    check("Live schema and every row exactly match final verified backup", () => {
      assert.deepEqual(live, final);
    });
    check("Only documented login-attempt bookkeeping differs from the baseline", () => {
      const changed = Object.keys(before.tables).filter(name => hash(before.tables[name]) !== hash(final.tables[name]));
      assert.ok(changed.every(name => name === "crm_login_attempts"));
      const previous = before.tables.crm_login_attempts!, current = final.tables.crm_login_attempts!;
      assert.equal(final.rows - before.rows, current.count - previous.count);
      output.loginDelta = { beforeRows: before.rows, afterRows: final.rows, changedTables: changed,
        loginRowsBefore: previous.count, loginRowsAfter: current.count,
        addedRowIds: Object.keys(current.rows).filter(id => !(id in previous.rows)),
        removedRowIds: Object.keys(previous.rows).filter(id => !(id in current.rows)),
        changedRowIds: Object.keys(previous.rows).filter(id => id in current.rows && previous.rows[id] !== current.rows[id]) };
    });
    check("Chronology binds baseline before login and verified final backup after logout while user2 remains valid", () => {
      const started = Date.parse(first.startedAt), finished = Date.parse(browser.finishedAt);
      assert.ok(Number.isFinite(started) && Number.isFinite(finished) && started <= finished);
      assert.ok(Date.parse(verifiedAt[sourceParityBaseline]!) <= started && finished <= Date.parse(verifiedAt[finalBackup]!));
      assert.ok(before.sessions[0]!.expiresAt > finished);
    });
    check("Every counted responsive screenshot exists with a recorded digest and preserved containment evidence", () => {
      output.images = chain.flatMap(receipt => receipt.images.map(image => {
        const filename = join(receipt.directory, image.filename);
        assertOrdinaryPath(receipt.directory, filename); privateAccess(filename, false);
        const stat = lstatSync(filename); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 8 && stat.size < 50_000_000);
        const bytes = readFileSync(filename); assertSourceParityImageHeader(bytes, image.width);
        return { ...image, directory: receipt.directory, receiptStatus: receipt.status, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      }));
    });
    check("Original incident receipt remains FAILED with zero completed checks", () => {
      const incident = readPrivate(join(evidence, "browser-ea9cd75b-ab3c-40b7-b8e4-67531c08569c.json")) as { status: string; checks: unknown[] };
      assert.equal(incident.status, "FAILED"); assert.equal(incident.checks.length, 0); output.historicalFailureSha256 = hash(incident);
    });
    output.status = "PASS";
  } catch { output.failedCheck = stage; output.checks.push({ name: stage, status: "FAIL" }); }
  writePrivateNew(join(outputDirectory, "receipt.json"), output);
  return { status: output.status, receipt: join(outputDirectory, "receipt.json"), checks: output.checks,
    databaseWrites: 0, authenticationAttempts: 0, loginDelta: output.loginDelta,
    screenshotCount: Array.isArray(output.images) ? output.images.length : 0 };
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try { const result = runSourceParityProof(process.argv.slice(2)); console.log(JSON.stringify(result)); if (result.status !== "PASS") process.exitCode = 1; }
  catch { console.error("Read-only source parity proof refused; no authentication or database writes performed."); process.exitCode = 1; }
}
