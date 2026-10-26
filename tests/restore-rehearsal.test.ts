import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import Database from "better-sqlite3";
import { filesystemFixture } from "./database-fixture";
import { openDatabase } from "../src/server/db/connection";
import { backupDatabase } from "../src/server/db/backup";
import { migrateDatabase, migrations } from "../src/server/db/migrations";
import { rehearseBackup, RestoreRehearsalError } from "../src/server/db/restore-rehearsal";

async function fixture() {
  const fs = filesystemFixture(), db = openDatabase(fs.config, { create: true });
  migrateDatabase(db);
  db.prepare("INSERT INTO users(username,email,password) VALUES(?,?,?)").run("Synthetic recovery-only user", "recovery@example.invalid", "Synthetic hash, never a runtime identity");
  const backup = await backupDatabase(db, fs.config);
  return { ...fs, db, backup, relativeBackup: relative(fs.root, backup), finish() { db.close(); fs.cleanup(); } };
}
function noOwnedCopy(root: string) {
  const testRoot = join(root, ".local-data", "test");
  assert.deepEqual(readdirSync(testRoot).filter((name) => name.startsWith("restore-check-")), []);
}

test("completed online backup with committed WAL rows rehearses current schema without touching active data or backup", async () => {
  const f = await fixture();
  try {
    assert.ok(existsSync(f.config.filename + "-wal"));
    const before = readFileSync(f.backup);
    assert.equal(statSync(f.backup + "-wal").size, 0, "validator's inert sidecars are supported without deleting them");
    f.db.prepare("INSERT INTO users(username,email,password) VALUES(?,?,?)").run("Newer isolated test record", "newer@example.invalid", "Synthetic only");
    const result = await rehearseBackup(f.root, f.relativeBackup);
    assert.deepEqual(result.versions, migrations.map(({ version }) => version));
    assert.equal(result.tables.find(({ name }) => name === "users")!.rowCount, "1");
    assert.equal(result.targetHostVerified, false); assert.equal(result.existingDatabaseReplaced, false);
    assert.equal(result.schemaMatchesCurrentMigrations, true);
    assert.equal((f.db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n, 2);
    assert.deepEqual(readFileSync(f.backup), before); noOwnedCopy(f.root);
    assert.deepEqual(await rehearseBackup(f.root, f.relativeBackup), result); noOwnedCopy(f.root);
  } finally { f.finish(); }
});

test("rehearsal rejects arbitrary paths, incomplete markers and sidecars without changing the snapshot", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.backup);
    for (const value of [f.backup, ".local-data/development/crm.sqlite", ".local-data/backups/../test/crm.sqlite", f.relativeBackup + "/extra"]) {
      await assert.rejects(rehearseBackup(f.root, value), RestoreRehearsalError);
    }
    const marker = join(dirname(f.backup), "complete.json"), original = readFileSync(marker);
    for (const value of ['{}', '{"formatVersion":1,"environment":"development","completedAt":"bad"}', 'null', "x".repeat(1025),
      ...[["test"], { label: "test" }, "development"].map((environment) => JSON.stringify({ ...JSON.parse(original.toString("utf8")), environment }))]) {
      writeFileSync(marker, value); await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError);
    }
    writeFileSync(marker, original);
    writeFileSync(f.backup + "-wal", "test-only");
    await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError);
    unlinkSync(f.backup + "-wal");
    writeFileSync(f.backup + "-journal", "test-only");
    await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError);
    unlinkSync(f.backup + "-journal"); assert.deepEqual(readFileSync(f.backup), before); noOwnedCopy(f.root);
  } finally { f.finish(); }
});

test("corrupt backup, altered history and orphan references fail safely and clean only the owned rehearsal copy", async () => {
  const f = await fixture();
  try {
    const original = readFileSync(f.backup);
    writeFileSync(f.backup, "Synthetic invalid SQLite file");
    await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError); noOwnedCopy(f.root);
    writeFileSync(f.backup, original);
    const editFixture = (sql: string) => { const db = new Database(f.backup); try { db.pragma("journal_mode = DELETE"); db.exec(sql); } finally { db.close(); } };
    editFixture("UPDATE crm_schema_migrations SET checksum='test-only-corruption' WHERE version=1");
    await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError); noOwnedCopy(f.root);
    writeFileSync(f.backup, original);
    editFixture("PRAGMA foreign_keys=OFF; INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(999,999)");
    await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError); noOwnedCopy(f.root);
  } finally { f.finish(); }
});

test("hard-linked snapshots are rejected without writing either linked path", async () => {
  const f = await fixture();
  try {
    const other = join(f.root, "duplicate-test.sqlite"); linkSync(f.backup, other);
    const before = readFileSync(f.backup);
    await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError);
    assert.deepEqual(readFileSync(other), before); assert.deepEqual(readFileSync(f.backup), before); noOwnedCopy(f.root);
  } finally { f.finish(); }
});

test("unchanged migration ledger cannot hide a missing table, immutable audit trigger or index", async () => {
  const f = await fixture();
  try {
    const original = readFileSync(f.backup);
    for (const sql of ["DROP TABLE crm_login_attempts", "DROP TRIGGER crm_commercial_audit_no_update", "DROP INDEX idx_products_name", "DELETE FROM crm_schema_migrations WHERE version=9"]) {
      const db = new Database(f.backup);
      try { db.pragma("journal_mode = DELETE"); db.exec(sql); } finally { db.close(); }
      const altered = readFileSync(f.backup);
      await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError);
      assert.deepEqual(readFileSync(f.backup), altered); noOwnedCopy(f.root);
      writeFileSync(f.backup, original);
    }
  } finally { f.finish(); }
});

test("backup directory junction is rejected without following it or creating a rehearsal", async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, ".local-data", "backups", "test-00000000-0000-4000-8000-000000000000");
    const target = join(f.root, "owned-link-target"); mkdirSync(target);
    writeFileSync(join(target, "sentinel.txt"), "Synthetic unchanged sentinel");
    symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(rehearseBackup(f.root, relative(f.root, join(directory, "crm.sqlite"))), RestoreRehearsalError);
    assert.deepEqual(readdirSync(target), ["sentinel.txt"]); noOwnedCopy(f.root);
  } finally { f.finish(); }
});

test("restore schema comparison rejects extra SQLite-like user tables, indexes and triggers without changing the backup", async () => {
  const f = await fixture();
  try {
    const original = readFileSync(f.backup);
    for (const sql of [
      "CREATE TABLE sqliteXhistory(value TEXT); INSERT INTO sqliteXhistory VALUES('preserved synthetic record')",
      "CREATE INDEX sqliteXindex ON users(username)",
      "CREATE TRIGGER sqliteXtrigger BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT,'Synthetic trigger'); END",
    ]) {
      const db = new Database(f.backup);
      try { db.pragma("journal_mode = DELETE"); db.exec(sql); } finally { db.close(); }
      const altered = readFileSync(f.backup);
      await assert.rejects(rehearseBackup(f.root, f.relativeBackup), RestoreRehearsalError);
      assert.deepEqual(readFileSync(f.backup), altered); noOwnedCopy(f.root);
      writeFileSync(f.backup, original);
    }
  } finally { f.finish(); }
});
