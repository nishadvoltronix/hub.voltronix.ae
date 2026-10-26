import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrations } from "../../tests/sqlite-reference/db/migrations.js";
import { applyCompatibilityPreservingRows, assertCompatibilityPreserved, compatibilitySnapshot } from "./attachment-compatibility-preservation.js";
import { parseCompatibilityApplyArguments } from "./apply-attachment-compatibility.js";

function fixture(t: TestContext) {
  const Database = createRequire(new URL("../../package.json", import.meta.url))("better-sqlite3") as new (name: string) => SqliteDatabase;
  const db = new Database(":memory:"); t.after(() => db.close()); configureDatabase(db);
  db.exec("CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT");
  db.transaction(() => {
    for (const migration of migrations.slice(0, 9)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO crm_schema_migrations(version,name,checksum) VALUES(?,?,?)")
        .run(migration.version, migration.name, createHash("sha256").update(migration.sql).digest("hex"));
    }
  }).immediate();
  db.exec("INSERT INTO users(id,user_id,username,email,password) VALUES(1,'synthetic-external','Fixture','fixture@example.invalid','synthetic-password-fingerprint')");
  db.exec("INSERT INTO crm_sessions VALUES('synthetic-session',1,'synthetic-csrf','synthetic-fingerprint',1000,2000)");
  db.exec("INSERT INTO tasks(id,deal_name,status) VALUES(1,'Synthetic compatibility job','Closed Won')");
  db.exec("INSERT INTO departments_assign(id,task_id,user_id,department) VALUES(1,1,1,'Electrical')");
  db.exec("INSERT INTO crm_department_work_logs(id,task_id,department,assignment_id,actor_user_id,status,notes) VALUES(1,1,'Electrical',1,1,'DOCUMENTS PENDING','Synthetic note')");
  db.prepare("INSERT INTO crm_department_log_attachments(rowid,id,log_id,uploaded_by,file_name,media_type,file_size,content_sha256,content) VALUES(7,'synthetic-file',1,1,'fixture.txt','text/plain',4,?,?)")
    .run(createHash("sha256").update("test").digest("hex"), Buffer.from("test"));
  db.exec("INSERT INTO crm_department_log_attachment_audit_events(id,actor_user_id,log_id,attachment_id,action) VALUES(9,1,1,'synthetic-file','log_attachments.create')");
  return db;
}

test("compatibility installer requires exact local scope, immutable backup name and non-debug environment", () => {
  const name = "crm-demo-11111111-1111-4111-8111-111111111111.sqlite";
  const args = ["--apply-local-attachment-compatibility", name];
  assert.equal(parseCompatibilityApplyArguments(args, {}, []), name);
  for (const bad of [[], [name], [...args, "extra"], [args[0]!, "../outside.sqlite"]]) assert.throws(() => parseCompatibilityApplyArguments(bad, {}, []));
  for (const env of [{ DEBUG: "1" }, { CRM_RUNTIME_PROFILE: "production" }, { CRM_RUNTIME_ENABLE: "approved" }]) assert.throws(() => parseCompatibilityApplyArguments(args, env, []));
  assert.throws(() => parseCompatibilityApplyArguments(args, {}, ["--inspect=9229"]));
});

test("guarded populated upgrade preserves sparse file rowid, bytes, immutable audit, expired session and original ledger", t => {
  const db = fixture(t), before = compatibilitySnapshot(db);
  const result = applyCompatibilityPreservingRows(db, before);
  assertCompatibilityPreserved(before, result.after);
  assert.equal((db.prepare("SELECT rowid FROM crm_department_log_attachments").get() as { rowid: number }).rowid, 7);
  assert.throws(() => db.exec("DELETE FROM crm_department_log_attachments"), /immutable/);
  assert.throws(() => db.exec("UPDATE crm_department_log_attachment_audit_events SET id=10"), /immutable/);
  assert.throws(() => applyCompatibilityPreservingRows(db, result.after), /pending local M10/);
  assert.deepEqual(compatibilitySnapshot(db), result.after);
});

test("guarded upgrade refuses a mismatched backup before changing any row or schema", t => {
  const db = fixture(t), before = compatibilitySnapshot(db), wrong = structuredClone(before);
  wrong.tables.users!.rows["1"] = "different account fingerprint";
  assert.throws(() => applyCompatibilityPreservingRows(db, wrong), /differs from the verified backup/);
  assert.deepEqual(compatibilitySnapshot(db), before);
});

test("post-migration preservation failure rolls back schema, ledger and accidental data mutation together", t => {
  const db = fixture(t);
  db.exec("CREATE TRIGGER synthetic_fault AFTER INSERT ON crm_schema_migrations WHEN NEW.version=10 BEGIN UPDATE users SET username='Unexpected change'; END");
  const before = compatibilitySnapshot(db);
  assert.throws(() => applyCompatibilityPreservingRows(db, before), /Preservation failed for users/);
  assert.deepEqual(compatibilitySnapshot(db), before);
});

test("read-only successor proof rejects equal-count session replacement, changed prior ledger and unrelated schema changes", t => {
  const db = fixture(t), before = compatibilitySnapshot(db), { after } = applyCompatibilityPreservingRows(db, before);
  for (const alter of [
    (value: typeof after) => { value.tables.crm_sessions!.rows["1"] = "another token with same row count"; },
    (value: typeof after) => { value.ledger[0]!.checksum = "revised historical migration"; },
    (value: typeof after) => { value.schema.find(row => row.name === "users")!.sql += " altered"; },
    (value: typeof after) => { value.schema.find(row => row.name === "crm_log_attachment_no_update")!.sql = "SELECT 1"; },
  ]) { const modified = structuredClone(after); alter(modified); assert.throws(() => assertCompatibilityPreserved(before, modified)); }
});
