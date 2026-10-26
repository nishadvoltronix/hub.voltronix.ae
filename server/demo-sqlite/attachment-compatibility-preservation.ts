import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrations, migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface CompatibilitySchema { type: string; name: string; tbl_name: string; sql: string | null }
export interface CompatibilitySnapshot {
  schema: CompatibilitySchema[];
  tables: Record<string, { count: number; rows: Record<string, string> }>;
  ledger: { version: number; name: string; checksum: string; applied_at: string }[];
  integrity: unknown;
  foreignKeys: unknown[];
}

/** Complete rowid-sensitive fingerprints, including sessions, BLOBs and SQLite sequences. */
export function compatibilitySnapshot(db: SqliteDatabase): CompatibilitySnapshot {
  return db.transaction(() => {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all() as CompatibilitySchema[];
    const tables: CompatibilitySnapshot["tables"] = {};
    for (const { name } of schema.filter(row => row.type === "table")) {
      assert.match(name, /^[a-z_]+$/i);
      const rows = db.prepare(`SELECT rowid AS __rowid,* FROM "${name}" ORDER BY rowid`).all() as Record<string, unknown>[];
      tables[name] = { count: rows.length, rows: Object.fromEntries(rows.map(row => [String(row.__rowid), hash(row)])) };
    }
    return { schema, tables, ledger: db.prepare("SELECT * FROM crm_schema_migrations ORDER BY version").all() as CompatibilitySnapshot["ledger"],
      integrity: db.pragma("integrity_check", { simple: true }), foreignKeys: db.pragma("foreign_key_check") as unknown[] };
  })();
}

/** Derive only the reviewed table's schema from a disposable complete migration. */
export function compatibilityExpectedSchema(): CompatibilitySchema[] {
  const Database = createRequire(new URL("../../package.json", import.meta.url))("better-sqlite3") as new (file: string) => SqliteDatabase;
  const db = new Database(":memory:");
  try {
    configureDatabase(db); migrateDatabase(db);
    return compatibilitySnapshot(db).schema.filter(row => row.tbl_name === "crm_department_log_attachments");
  } finally { db.close(); }
}

export function assertCompatibilityPreserved(before: CompatibilitySnapshot, after: CompatibilitySnapshot,
  expectedSchema: CompatibilitySchema[] = compatibilityExpectedSchema()) {
  assert.equal(before.integrity, "ok"); assert.equal(after.integrity, "ok");
  assert.deepEqual(before.foreignKeys, []); assert.deepEqual(after.foreignKeys, []);
  assert.deepEqual(Object.keys(after.tables).sort(), Object.keys(before.tables).sort());
  for (const name of Object.keys(before.tables)) {
    if (name !== "crm_schema_migrations") assert.deepEqual(after.tables[name], before.tables[name], `Preservation failed for ${name}`);
  }
  assert.equal(before.ledger.length, 9); assert.equal(after.ledger.length, 10);
  assert.deepEqual(after.ledger.slice(0, 9), before.ledger);
  const migration = migrations.find(row => row.version === 10);
  assert.ok(migration, "Only the reviewed compatibility migration is permitted");
  const added = after.ledger[9]!;
  assert.equal(added.version, 10); assert.equal(added.name, migration.name);
  assert.equal(added.checksum, createHash("sha256").update(migration.sql).digest("hex"));
  assert.ok(Number.isFinite(Date.parse(added.applied_at)));
  assert.equal(after.tables.crm_schema_migrations!.count, before.tables.crm_schema_migrations!.count + 1);
  for (const [id, value] of Object.entries(before.tables.crm_schema_migrations!.rows)) assert.equal(after.tables.crm_schema_migrations!.rows[id], value);
  assert.deepEqual(after.schema.filter(row => row.tbl_name !== "crm_department_log_attachments"),
    before.schema.filter(row => row.tbl_name !== "crm_department_log_attachments"));
  assert.ok(expectedSchema.length >= 5);
  const oldObjects = before.schema.filter(row => row.tbl_name === "crm_department_log_attachments");
  const newObjects = after.schema.filter(row => row.tbl_name === "crm_department_log_attachments");
  assert.deepEqual(newObjects, expectedSchema);
  for (const original of oldObjects.filter(row => row.type !== "table")) {
    assert.deepEqual(newObjects.find(row => row.name === original.name), original, "Original attachment indexes/triggers must remain exact");
  }
  assert.deepEqual(newObjects.filter(row => !oldObjects.some(old => old.name === row.name)).map(row => row.name), ["crm_log_attachment_department_limit"]);
  const normalizeTable = (sql: string) => sql.replace('CREATE TABLE "crm_department_log_attachments"', "CREATE TABLE crm_department_log_attachments");
  assert.equal(normalizeTable(newObjects.find(row => row.type === "table")!.sql!),
    normalizeTable(oldObjects.find(row => row.type === "table")!.sql!).replace("file_size<=16384000", "file_size<=52428800"));
}

export function applyCompatibilityPreservingRows(db: SqliteDatabase, verifiedBackup: CompatibilitySnapshot) {
  assert.equal(db.readonly, false); assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  const expected = compatibilityExpectedSchema();
  return db.transaction(() => {
    const before = compatibilitySnapshot(db);
    assert.deepEqual(before, verifiedBackup, "Current state differs from the verified backup");
    assert.equal(before.ledger.length, 9, "Only the pending local M10 upgrade is permitted");
    assert.equal(migrateDatabase(db), 1);
    const after = compatibilitySnapshot(db);
    assertCompatibilityPreserved(before, after, expected);
    return { before, after };
  }).immediate();
}
