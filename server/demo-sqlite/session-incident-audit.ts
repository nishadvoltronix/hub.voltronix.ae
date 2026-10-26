import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { databaseConfig, dataRoot, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";

// No HTTP/authentication, credential loading, restore, cleanup or database mutation.
type Row = Record<string, unknown>;
type Table = { count: number; sha256: string; rows: Record<string, string> };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const names = ["crm-demo-06dc5628-e027-49dd-af58-5d2f08737ca9.sqlite", "crm-demo-28b28a8b-17bf-438d-8350-46c1f3465c85.sqlite",
  "crm-demo-296226b5-bfe0-444e-a514-d661880b53bf.sqlite", "crm-demo-5c8aba7b-6c33-404d-b57b-8ac05cccf983.sqlite"];
function snapshot(db: SqliteDatabase, checkedAt: number) {
  assert.equal(db.readonly, true);
  return db.transaction(() => {
    const tables: Record<string, Table> = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]) {
      assert.match(name, /^[a-z_]+$/i);
      const rows = db.prepare(`SELECT rowid AS __rowid,* FROM "${name}" ORDER BY rowid`).all() as Row[];
      tables[name] = { count: rows.length, sha256: hash(rows), rows: Object.fromEntries(rows.map(row => [String(row.__rowid), hash(row)])) };
    }
    return { tables, tableCount: Object.keys(tables).length, rows: Object.values(tables).reduce((sum, table) => sum + table.count, 0),
      schema: hash(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()),
      integrity: db.pragma("integrity_check", { simple: true }), foreignKeyViolations: (db.pragma("foreign_key_check") as unknown[]).length,
      sessions: (db.prepare("SELECT user_id,created_at,expires_at FROM crm_sessions ORDER BY user_id,created_at").all() as { user_id: number; created_at: number; expires_at: number }[])
        .map(row => ({ userId: row.user_id, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), expiredAtAudit: row.expires_at <= checkedAt })),
      accounts: db.prepare("SELECT id,status,version,grants_version FROM users ORDER BY id").all(),
    };
  })();
}
type Snapshot = ReturnType<typeof snapshot>;
function comparison(before: Snapshot, after: Snapshot) {
  const changedTables = Object.keys(before.tables).filter(name => before.tables[name]!.sha256 !== after.tables[name]?.sha256)
    .map(name => { const old = before.tables[name]!, current = after.tables[name]!;
      return { name, before: old.count, after: current.count,
        addedRowIds: Object.keys(current.rows).filter(id => !(id in old.rows)),
        removedRowIds: Object.keys(old.rows).filter(id => !(id in current.rows)),
        changedRowIds: Object.keys(old.rows).filter(id => id in current.rows && old.rows[id] !== current.rows[id]) };
    });
  return { beforeRows: before.rows, afterRows: after.rows, unchangedTables: before.tableCount - changedTables.length, changedTables,
    schemaIdentical: before.schema === after.schema,
    allNonAuthenticationTablesIdentical: before.schema === after.schema && changedTables.every(table => ["crm_sessions", "crm_login_attempts"].includes(table.name)),
    sessionRowsIdentical: before.tables.crm_sessions!.sha256 === after.tables.crm_sessions!.sha256,
    everyTableIdentical: before.schema === after.schema && changedTables.length === 0 };
}

assert.deepEqual(process.argv.slice(2), ["--read-only"]);
const checkedAt = Date.now(), checkedAtUtc = new Date(checkedAt).toISOString();
const backupDirectory = privateDirectory(["backups"]), snapshots: Record<string, Snapshot> = {};
for (const name of names) {
  const verified = readPrivate(join(backupDirectory, name + ".json")) as { status: string; integrityVerified: boolean; filename: string };
  assert.equal(verified.status, "SQLITE_DEMO_BACKUP_CREATED"); assert.equal(verified.integrityVerified, true); assert.equal(verified.filename, join(backupDirectory, name));
  const db = openDatabase({ ...databaseConfig, filename: join(backupDirectory, name) }, { readonly: true });
  try { snapshots[name] = snapshot(db, checkedAt); } finally { db.close(); }
}
const liveDb = openDatabase(databaseConfig, { readonly: true });
try { snapshots.live = snapshot(liveDb, checkedAt); } finally { liveDb.close(); }
const allNames = [...names, "live"];
const transitions = allNames.slice(1).map((name, index) => ({ before: allNames[index]!, after: name, ...comparison(snapshots[allNames[index]!]!, snapshots[name]!) }));
const receiptRoot = privateDirectory(["evidence"]);
const failed = readPrivate(join(receiptRoot, "browser-ea9cd75b-ab3c-40b7-b8e4-67531c08569c.json")) as { status: string; checks: unknown[] };
const approved = readPrivate(join(receiptRoot, "remaining-parity-aed328c7-7f14-44e3-b897-cd23252a78d0", "receipt.json")) as { status: string; checks: { status: string }[] };
const incident = transitions[1]!;
const checks = {
  everySnapshotHealthy: Object.values(snapshots).every(value => value.integrity === "ok" && value.foreignKeyViolations === 0 && value.tableCount === 37),
  allBusinessAccountsGrantsAndFilesIdentical: transitions.every(value => value.allNonAuthenticationTablesIdentical),
  incidentPreciselyAuthenticationOnly: incident.beforeRows === 424 && incident.afterRows === 422 && incident.unchangedTables === 35
    && incident.changedTables.map(value => value.name).sort().join(",") === "crm_login_attempts,crm_sessions",
  historicalFailureRetained: failed.status === "FAILED" && failed.checks.length === 0 && !incident.sessionRowsIdentical,
  authorizedContinuationPassed: approved.status === "PASS" && approved.checks.length === 26 && approved.checks.every(value => value.status === "PASS"),
  currentMatchesFinalVerifiedBackup: transitions.at(-1)!.everyTableIdentical,
};
const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
const path = join(receiptRoot, `session-incident-audit-${randomUUID()}.json`);
writePrivateNew(path, { status, scope: "Read-only forensic audit and current remediation state; the original session-preservation incident remains historical FAIL.",
  checkedAtUtc, databaseWrites: 0, authenticationAttempts: 0, checks, transitions, snapshots,
  originalOwnerSessionContinuity: "FAIL: expired owner15 row was pruned by pre-approval normal user2 login; never restored, extended or recreated.",
  recovery: "Normal authorized login using existing owner credentials issues a new session. Never restore expired tokens or manipulate session rows.",
  evidence: { incident: join(receiptRoot, "browser-ea9cd75b-ab3c-40b7-b8e4-67531c08569c.json"), approvedContinuation: join(receiptRoot, "remaining-parity-aed328c7-7f14-44e3-b897-cd23252a78d0", "receipt.json") } });
console.log(JSON.stringify({ status, receipt: path.replace(dataRoot, "server/.local-data/development/sqlite-demo"), checkedAtUtc,
  checks, current: { tables: snapshots.live!.tableCount, rows: snapshots.live!.rows, sessions: snapshots.live!.sessions }, databaseWrites: 0, authenticationAttempts: 0 }));
if (status !== "PASS") process.exitCode = 1;
