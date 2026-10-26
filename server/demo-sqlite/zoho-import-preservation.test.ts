import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { captureImportPreservation } from "./zoho-import-preservation.js";
import { applyZohoImportExtension } from "./zoho-import-store.js";

const requireFrontend = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireFrontend("better-sqlite3") as new (filename: string) => SqliteDatabase;
function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  db.exec(`INSERT INTO users(id,user_id,username,email,password,status) VALUES(1,'101','Synthetic owner','owner@example.invalid','PRIVATE_PASSWORD_HASH','active');
    INSERT INTO permissions(id,key,label) VALUES(1,'leads.view','Synthetic permission');
    INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,1);
    INSERT INTO crm_sessions(token_hash,user_id,csrf_hash,password_fingerprint,created_at,expires_at)
      VALUES('PRIVATE_SESSION_HASH',1,'PRIVATE_CSRF_HASH','PRIVATE_PASSWORD_FINGERPRINT',1,9999999999999);
    INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status,service_charge) VALUES(1,'201','101','Existing task','Pending','12.500');
    INSERT INTO job_notes(id,deal_id,note_title,note_content,zoho_note_id) VALUES(1,'201','Existing note','Existing content','301');
    INSERT INTO products(product_id,product_name,description,unit_price,created_at,updated_at) VALUES('401','Existing product','Existing description','0.000000000000000001','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');`);
  return db;
}
function addTargets(db: SqliteDatabase) {
  db.exec(`INSERT INTO tasks(zoho_crm_id,deal_name,status) VALUES('202','New imported task','Pending');
    INSERT INTO products(product_id,product_name,created_at,updated_at) VALUES('402','New imported product','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');
    INSERT INTO job_notes(deal_id,note_title,note_content,zoho_note_id) VALUES('202','New imported note','New content','302');`);
}
function refused(verify: () => void) {
  assert.throws(verify, error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(String(error), /PRIVATE_|owner@example\.invalid|Existing (?:content|description)/); return true;
  });
}

test("import preservation accepts exact unchanged data and only additional target business rows", t => {
  const db = fixture(t), verify = captureImportPreservation(db);
  verify(); addTargets(db); verify(); verify();
  assert.equal((db.prepare("SELECT COUNT(*) count FROM tasks").get() as { count: number }).count, 2);
});

test("import preservation checks user identity/password/status and exact existing grants", t => {
  for (const mutation of ["UPDATE users SET password='changed' WHERE id=1", "UPDATE users SET email='changed@example.invalid' WHERE id=1",
    "UPDATE users SET username='Changed identity' WHERE id=1", "UPDATE users SET status='inactive' WHERE id=1", "DELETE FROM admin_user_permissions WHERE admin_user_id=1"]) {
    const db = fixture(t), verify = captureImportPreservation(db); db.exec(mutation); refused(verify);
  }
});

test("import preservation refuses session rotation, CSRF mutation, deletion or new session rows", t => {
  for (const mutation of ["UPDATE crm_sessions SET csrf_hash='changed'", "UPDATE crm_sessions SET token_hash='changed'", "DELETE FROM crm_sessions",
    "INSERT INTO crm_sessions(token_hash,user_id,csrf_hash,password_fingerprint,created_at,expires_at) VALUES('new',1,'new','new',1,2)"]) {
    const db = fixture(t), verify = captureImportPreservation(db); db.exec(mutation); refused(verify);
  }
});

test("import preservation refuses edits or deletion of pre-existing target rows while allowing new rows", t => {
  for (const mutation of ["UPDATE products SET unit_price='12'", "UPDATE tasks SET deal_name='Changed'", "UPDATE job_notes SET note_content='Changed'",
    "DELETE FROM products", "DELETE FROM job_notes"]) {
    const db = fixture(t), verify = captureImportPreservation(db); addTargets(db); db.exec(mutation); refused(verify);
  }
});

test("import preservation refuses new unrelated users/grants/history and existing schema alterations", t => {
  for (const mutation of ["INSERT INTO users(username,email,password) VALUES('Unexpected','new@example.invalid','new')",
    "INSERT INTO permissions(key,label) VALUES('unexpected','unexpected')", "INSERT INTO tasks_status_log(Task_ID,Status) VALUES(1,'Changed')",
    "ALTER TABLE products ADD COLUMN unexpected TEXT"]) {
    const db = fixture(t), verify = captureImportPreservation(db); db.exec(mutation); refused(verify);
  }
});

test("import preservation rejects unreviewed new tables, indexes and triggers even when all old rows/schema still match", t => {
  for (const mutation of ["CREATE TABLE unexpected_data(id INTEGER PRIMARY KEY,value TEXT)", "CREATE INDEX unexpected_index ON users(username)",
    "CREATE TRIGGER unexpected_trigger BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT,'unexpected'); END",
    "CREATE TABLE crm_demo_zoho_import_lookalike(id INTEGER PRIMARY KEY)"]) {
    const db = fixture(t), verify = captureImportPreservation(db); db.exec(mutation); refused(verify);
  }
});

test("import preservation accepts only the full exact reviewed extension and retains its old provenance on later runs", t => {
  const db = fixture(t), verify = captureImportPreservation(db);
  applyZohoImportExtension(db, { organizationId: "123" }); verify();
  const after = captureImportPreservation(db); addTargets(db); after();
  db.exec("DROP TRIGGER crm_demo_zoho_import_tasks_no_update"); refused(after);
});

test("import preservation detects unrelated AUTOINCREMENT changes even if temporary rows were removed", t => {
  const db = fixture(t), verify = captureImportPreservation(db);
  db.exec("INSERT INTO users(username,email,password) VALUES('Temporary','temporary@example.invalid','temporary'); DELETE FROM users WHERE email='temporary@example.invalid'");
  refused(verify);
});

test("import preservation refuses sequence deletion/backwards movement and unreviewed new sequence entries", t => {
  for (const mutation of ["UPDATE sqlite_sequence SET seq=0 WHERE name='tasks'", "DELETE FROM sqlite_sequence WHERE name='job_notes'",
    "INSERT INTO sqlite_sequence(name,seq) VALUES('unexpected',100)"]) {
    const db = fixture(t), verify = captureImportPreservation(db); db.exec(mutation); refused(verify);
  }
});

test("import preservation handles lossless integer values, BLOB bytes and duplicate-row counts", t => {
  const db = fixture(t);
  db.exec("CREATE TABLE synthetic_binary(n INTEGER,content BLOB); INSERT INTO synthetic_binary VALUES(9007199254740993,x'000102ff'); INSERT INTO synthetic_binary VALUES(9007199254740993,x'000102ff')");
  const verify = captureImportPreservation(db); verify();
  db.exec("DELETE FROM synthetic_binary WHERE rowid=(SELECT MIN(rowid) FROM synthetic_binary)"); refused(verify);
});

test("import preservation refuses new foreign-key violations among otherwise allowed target additions", t => {
  const db = fixture(t), verify = captureImportPreservation(db);
  db.pragma("foreign_keys=OFF");
  db.exec("INSERT INTO job_notes(deal_id,note_title,note_content) VALUES('missing-parent','Orphan','Orphan')");
  refused(verify);
});

test("import preservation assertions inside a transaction roll back unsafe changes and all candidate inserts", t => {
  const db = fixture(t), verify = captureImportPreservation(db);
  assert.throws(() => db.transaction(() => {
    addTargets(db); db.exec("UPDATE users SET password='changed' WHERE id=1"); verify();
  }).immediate());
  verify(); assert.equal((db.prepare("SELECT COUNT(*) count FROM tasks").get() as { count: number }).count, 1);
});
