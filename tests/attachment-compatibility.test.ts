import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { configureDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase, migrations } from "./sqlite-reference/db/migrations";

test("M10 retains populated log file rowids, exact bytes, audits and M1–9 checksums with active foreign keys", () => {
  const db = new Database(":memory:"); configureDatabase(db);
  try {
    db.exec("CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT");
    for (const migration of migrations.filter(value => value.version <= 9)) { db.exec(migration.sql); db.prepare("INSERT INTO crm_schema_migrations(version,name,checksum) VALUES(?,?,?)").run(migration.version, migration.name, createHash("sha256").update(migration.sql).digest("hex")); }
    db.exec("INSERT INTO users(id,username,email,password) VALUES(1,'Synthetic','test@example.invalid','not-a-login-hash'); INSERT INTO tasks(id,deal_name,status) VALUES(1,'Synthetic','Closed Won'); INSERT INTO departments_assign(id,task_id,department,user_id,status) VALUES(1,1,'Electrical',1,'Assigned'); INSERT INTO crm_department_work_logs(id,task_id,department,assignment_id,actor_user_id,status,notes) VALUES(1,1,'Electrical',1,1,'DOCUMENTS PENDING','Retained');");
    const bytes = Buffer.from("Retained synthetic immutable bytes");
    db.prepare("INSERT INTO crm_department_log_attachments(rowid,id,log_id,uploaded_by,file_name,media_type,file_size,content_sha256,content) VALUES(97,'retained',1,1,'retained.txt','text/plain',?,?,?)").run(bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes);
    db.exec("INSERT INTO crm_department_log_attachment_audit_events(id,actor_user_id,log_id,attachment_id,action) VALUES(51,1,1,'retained','log_attachments.create')");
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    const snapshot = new Map(tables.map(({ name }) => [name, db.prepare(`SELECT rowid AS _rowid_,* FROM ${name} ORDER BY rowid`).all()]));
    assert.equal(migrateDatabase(db), 1);
    for (const [name, rows] of snapshot) assert.deepEqual(db.prepare(`SELECT rowid AS _rowid_,* FROM ${name}${name === "crm_schema_migrations" ? " WHERE version<=9" : ""} ORDER BY rowid`).all(), rows, name);
    assert.equal(migrateDatabase(db), 0); assert.equal(db.pragma("foreign_keys", { simple: true }), 1); assert.deepEqual(db.pragma("foreign_key_check"), []); assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.throws(() => db.exec("UPDATE crm_department_log_attachments SET file_name='changed'"), /immutable/); assert.throws(() => db.exec("DELETE FROM crm_department_log_attachments"), /immutable/);
    assert.throws(() => db.exec("DELETE FROM crm_department_log_attachment_audit_events"), /immutable/);
    assert.throws(() => db.exec("INSERT INTO crm_department_log_attachments(id,log_id,uploaded_by,file_name,media_type,file_size,content_sha256,content) VALUES('bad',1,999,'bad.txt','text/plain',1,'x',X'01')"), /author/);
  } finally { db.close(); }
});
