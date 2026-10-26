import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { openDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { inspectPercentageQuotationExtension, PERCENTAGE_SCHEMA_OBJECTS } from "./percentage-schema.js";
import { databaseConfig, openDemo, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";

// Read-only final proof. This program cannot create sessions or submit API mutations.
type Row = Record<string, unknown>;
type Table = { count: number; rows: Record<string, string>; digest?: string };
type RoleReceipt = { status: string; final: { tables: Record<string, Table>; taskVersions: { id: number; version: number }[] } };
type QuoteReceipt = { status: string; taskId: string; quoteId: string; actorId: string; marker: string;
  checks: { name: string; status: string }[];
  operations: { operationId: string; httpStatus: number }[]; preservation: { existingRows: boolean; ownerSession: boolean } };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rows = (db: SqliteDatabase, table: string): Row[] => {
  assert.match(table, /^[a-z_]+$/); return db.prepare(`SELECT rowid AS __rowid,* FROM "${table}" ORDER BY rowid`).all() as Row[];
};
const schema = (db: SqliteDatabase) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as Row[];
const tableNames = (db: SqliteDatabase) => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
const sum = (db: SqliteDatabase) => tableNames(db).reduce((total, table) => total + rows(db, table).length, 0);
const beforeName = "crm-demo-5feb1631-c567-4693-a597-f5c0177ba822.sqlite";
const [mode, quoteRun, backupName] = process.argv.slice(2);
assert.ok(mode === "--read-only" || mode === "--read-only-backup"); assert.equal(process.argv.length, 5);
const historicalSnapshot = mode === "--read-only-backup";
assert.match(quoteRun ?? "", /^percentage-browser-[a-f0-9-]{36}$/);
assert.match(backupName ?? "", /^crm-demo-[a-f0-9-]{36}\.sqlite$/);
const backupFolder = privateDirectory(["backups"]), evidenceFolder = privateDirectory(["evidence"]);
const quoteDirectory = join(evidenceFolder, quoteRun!);
const roleReceipt = readPrivate(join(evidenceFolder, "approved-role-writes-f6be577f-a57a-439c-929d-2da3d39e8b47", "receipt.json")) as RoleReceipt;
const quoteReceipt = readPrivate(join(quoteDirectory, "receipt.json")) as QuoteReceipt;
const before = openDatabase({ ...databaseConfig, filename: join(backupFolder, beforeName) }, { readonly: true });
const after = historicalSnapshot ? openDatabase({ ...databaseConfig, filename: join(backupFolder, backupName!) }, { readonly: true }) : openDemo(true);
const finalBackup = openDatabase({ ...databaseConfig, filename: join(backupFolder, backupName!) }, { readonly: true });
const directory = privateDirectory(["evidence", "final-owner-preservation-" + randomUUID()], true);
const receipt: { status: string; checkedAtUtc: string; baseline: string; finalBackup: string; candidate: string; liveCompared: boolean; writes: number; checks: { name: string; status: string }[];
  counts?: unknown; differences?: unknown; operationIds?: string[]; newTaskId?: string; historicalQuoteHashes?: unknown } = {
  status: "FAIL", checkedAtUtc: new Date().toISOString(), baseline: beforeName, finalBackup: backupName!,
  candidate: historicalSnapshot ? backupName! : "live database", liveCompared: !historicalSnapshot, writes: 0, checks: [],
};
let stage = "Immutable receipt and backup guards";
function check(name: string, action: () => void) { stage = name; action(); receipt.checks.push({ name, status: "PASS" }); }
try {
  check(stage, () => {
    assert.equal(roleReceipt.status, "PASS"); assert.ok(["PASS", "FAIL"].includes(quoteReceipt.status)); assert.equal(quoteReceipt.actorId, "15");
    if (quoteReceipt.status === "FAIL") {
      assert.deepEqual(quoteReceipt.checks.filter(row => row.status === "FAIL").map(row => row.name), ["Existing records, passwords, grants, files and owner session preserved"]);
      assert.equal(quoteReceipt.checks.filter(row => row.status === "PASS").length, 9);
    }
    assert.equal(quoteReceipt.preservation.ownerSession, true);
    assert.match(quoteReceipt.taskId, /^[1-9][0-9]*$/); assert.match(quoteReceipt.marker, /^LOCAL PERCENTAGE ACCEPTANCE [a-f0-9-]{36}$/);
    for (const name of [beforeName, backupName!]) {
      const verified = readPrivate(join(backupFolder, name + ".json")) as { status: string; integrityVerified: boolean; filename: string };
      assert.equal(verified.status, "SQLITE_DEMO_BACKUP_CREATED"); assert.equal(verified.integrityVerified, true); assert.equal(verified.filename, join(backupFolder, name));
    }
    for (const db of [before, after, finalBackup]) { assert.equal(db.readonly, true); assert.equal(db.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(db.pragma("foreign_key_check"), []); }
  });
  check("Every original schema object unchanged; only reviewed percentage objects added", () => {
    const oldSchema = schema(before), currentSchema = schema(after), saved = new Map(oldSchema.map(row => [row.name, row]));
    for (const row of oldSchema) assert.equal(hash(currentSchema.find(value => value.name === row.name)), hash(row));
    const additions = currentSchema.filter(row => !saved.has(row.name)); assert.deepEqual(additions.map(row => row.name).sort(), PERCENTAGE_SCHEMA_OBJECTS.map(row => row.name).sort());
    assert.equal(inspectPercentageQuotationExtension(after), true);
  });
  check("Accounts passwords grants and complete owner session identical to before authorization", () => {
    for (const table of ["users", "admin_user_permissions", "permissions", "permission_groups", "crm_audit_events", "crm_sessions"])
      assert.equal(hash(rows(after, table)), hash(rows(before, table)), table);
  });
  check("Every original business row and file preserved except exact task4/task7 version timestamps", () => {
    const originalDifferences: unknown[] = [];
    for (const table of tableNames(before)) {
      if (["crm_login_attempts", "sqlite_sequence"].includes(table)) continue;
      const savedRows = rows(before, table), actualRows = rows(after, table), lookup = new Map(actualRows.map(row => [row.__rowid, row]));
      for (const old of savedRows) {
        const actual = lookup.get(old.__rowid); assert.ok(actual, table + " missing original row");
        if (table === "tasks" && [4, 7].includes(Number(old.id))) {
          const columns = Object.keys(old).filter(key => hash(old[key]) !== hash(actual[key]));
          assert.deepEqual(columns.sort(), ["updated_at", "version"]); assert.equal(actual.version, old.id === 4 ? 2 : 38);
          originalDifferences.push({ table, id: old.id, columns, beforeVersion: old.version, afterVersion: actual.version, updatedAt: actual.updated_at });
        } else assert.equal(hash(actual), hash(old), table + " changed original row");
      }
    }
    receipt.differences = originalDifferences;
  });
  check("All authorized role acceptance rows exactly match its retained passing receipt", () => {
    const quoteAppend = new Map([["tasks", 1], ["tasks_status_log", 1], ["crm_demo_local_tasks", 1], ["crm_demo_local_operations", 4], ["crm_demo_local_audit", 4]]);
    for (const [table, saved] of Object.entries(roleReceipt.final.tables)) {
      if (table === "crm_login_attempts") continue;
      const actualRows = rows(after, table), lookup = new Map(actualRows.map(row => [String(row.__rowid), hash(row)]));
      for (const [id, digest] of Object.entries(saved.rows)) assert.equal(lookup.get(id), digest, table + " differs from final role receipt");
      assert.equal(actualRows.length, saved.count + (quoteAppend.get(table) ?? 0), table + " unexpected new row count");
    }
  });
  check("Exactly one new owner deal and percentage quotation; four matching operations and audits", () => {
    const taskId = quoteReceipt.taskId, actorId = Number(quoteReceipt.actorId);
    assert.equal((before.prepare("SELECT COUNT(*) n FROM tasks WHERE id=?").get(taskId) as { n: number }).n, 0);
    const task = after.prepare("SELECT id,deal_crm_created_by,deal_name FROM tasks WHERE id=?").get(taskId) as Row; assert.equal(task.deal_crm_created_by, actorId);
    assert.ok(String(task.deal_name).includes("LOCAL PERCENTAGE ACCEPTANCE"));
    const local = after.prepare("SELECT * FROM crm_demo_local_tasks WHERE task_id=?").get(taskId) as Row; assert.equal(local.owner_user_id, actorId); assert.ok(String(local.input_json).includes(quoteReceipt.marker));
    const quoteRows = after.prepare("SELECT * FROM crm_demo_percentage_quotations").all() as Row[]; assert.equal(quoteRows.length, 1);
    const quote = quoteRows[0]!; assert.equal(String(quote.task_id), taskId); assert.equal(`local-${String(quote.id)}`, quoteReceipt.quoteId); assert.equal(quote.calculation_policy, "percentage-only-v2"); assert.equal(quote.version, 2);
    const input = JSON.parse(String(quote.quotation_json)) as Row, totals = JSON.parse(String(quote.totals_json)) as Row;
    assert.equal(input.discountType, "percentage"); assert.equal(input.discount, "5"); assert.equal((input.items as Row[])[0]!.itemDiscount, "20");
    assert.equal(totals.subtotal, "160.00"); assert.equal(totals.headerDiscount, "8"); assert.equal(totals.grandTotal, "159.60");
    const operations = after.prepare("SELECT * FROM crm_demo_local_operations WHERE task_id=? ORDER BY created_at").all(taskId) as Row[];
    assert.equal(operations.length, 4); assert.deepEqual(operations.map(row => row.kind).sort(), ["deal.create", "lead.stage", "quote.create", "quote.edit"]);
    const approvedIds = quoteReceipt.operations.filter(row => row.httpStatus === 200).map(row => row.operationId).sort(); assert.equal(approvedIds.length, 4);
    assert.deepEqual(operations.map(row => row.operation_id).sort(), approvedIds);
    const audit = after.prepare("SELECT * FROM crm_demo_local_audit WHERE task_id=? ORDER BY id").all(taskId) as Row[]; assert.equal(audit.length, 4);
    for (const operation of operations) {
      assert.equal(operation.actor_user_id, actorId); assert.equal(operation.state, "completed"); assert.equal(operation.remote_effect_possible, 0); assert.equal(operation.remote_references, "{}");
      const matching = audit.find(row => row.operation_id === operation.operation_id); assert.ok(matching); assert.equal(matching.actor_user_id, actorId); assert.equal(matching.action, operation.kind);
    }
    const stageLog = after.prepare("SELECT * FROM tasks_status_log WHERE Task_ID=?").all(taskId) as Row[];
    assert.equal(stageLog.length, 1); assert.equal(stageLog[0]!.User_ID, actorId); assert.equal(stageLog[0]!.Status, "Site Visit");
    assert.equal(stageLog[0]!.Task_Log_Create_Date, operations.find(row => row.kind === "lead.stage")!.created_at);
    for (const refusal of quoteReceipt.operations.filter(row => row.httpStatus >= 400)) assert.equal(operations.some(row => row.operation_id === refusal.operationId), false);
    receipt.newTaskId = taskId; receipt.operationIds = approvedIds;
  });
  check("Historical quotations and proposal items retain exact original bytes", () => {
    receipt.historicalQuoteHashes = ["crm_quotations", "proposal_items", "crm_demo_local_quotations"].map(table => {
      const oldHash = hash(rows(before, table)), newHash = hash(rows(after, table)); assert.equal(newHash, oldHash);
      return { table, rows: rows(before, table).length, beforeHash: oldHash, afterHash: newHash };
    });
  });
  check(historicalSnapshot ? "Historical snapshot sequence accounting; current live database is not compared" : "Only expected sequence values advance and final backup equals live database exactly", () => {
    const allowed = new Set(["departments_assign", "crm_department_work_logs", "crm_department_audit_events", "crm_attachment_audit_events", "crm_department_log_attachment_audit_events", "tasks", "tasks_status_log", "crm_demo_local_audit", "crm_demo_percentage_quotations"]);
    const oldSequence = before.prepare("SELECT name,seq FROM sqlite_sequence").all() as { name: string; seq: number }[];
    const nextSequence = after.prepare("SELECT name,seq FROM sqlite_sequence").all() as { name: string; seq: number }[];
    assert.equal(nextSequence.length, oldSequence.length + 1);
    for (const row of nextSequence) {
      const old = oldSequence.find(value => value.name === row.name);
      if (!allowed.has(row.name)) assert.equal(row.seq, old?.seq);
      else { assert.match(row.name, /^[a-z_]+$/); const maximum = after.prepare(`SELECT MAX(id) n FROM "${row.name}"`).get() as { n: number }; assert.equal(row.seq, maximum.n); }
    }
    if (!historicalSnapshot) {
      assert.deepEqual(schema(after), schema(finalBackup)); assert.deepEqual(tableNames(after), tableNames(finalBackup));
      for (const table of tableNames(after)) assert.equal(hash(rows(after, table)), hash(rows(finalBackup, table)), table + " differs from final backup");
    }
    receipt.counts = { beforeTables: tableNames(before).length, afterTables: tableNames(after).length, beforeRows: sum(before), afterRows: sum(after),
      tableCounts: tableNames(after).map(table => ({ table, before: tableNames(before).includes(table) ? rows(before, table).length : 0, after: rows(after, table).length })) };
  });
  receipt.status = "PASS";
} catch { receipt.checks.push({ name: stage, status: "FAIL" }); }
finally { before.close(); after.close(); finalBackup.close(); writePrivateNew(join(directory, "receipt.json"), receipt); }
console.log(JSON.stringify({ status: receipt.status, receipt: join(directory, "receipt.json"), passed: receipt.checks.filter(row => row.status === "PASS").length,
  failed: receipt.checks.filter(row => row.status === "FAIL").length, counts: receipt.counts, writes: 0 }));
process.exitCode = receipt.status === "PASS" ? 0 : 1;
