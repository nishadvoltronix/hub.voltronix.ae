import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { databaseConfig, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";

// Read-only proof: no HTTP, credentials, login, session restoration or SQL mutation.
type Row = Record<string, unknown>;
type Table = { count: number; sha256: string; rows: Record<string, string> };
type BrowserSnapshot = { tables: Record<string, { count: number; sha256: string }>; rows: number; schema: string; ownerSession: string };
type BrowserReceipt = { status: string; scope: string; directory: string; startedAt: string; finishedAt: string;
  checks: { name: string; status: string }[]; businessWrites: number; logins: number; logouts: number;
  pageErrors: number; blockedRequests: number; before: BrowserSnapshot; after: BrowserSnapshot };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const historical = ["crm-demo-06dc5628-e027-49dd-af58-5d2f08737ca9.sqlite", "crm-demo-28b28a8b-17bf-438d-8350-46c1f3465c85.sqlite",
  "crm-demo-296226b5-bfe0-444e-a514-d661880b53bf.sqlite", "crm-demo-5c8aba7b-6c33-404d-b57b-8ac05cccf983.sqlite"];
const preLogin = "crm-demo-1153d35a-e57f-44f0-b706-1fc202de1b82.sqlite";
const initialBrowserDirectory = "remaining-parity-1c218b5e-9e93-4e99-9928-4dabf58ca3bb";
const [mode, finalBackupName, browserDirectoryName] = process.argv.slice(2);
assert.equal(mode, "--read-only"); assert.equal(process.argv.length, 5);
assert.match(finalBackupName ?? "", /^crm-demo-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.sqlite$/);
assert.match(browserDirectoryName ?? "", /^remaining-parity-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
assert.ok(![...historical, preLogin].includes(finalBackupName!));
const backups = privateDirectory(["backups"]), evidence = privateDirectory(["evidence"]);
const directory = privateDirectory(["evidence", "session-recovery-preservation-" + randomUUID()], true);
const output: { status: string; checkedAtUtc: string; databaseWrites: number; authenticationAttempts: number;
  checks: { name: string; status: string }[]; failedCheck?: string; finalBackup: string; browserReceipt: string;
  historicalSessionContinuity: string; initialBrowserReceipt: string; snapshots?: unknown; rowFingerprints?: unknown; loginDelta?: unknown; historicalFailureDigest?: string } = {
  status: "FAIL", checkedAtUtc: new Date().toISOString(), databaseWrites: 0, authenticationAttempts: 0,
  checks: [], finalBackup: finalBackupName!, browserReceipt: join(evidence, browserDirectoryName!, "receipt.json"),
  initialBrowserReceipt: join(evidence, initialBrowserDirectory, "receipt.json"),
  historicalSessionContinuity: "Original pre-approval owner-session preservation remains FAIL. This proves subsequent normal recovery and current preservation, not restoration of an expired token.",
};
function snapshot(db: SqliteDatabase) {
  assert.equal(db.readonly, true);
  return db.transaction(() => {
    const tables: Record<string, Table> = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]) {
      assert.match(name, /^[a-z_]+$/i);
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      const indexed = db.prepare(`SELECT rowid AS __rowid,* FROM "${name}" ORDER BY rowid`).all() as Row[];
      tables[name] = { count: rows.length, sha256: hash(rows), rows: Object.fromEntries(indexed.map(row => [String(row.__rowid), hash(row)])) };
    }
    return { tables, rows: Object.values(tables).reduce((sum, table) => sum + table.count, 0), tableCount: Object.keys(tables).length,
      schema: hash(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()),
      ownerSession: hash(db.prepare("SELECT * FROM crm_sessions WHERE user_id=15 ORDER BY token_hash").all()),
      integrity: db.pragma("integrity_check", { simple: true }), foreignKeyViolations: (db.pragma("foreign_key_check") as unknown[]).length,
      sessions: (db.prepare("SELECT user_id,created_at,expires_at FROM crm_sessions ORDER BY user_id,created_at").all() as { user_id: number; created_at: number; expires_at: number }[])
        .map(row => ({ userId: row.user_id, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() })),
    };
  })();
}
type Snapshot = ReturnType<typeof snapshot>;
let stage = "Verified backup provenance and read-only database integrity";
function check(name: string, action: () => void) { stage = name; action(); output.checks.push({ name, status: "PASS" }); }
try {
  const snapshots: Record<string, Snapshot> = {}, verifiedAt: Record<string, string> = {};
  const names = [...historical, preLogin, finalBackupName!];
  check(stage, () => {
    for (const name of names) {
      const receipt = readPrivate(join(backups, name + ".json")) as { status: string; integrityVerified: boolean; filename: string; verifiedAt: string };
      assert.equal(receipt.status, "SQLITE_DEMO_BACKUP_CREATED"); assert.equal(receipt.integrityVerified, true);
      assert.equal(receipt.filename, join(backups, name)); assert.ok(Number.isFinite(Date.parse(receipt.verifiedAt))); verifiedAt[name] = receipt.verifiedAt;
      const db = openDatabase({ ...databaseConfig, filename: join(backups, name) }, { readonly: true });
      try { snapshots[name] = snapshot(db); } finally { db.close(); }
    }
    const db = openDatabase(databaseConfig, { readonly: true });
    try { snapshots.live = snapshot(db); } finally { db.close(); }
    for (const value of Object.values(snapshots)) { assert.equal(value.integrity, "ok"); assert.equal(value.foreignKeyViolations, 0); assert.equal(value.tableCount, 37); }
  });
  // Keep the private receipt bounded; compare every row in memory and retain full
  // before/after row fingerprints once, plus whole-table proofs for all checkpoints.
  output.snapshots = Object.fromEntries(Object.entries(snapshots).map(([name, value]) => [name, { ...value,
    tables: Object.fromEntries(Object.entries(value.tables).map(([table, content]) => [table,
      { count: content.count, sha256: content.sha256, rowFingerprintsSha256: hash(content.rows) }])) }]));
  const first = snapshots[historical[0]!]!, before = snapshots[preLogin]!, final = snapshots[finalBackupName!]!, live = snapshots.live!;
  output.rowFingerprints = { before: before.tables, after: final.tables };
  const business = Object.keys(first.tables).filter(name => !["crm_sessions", "crm_login_attempts"].includes(name));
  check("Complete schema identical across all six verified backups and live database", () => {
    for (const value of Object.values(snapshots)) assert.equal(value.schema, first.schema);
  });
  check("All 35 non-authentication tables and every row preserved across all checkpoints", () => {
    assert.equal(business.length, 35);
    for (const value of Object.values(snapshots)) for (const name of business) assert.deepEqual(value.tables[name], first.tables[name]);
  });
  check("Current unrelated user2 session preserved exactly from pre-login backup to final and live", () => {
    assert.equal(before.sessions.length, 1); assert.equal(before.sessions[0]!.userId, 2);
    for (const value of [final, live]) {
      assert.deepEqual(value.tables.crm_sessions, before.tables.crm_sessions); assert.deepEqual(value.sessions, before.sessions);
      assert.equal(value.ownerSession, hash([]));
    }
  });
  const browser = readPrivate(output.browserReceipt) as BrowserReceipt;
  const initialBrowser = readPrivate(output.initialBrowserReceipt) as BrowserReceipt;
  check("First quote readback retains overall FAIL with exactly nine passing checks and one picker locator failure", () => {
    assert.equal(initialBrowser.status, "FAIL"); assert.equal(initialBrowser.directory, join(evidence, initialBrowserDirectory));
    assert.equal(initialBrowser.scope, "Historical/current quotation policy, recorded dates, PDF and source product selection; GET/HEAD and normal owner login/logout only");
    assert.equal(initialBrowser.checks.filter(value => value.status === "PASS").length, 9);
    assert.deepEqual(initialBrowser.checks.filter(value => value.status !== "PASS"), [{
      name: "Edit product search preserves unsaved description and price until explicit selection", status: "FAIL" }]);
    assert.equal(initialBrowser.logins, 1); assert.equal(initialBrowser.logouts, 1); assert.equal(initialBrowser.businessWrites, 0);
    assert.equal(initialBrowser.pageErrors, 0); assert.equal(initialBrowser.blockedRequests, 0);
  });
  check("Targeted owner browser PASS with exactly one normal login/logout and zero business writes", () => {
    assert.equal(browser.status, "PASS"); assert.equal(browser.directory, join(evidence, browserDirectoryName!));
    assert.equal(browser.scope, "Outstanding source product selection; GET/HEAD and normal owner login/logout only");
    assert.ok(browser.checks.length > 0); assert.ok(browser.checks.every(value => value.status === "PASS"));
    assert.equal(browser.logins, 1); assert.equal(browser.logouts, 1); assert.equal(browser.businessWrites, 0);
    assert.equal(browser.pageErrors, 0); assert.equal(browser.blockedRequests, 0);
    for (const name of ["User 15: normal unchanged-credential login", "User 15: normal test-session logout",
      "Zero business writes; complete schema/accounts/grants/files/records/owner-session preservation"]) {
      for (const receipt of [initialBrowser, browser]) assert.equal(receipt.checks.filter(value => value.name === name && value.status === "PASS").length, 1);
    }
  });
  check("Both browser snapshots form an exact preservation chain between pre-login and final verified backups", () => {
    assert.deepEqual(initialBrowser.after, browser.before);
    for (const [captured, saved] of [[initialBrowser.before, before], [browser.after, final]] as const) {
      assert.equal(captured.rows, saved.rows); assert.equal(captured.schema, saved.schema); assert.equal(captured.ownerSession, saved.ownerSession);
      assert.deepEqual(Object.keys(captured.tables).sort(), Object.keys(saved.tables).sort());
      for (const [name, table] of Object.entries(saved.tables)) assert.deepEqual(captured.tables[name], { count: table.count, sha256: table.sha256 });
    }
  });
  check("Current live schema and every table row exactly match final verified backup", () => {
    assert.equal(live.schema, final.schema); assert.equal(live.rows, final.rows); assert.deepEqual(live.tables, final.tables);
  });
  check("Only normal login-attempt bookkeeping differs across the authorized recovery window", () => {
    const changed = Object.keys(before.tables).filter(name => hash(before.tables[name]) !== hash(final.tables[name]));
    assert.ok(changed.every(name => name === "crm_login_attempts"));
    const old = before.tables.crm_login_attempts!, current = final.tables.crm_login_attempts!;
    output.loginDelta = { beforeRows: before.rows, afterRows: final.rows, changedTables: changed,
      loginAttemptRowsBefore: old.count, loginAttemptRowsAfter: current.count,
      addedRowIds: Object.keys(current.rows).filter(id => !(id in old.rows)), removedRowIds: Object.keys(old.rows).filter(id => !(id in current.rows)),
      changedRowIds: Object.keys(old.rows).filter(id => id in current.rows && old.rows[id] !== current.rows[id]) };
  });
  check("Chronology establishes verified pre-login and post-logout backups with unrelated session still valid", () => {
    const initialStarted = Date.parse(initialBrowser.startedAt), initialFinished = Date.parse(initialBrowser.finishedAt);
    const started = Date.parse(browser.startedAt), finished = Date.parse(browser.finishedAt);
    assert.ok([initialStarted, initialFinished, started, finished].every(Number.isFinite));
    assert.ok(initialStarted <= initialFinished && initialFinished <= started && started <= finished);
    assert.ok(Date.parse(verifiedAt[preLogin]!) <= initialStarted); assert.ok(finished <= Date.parse(verifiedAt[finalBackupName!]!));
    assert.ok(Date.parse(before.sessions[0]!.expiresAt) > finished);
  });
  check("Original pre-approval failed receipt and historical owner-session replacement remain explicit", () => {
    const failed = readPrivate(join(evidence, "browser-ea9cd75b-ab3c-40b7-b8e4-67531c08569c.json")) as { status: string; checks: unknown[] };
    assert.equal(failed.status, "FAILED"); assert.equal(failed.checks.length, 0); output.historicalFailureDigest = hash(failed);
    assert.notEqual(snapshots[historical[1]!]!.tables.crm_sessions!.sha256, snapshots[historical[2]!]!.tables.crm_sessions!.sha256);
  });
  output.status = "PASS";
} catch {
  output.failedCheck = stage; output.checks.push({ name: stage, status: "FAIL" });
} finally {
  writePrivateNew(join(directory, "receipt.json"), output);
  console.log(JSON.stringify({ status: output.status, receipt: join(directory, "receipt.json"), checks: output.checks,
    databaseWrites: 0, authenticationAttempts: 0, finalBackup: finalBackupName, loginDelta: output.loginDelta }));
  if (output.status !== "PASS") process.exitCode = 1;
}
