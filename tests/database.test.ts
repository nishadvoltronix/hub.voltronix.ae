import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { backupDatabase } from "../src/server/db/backup";
import { configureDatabase, openDatabase } from "../src/server/db/connection";
import { assertMigrationsCurrent, migrateDatabase, migrations } from "../src/server/db/migrations";
import { filesystemFixture } from "./database-fixture";

function memoryDatabase() {
  const db = new Database(":memory:");
  configureDatabase(db);
  return db;
}

test("versioned migrations are atomic, idempotent and seed no user or CRM records", () => {
  const db = memoryDatabase();
  try {
    assert.throws(() => assertMigrationsCurrent(db), /migrations are required/);
    assert.equal(migrateDatabase(db), migrations.length);
    assert.equal(migrateDatabase(db), 0);
    assertMigrationsCurrent(db);
    for (const name of ["users", "tasks", "departments_assign", "permissions", "crm_sessions"]) {
      assert.equal((db.prepare('SELECT count(*) AS n FROM "' + name + '"').get() as { n: number }).n, 0);
    }
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  } finally { db.close(); }
});

test("checksum/history tampering fails closed and preserves existing data", () => {
  const db = memoryDatabase();
  try {
    migrateDatabase(db);
    db.prepare("INSERT INTO users(username,email,password) VALUES(?,?,?)").run("test-only", "test@example.invalid", "test-only-hash");
    db.prepare("UPDATE crm_schema_migrations SET checksum = ?").run("tampered");
    assert.throws(() => migrateDatabase(db), /history mismatch/);
    assert.throws(() => assertMigrationsCurrent(db), /history mismatch/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM users").get() as {n: number}).n, 1);
  } finally { db.close(); }
});

test("migration rejects unrecognized existing schemas without changing their records", () => {
  const db = memoryDatabase();
  try {
    db.exec("CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES('preserved')");
    assert.throws(() => migrateDatabase(db), /Unrecognized existing schema/);
    assert.deepEqual(db.prepare("SELECT value FROM legacy").all(), [{ value: "preserved" }]);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'crm_schema_migrations'").get(), undefined);
  } finally { db.close(); }
});

test("SQLite-like user table names cannot bypass unknown-schema refusal or lose existing records", () => {
  for (const name of ["sqliteXhistory", "sqlitehistory", "SQLITExhistory"]) {
    const db = memoryDatabase();
    try {
      db.exec(`CREATE TABLE "${name}"(value TEXT); INSERT INTO "${name}" VALUES('preserved synthetic record')`);
      const before = db.serialize();
      assert.throws(() => migrateDatabase(db), /Unrecognized existing schema/);
      assert.deepEqual(db.serialize(), before);
      assert.deepEqual(db.prepare(`SELECT value FROM "${name}"`).all(), [{ value: "preserved synthetic record" }]);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'crm_schema_migrations'").get(), undefined);
    } finally { db.close(); }
  }
});

test("failed DDL batch rolls back the migration history and schema together", () => {
  const db = memoryDatabase();
  try {
    db.pragma("max_page_count = 2");
    assert.throws(() => migrateDatabase(db), /full/);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all(), []);
  } finally { db.close(); }
});

test("prepared values stay literal, failed transactions rollback, and foreign keys reject orphan assignments", () => {
  const db = memoryDatabase();
  try {
    migrateDatabase(db);
    const insert = db.prepare("INSERT INTO users(username,email,password) VALUES(?,?,?)");
    const value = "'); DROP TABLE users; --";
    insert.run(value, "literal@example.invalid", "test-only-hash");
    assert.equal((db.prepare("SELECT username FROM users").get() as {username: string}).username, value);
    assert.throws(() => db.transaction(() => {
      insert.run("rollback-only", "rollback@example.invalid", "test-only-hash");
      db.prepare("INSERT INTO departments_assign(task_id,user_id,department) VALUES(?,?,?)").run(999, 999, "Civil");
    })(), /FOREIGN KEY/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n, 1);
    assert.throws(() => insert.run("duplicate", "LITERAL@EXAMPLE.INVALID", "test-only-hash"), /UNIQUE/);
  } finally { db.close(); }
});

test("local files use WAL and SQLite backup captures committed WAL rows without replacing prior backups", async () => {
  const fixture = filesystemFixture();
  const writer = openDatabase(fixture.config, { create: true });
  try {
    migrateDatabase(writer);
    assert.equal(writer.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(writer.pragma("busy_timeout", { simple: true }), 5000);
    writer.prepare("INSERT INTO users(username,email,password) VALUES(?,?,?)").run("backup-test-only", "backup@example.invalid", "test-only-hash");
    assert.equal(existsSync(fixture.config.filename + "-wal"), true);
    const reader = openDatabase(fixture.config, { readonly: true });
    try {
      assert.throws(() => reader.prepare("DELETE FROM users").run(), /readonly/);
      const first = await backupDatabase(reader, fixture.config);
      const bytes = readFileSync(first);
      const second = await backupDatabase(reader, fixture.config);
      assert.notEqual(first, second);
      assert.deepEqual(readFileSync(first), bytes);
      assert.equal(existsSync(join(dirname(first), "complete.json")), true);
      const copy = new Database(first, { readonly: true, fileMustExist: true });
      try {
        assert.equal((copy.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n, 1);
        assert.equal(copy.pragma("quick_check", { simple: true }), "ok");
      } finally { copy.close(); }
    } finally { reader.close(); }
  } finally { writer.close(); fixture.cleanup(); }
});
