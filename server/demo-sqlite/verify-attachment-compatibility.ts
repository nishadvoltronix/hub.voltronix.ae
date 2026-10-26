import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { openDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { assertCompatibilityPreserved, compatibilitySnapshot } from "./attachment-compatibility-preservation.js";
import { databaseConfig, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";

// Read-only successor to the immutable source-parity checkpoint. No login or SQL mutation.
const [mode, finalName, migrationReceipt] = process.argv.slice(2);
assert.equal(process.argv.length, 5); assert.equal(mode, "--read-only");
assert.match(finalName ?? "", /^crm-demo-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.sqlite$/);
assert.match(migrationReceipt ?? "", /^attachment-compatibility-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/);
const beforeName = "crm-demo-d74ae274-aa78-4efe-93b5-063141333a5e.sqlite";
const priorName = "crm-demo-becb1445-f15d-4d80-8727-b46a0e22c007.sqlite";
const backups = privateDirectory(["backups"]), evidence = privateDirectory(["evidence"]);
const output: { status: string; at: string; checks: { name: string; status: string }[]; authenticationAttempts: number;
  databaseWrites: number; beforeBackup: string; finalBackup: string; migrationReceipt: string; rowCounts?: unknown; schemaChange?: unknown } = {
  status: "FAIL", at: new Date().toISOString(), checks: [], authenticationAttempts: 0, databaseWrites: 0,
  beforeBackup: beforeName, finalBackup: finalName!, migrationReceipt: migrationReceipt!,
};
let stage = "Verified immutable backup metadata";
function check(name: string, run: () => void) { stage = name; run(); output.checks.push({ name, status: "PASS" }); }
const connections = [beforeName, priorName, finalName!].map(name => openDatabase({ ...databaseConfig, filename: join(backups, name) }, { readonly: true }));
const live = openDatabase(databaseConfig, { readonly: true });
try {
  check(stage, () => {
    for (const name of [beforeName, priorName, finalName!]) {
      const meta = readPrivate(join(backups, name + ".json")) as { status: string; integrityVerified: boolean; filename: string };
      assert.equal(meta.status, "SQLITE_DEMO_BACKUP_CREATED"); assert.equal(meta.integrityVerified, true); assert.equal(meta.filename, join(backups, name));
    }
    assert.ok(connections.every(db => db.readonly)); assert.equal(live.readonly, true);
  });
  const [before, prior, final] = connections.map(db => compatibilitySnapshot(db));
  const current = compatibilitySnapshot(live);
  check("Fresh pre-upgrade backup exactly matches the previous verified 424-row checkpoint", () => { assert.deepEqual(before, prior); });
  check("Prior complete evidence remains PASS12/12 with the historical source browser FAIL retained", () => {
    const proof = readPrivate(join(evidence, "source-parity-preservation-700fa8d8-24d2-440c-b164-191d7f9df177", "receipt.json")) as {
      status: string; checks: { status: string }[]; finalBackup: string; authenticationAttempts: number; databaseWrites: number;
    };
    assert.equal(proof.status, "PASS"); assert.equal(proof.checks.length, 12); assert.ok(proof.checks.every(item => item.status === "PASS"));
    assert.equal(proof.finalBackup, priorName); assert.equal(proof.authenticationAttempts, 0); assert.equal(proof.databaseWrites, 0);
    const failed = readPrivate(join(evidence, "remaining-parity-6095bae2-fd50-476e-b89c-a5e92e2394dd", "receipt.json"));
    assert.equal(createHash("sha256").update(JSON.stringify(failed)).digest("hex"), "d580b4065e44d61161facb3e25ea0eeb985ed6433b3f75cccf68223a72401593");
  });
  check("All original rows, file bytes, sessions, audits and prior migration entries preserved; only M10/schema change allowed", () => {
    assertCompatibilityPreserved(before!, final!);
  });
  check("Final verified backup exactly equals current live schema and every row", () => { assert.deepEqual(current, final); });
  check("Upgrade receipt binds actor, reason, before backup, ledger and actual reviewed schema", () => {
    const migration = readPrivate(join(privateDirectory(["acceptance"]), migrationReceipt!)) as {
      status: string; actor: string; reason: string; backup: string; migration: { from: number; to: number; added: unknown };
      before: { tableCount: number; rows: number }; after: { tableCount: number; rows: number }; schemaBefore: unknown; schemaAfter: unknown; intentReceipt: string;
      originalRowidsAndBlobsPreserved: boolean; authenticationAttempts: number; businessWrites: number;
    };
    assert.equal(migration.status, "PASS"); assert.equal(migration.backup, join(backups, beforeName));
    assert.equal(migration.actor, "Account Owner request via local operator"); assert.ok(migration.reason.length > 0);
    assert.equal(migration.migration.from, 9); assert.equal(migration.migration.to, 10); assert.deepEqual(migration.migration.added, final!.ledger[9]);
    assert.equal(migration.originalRowidsAndBlobsPreserved, true); assert.equal(migration.authenticationAttempts, 0); assert.equal(migration.businessWrites, 0);
    assert.deepEqual(migration.schemaBefore, before!.schema.filter(row => row.tbl_name === "crm_department_log_attachments"));
    assert.deepEqual(migration.schemaAfter, final!.schema.filter(row => row.tbl_name === "crm_department_log_attachments"));
    const counts = (value: NonNullable<typeof before>) => ({ tableCount: Object.keys(value.tables).length,
      rows: Object.values(value.tables).reduce((sum, table) => sum + table.count, 0) });
    assert.deepEqual(migration.before, counts(before!)); assert.deepEqual(migration.after, counts(final!));
    assert.deepEqual(migration.before, { tableCount: 37, rows: 424 }); assert.deepEqual(migration.after, { tableCount: 37, rows: 425 });
    assert.equal(migration.intentReceipt, join(privateDirectory(["acceptance"]), migrationReceipt!.replace("attachment-compatibility-", "attachment-compatibility-intent-")));
    const intent = readPrivate(migration.intentReceipt) as { status: string; backup: string; beforeSha256: string };
    assert.equal(intent.status, "INTENT_ONLY"); assert.equal(intent.backup, migration.backup);
    assert.equal(intent.beforeSha256, createHash("sha256").update(JSON.stringify(before)).digest("hex"));
    output.rowCounts = { before: counts(before!), after: counts(final!) };
    output.schemaChange = { table: "crm_department_log_attachments", migration: final!.ledger[9] };
  });
  check("Original expired-owner incident stays FAILED with zero completed checks", () => {
    const failed = readPrivate(join(evidence, "browser-ea9cd75b-ab3c-40b7-b8e4-67531c08569c.json")) as { status: string; checks: unknown[] };
    assert.equal(failed.status, "FAILED"); assert.equal(failed.checks.length, 0);
  });
  output.status = "PASS";
} catch { output.checks.push({ name: stage, status: "FAIL" }); process.exitCode = 1; }
finally { connections.forEach(db => db.close()); live.close(); }
const receipt = join(privateDirectory(["evidence", "attachment-compatibility-preservation-" + randomUUID()], true), "receipt.json");
writePrivateNew(receipt, output); console.log(JSON.stringify({ ...output, receipt }));
