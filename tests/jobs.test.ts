import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService, SESSION_LIFETIME_MS } from "./sqlite-reference/auth/service";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase, migrations } from "./sqlite-reference/db/migrations";
import { createJobsService, JobsError } from "./sqlite-reference/jobs/service";
import { filesystemFixture } from "./database-fixture";

const password = "Synthetic job test password";
const passwordHash = hashSync(password, 4);
const NOW = Date.parse("2026-10-10T12:34:56.000Z");
function user(db: Database.Database, id: number | bigint, externalId: string | null = `external-${id}`) {
  db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(?,?,?,?,?,'active')")
    .run(id, externalId, `Synthetic employee ${id}`, `fixture-${id}@example.invalid`, passwordHash);
}
function grant(db: Database.Database, id: number | bigint, key: string) {
  db.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
  db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
}
function task(db: Database.Database, id: number | bigint, salesStatus = "Close to Won", jobStatus: string | null = null, name = `Synthetic job ${id}`) {
  db.prepare("INSERT INTO tasks(id,deal_name,status,Job_Status,account_name,job_deal_number,service_charge,assigned_to) VALUES(?,?,?,?,?,?,?,'external-2')")
    .run(id, name, salesStatus, jobStatus, "Synthetic account", `JOB-${id}`, "123.45");
}
async function populate(db: Database.Database) {
  for (let id = 1; id <= 3; id++) user(db, id);
  user(db, 4, null);
  grant(db, 1, "dashboard.view"); grant(db, 4, "dashboard.view");
  for (const permission of ["leads.view", "leads.manage", "electrical.manage", "permissions.manage"]) grant(db, 2, permission);
  db.prepare("UPDATE users SET role='admin',quote_access=1 WHERE id=2").run();
  task(db, 1); task(db, 2, "Closed Won", "Hold"); task(db, 3, "Qualification");
  const auth = createAuthService(db, { now: () => NOW });
  const signIn = async (id: number | bigint) => (await auth.login(`fixture-${id}@example.invalid`, password, "fixture")).sessionToken;
  return { db, auth, signIn, service: createJobsService(db, { now: () => NOW }),
    manager: await signIn(1), denied: await signIn(2), localManager: await signIn(4) };
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db);
  t.after(() => db.close()); return populate(db);
}
function status(code: number) { return (error: unknown) => error instanceof JobsError && error.status === code; }
function audits(db: Database.Database) { return db.prepare("SELECT * FROM crm_job_audit_events ORDER BY id").all() as Array<{ actor_user_id: number; task_id: number; action: string; changed_fields: string; occurred_at: string }>; }

test("migration 4 preserves existing tasks, sessions and audit history without seeding application records", () => {
  const db = new Database(":memory:"); configureDatabase(db);
  try {
    db.exec("CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT");
    for (const migration of migrations.filter((item) => item.version <= 3)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO crm_schema_migrations(version,name,checksum) VALUES(?,?,?)")
        .run(migration.version, migration.name, createHash("sha256").update(migration.sql).digest("hex"));
    }
    user(db, 1); user(db, 2); task(db, 1);
    db.prepare("INSERT INTO crm_sessions(token_hash,user_id,csrf_hash,password_fingerprint,created_at,expires_at) VALUES(?,1,?,?,?,?)")
      .run("a".repeat(64), "b".repeat(64), createHash("sha256").update(passwordHash).digest("hex"), NOW, NOW + SESSION_LIFETIME_MS);
    db.prepare("INSERT INTO crm_audit_events(actor_user_id,target_type,target_id,action,changed_fields) VALUES(1,'users','2','users.create','[]')").run();
    const before = db.prepare("SELECT id,deal_name,status,Job_Status,service_charge,created_at,updated_at FROM tasks").get();
    const originalAudit = db.prepare("SELECT * FROM crm_audit_events").all();
    const originalSessions = db.prepare("SELECT * FROM crm_sessions").all();
    assert.equal(migrateDatabase(db), migrations.length - 3);
    assert.deepEqual(db.prepare("SELECT id,deal_name,status,Job_Status,service_charge,created_at,updated_at FROM tasks").get(), before);
    assert.deepEqual(db.prepare("SELECT Admin_Remarks,hold_by,version FROM tasks").get(), { Admin_Remarks: null, hold_by: null, version: 1 });
    assert.deepEqual(db.prepare("SELECT * FROM crm_audit_events").all(), originalAudit);
    assert.deepEqual(db.prepare("SELECT * FROM crm_sessions").all(), originalSessions);
    assert.equal(audits(db).length, 0); assert.equal(migrateDatabase(db), 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 2);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("all job operations enforce fresh dashboard.view before validation and reject inferred role/lead/department privileges", async (t) => {
  const f = await fixture(t);
  const calls = (token: string | null) => [
    () => f.service.listJobs(token, { ignored: true }), () => f.service.getJob(token, "bad"),
    () => f.service.updateStatus(token, "bad", {}), () => f.service.updateRemarks(token, "bad", {}),
  ];
  for (const [token, code] of [[null, 401], [f.denied, 403]] as const) {
    for (const call of calls(token)) assert.throws(call, status(code));
  }
  assert.equal(f.service.listJobs(f.manager).total, 2);
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  for (const call of calls(f.manager)) assert.throws(call, status(403));
  assert.equal(audits(f.db).length, 0);
});

test("job access fails closed for missing/invalid/non-won records and preserves unrelated lead data", async (t) => {
  const f = await fixture(t);
  for (const id of ["3", "999", "0", "-1", "1 OR 1=1", "9223372036854775808", 1, null]) {
    assert.throws(() => f.service.getJob(f.manager, id), status(404));
    assert.throws(() => f.service.updateStatus(f.manager, id, { expectedVersion: 1, jobStatus: "Hold" }), status(404));
    assert.throws(() => f.service.updateRemarks(f.manager, id, { expectedVersion: 1, remarks: "not applied" }), status(404));
  }
  assert.equal(audits(f.db).length, 0);
  assert.deepEqual(f.db.prepare("SELECT Job_Status,Admin_Remarks,version FROM tasks WHERE id=3").get(), { Job_Status: null, Admin_Remarks: null, version: 1 });
});

test("confirmed-job search/paging/status filters preserve aliases, literal wildcard text, null/empty Active and lossless IDs", async (t) => {
  const f = await fixture(t);
  task(f.db, 4, "Closed Won", ""); task(f.db, 5, "Close to Won", "Active");
  task(f.db, 6, "Close to Won", "Closed"); task(f.db, 9_007_199_254_740_993n, "Closed Won", "Hold", "Synthetic 100%_ job");
  assert.equal(f.service.listJobs(f.manager).total, 6);
  assert.equal(f.service.listJobs(f.manager, { jobStatus: "Active" }).total, 3);
  assert.equal(f.service.listJobs(f.manager, { jobStatus: "Hold" }).total, 2);
  assert.equal(f.service.listJobs(f.manager, { jobStatus: "Closed" }).total, 1);
  const result = f.service.listJobs(f.manager, { query: "%_", pageSize: 1 });
  assert.equal(result.total, 1); assert.equal(result.items[0]!.id, "9007199254740993");
  assert.equal(f.service.getJob(f.manager, "9007199254740993").id, "9007199254740993");
  assert.equal(f.service.listJobs(f.manager, { query: "' OR 1=1 --" }).total, 0);
  assert.equal(f.service.listJobs(f.manager, { page: 2, pageSize: 5 }).items.length, 1);
  assert.equal(f.service.listJobs(f.manager, { page: 3, pageSize: 5 }).items.length, 0);
  for (const input of [{ page: 0 }, { pageSize: 101 }, { jobStatus: "Completed" }, { query: "\0" }, { actorId: "1" }]) {
    assert.throws(() => f.service.listJobs(f.manager, input), status(400));
  }
});

test("Active/Hold/Closed updates persist actor external identity, version and audit atomically without changing sales stage", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE users SET user_id='9007199254740993123' WHERE id=1").run();
  let version = 1;
  for (const jobStatus of ["Active", "Hold", "Closed", "Active"] as const) {
    const row = f.service.updateStatus(f.manager, "1", { expectedVersion: version, jobStatus });
    assert.equal(row.jobStatus, jobStatus); assert.equal(row.version, ++version);
    assert.equal(row.holdByExternalId, "9007199254740993123"); assert.equal(row.salesStatus, "Close to Won");
    assert.equal(row.updatedAt, "2026-10-10T12:34:56.000Z");
  }
  assert.equal(audits(f.db).length, 4);
  for (const row of audits(f.db)) {
    assert.equal(row.actor_user_id, 1); assert.equal(row.task_id, 1); assert.equal(row.action, "jobs.status");
    assert.deepEqual(JSON.parse(row.changed_fields), ["Job_Status", "hold_by"]);
  }
  assert.equal((f.db.prepare("SELECT service_charge FROM tasks WHERE id=1").get() as { service_charge: string }).service_charge, "123.45");
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM tasks_status_log").get() as { n: number }).n, 0); // sales stage history is separate.
});

test("accounts without an external identity retain a local audit actor and never fabricate a hold_by identity", async (t) => {
  const f = await fixture(t);
  const result = f.service.updateStatus(f.localManager, "2", { expectedVersion: 1, jobStatus: "Closed" });
  assert.equal(result.holdByExternalId, null); assert.equal(audits(f.db)[0]!.actor_user_id, 4);
});

test("administrator remarks support trimmed create/edit/clear and literal untrusted text without leaking values into audits", async (t) => {
  const f = await fixture(t);
  const literal = "<script>not executable</script> '; DROP TABLE users; --";
  let result = f.service.updateRemarks(f.manager, "1", { expectedVersion: 1, remarks: `  ${literal}\n` });
  assert.equal(result.remarks, literal); assert.equal(result.version, 2);
  result = f.service.updateRemarks(f.manager, "1", { expectedVersion: 2, remarks: " Revised\nremarks " });
  assert.equal(result.remarks, "Revised\nremarks");
  result = f.service.updateRemarks(f.manager, "1", { expectedVersion: 3, remarks: " \n " });
  assert.equal(result.remarks, ""); assert.equal(result.version, 4);
  assert.equal(result.holdByExternalId, null); assert.equal(result.jobStatus, null);
  assert.equal(audits(f.db).length, 3);
  assert.equal(JSON.stringify(audits(f.db)).includes(literal), false);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 4);
  for (const row of audits(f.db)) assert.deepEqual(JSON.parse(row.changed_fields), ["Admin_Remarks"]);
});

test("job mutation input is strict, bounded and versioned; invalid requests do not persist or append audit events", async (t) => {
  const f = await fixture(t);
  const badStatus = [{ expectedVersion: 1, jobStatus: "Completed" }, { expectedVersion: 1, jobStatus: "" },
    { expectedVersion: 0, jobStatus: "Hold" }, { expectedVersion: "1", jobStatus: "Hold" },
    { expectedVersion: 1, jobStatus: "Hold", hold_by: "other" }, { expectedVersion: 1, jobStatus: null }];
  for (const input of badStatus) assert.throws(() => f.service.updateStatus(f.manager, "1", input), status(400));
  const badRemarks = [{ expectedVersion: 1, remarks: null }, { expectedVersion: 1, remarks: "a".repeat(4_001) },
    { expectedVersion: 1, remarks: "界".repeat(2_334) }, { expectedVersion: 1, remarks: "bad\0text" },
    { expectedVersion: 1, remarks: "text", actorId: "3" }, { remarks: "text" }];
  for (const input of badRemarks) assert.throws(() => f.service.updateRemarks(f.manager, "1", input), status(400));
  assert.deepEqual(f.db.prepare("SELECT Job_Status,Admin_Remarks,version FROM tasks WHERE id=1").get(), { Job_Status: null, Admin_Remarks: null, version: 1 });
  assert.equal(audits(f.db).length, 0);
  const accepted = f.service.updateRemarks(f.manager, "1", { expectedVersion: 1, remarks: "界".repeat(2_333) });
  assert.equal(Buffer.byteLength(accepted.remarks!, "utf8"), 6_999);
});

test("status and remarks share optimistic version checks; stale and exhausted versions preserve both record and audit", async (t) => {
  const f = await fixture(t);
  const first = f.service.getJob(f.manager, "1");
  f.service.updateStatus(f.manager, "1", { expectedVersion: first.version, jobStatus: "Hold" });
  assert.throws(() => f.service.updateRemarks(f.manager, "1", { expectedVersion: first.version, remarks: "stale" }), status(409));
  assert.throws(() => f.service.updateStatus(f.manager, "1", { expectedVersion: first.version, jobStatus: "Closed" }), status(409));
  f.db.prepare("UPDATE tasks SET version=? WHERE id=1").run(Number.MAX_SAFE_INTEGER);
  assert.throws(() => f.service.updateStatus(f.manager, "1", { expectedVersion: Number.MAX_SAFE_INTEGER, jobStatus: "Closed" }), status(409));
  assert.throws(() => f.service.updateRemarks(f.manager, "1", { expectedVersion: Number.MAX_SAFE_INTEGER, remarks: "unsafe increment" }), status(409));
  assert.equal(audits(f.db).length, 1); assert.equal(f.service.getJob(f.manager, "1").jobStatus, "Hold");
});

test("audit insertion failure rolls back status, remarks, version and metadata; audit rows reject update/delete", async (t) => {
  const f = await fixture(t);
  f.db.exec("CREATE TRIGGER synthetic_reject_job_audit BEFORE INSERT ON crm_job_audit_events BEGIN SELECT RAISE(ABORT,'private fixture failure'); END");
  const before = f.service.getJob(f.manager, "1");
  for (const call of [() => f.service.updateStatus(f.manager, "1", { expectedVersion: 1, jobStatus: "Hold" }),
    () => f.service.updateRemarks(f.manager, "1", { expectedVersion: 1, remarks: "private fixture text" })]) {
    assert.throws(call, (error) => status(503)(error) && !(error as Error).message.includes("private"));
  }
  assert.deepEqual(f.service.getJob(f.manager, "1"), before); assert.equal(audits(f.db).length, 0);
  f.db.exec("DROP TRIGGER synthetic_reject_job_audit");
  f.service.updateStatus(f.manager, "1", { expectedVersion: 1, jobStatus: "Hold" });
  assert.throws(() => f.db.exec("UPDATE crm_job_audit_events SET action='jobs.remarks'"), /immutable/);
  assert.throws(() => f.db.exec("DELETE FROM crm_job_audit_events"), /immutable/);
  assert.equal(audits(f.db).length, 1);
});

test("disabled, expired, logged-out and password-changed sessions cannot read or mutate jobs", async (t) => {
  const f = await fixture(t);
  const expired = createJobsService(f.db, { now: () => NOW + SESSION_LIFETIME_MS });
  assert.throws(() => expired.updateStatus(f.manager, "1", { expectedVersion: 1, jobStatus: "Hold" }), status(401));
  const fresh = await f.signIn(1);
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=1").run();
  assert.throws(() => f.service.updateRemarks(fresh, "1", { expectedVersion: 1, remarks: "no" }), status(401));
  f.auth.logout(f.localManager); assert.throws(() => f.service.getJob(f.localManager, "1"), status(401));
  const replacement = await f.signIn(4);
  f.db.prepare("UPDATE users SET password=? WHERE id=4").run(hashSync("Synthetic changed password", 4));
  assert.throws(() => f.service.listJobs(replacement), status(401));
  assert.equal(audits(f.db).length, 0);
});

test("two SQLite connections reject stale updates, handle lock contention safely and retain changes across reopen", async () => {
  const disk = filesystemFixture();
  let first: Database.Database | undefined, second: Database.Database | undefined, reopened: Database.Database | undefined;
  try {
    first = openDatabase(disk.config, { create: true }); migrateDatabase(first);
    const f = await populate(first);
    second = openDatabase(disk.config); second.pragma("busy_timeout=20");
    const other = createJobsService(second, { now: () => NOW });
    const old = other.getJob(f.manager, "1");
    const changed = f.service.updateStatus(f.manager, "1", { expectedVersion: old.version, jobStatus: "Hold" });
    assert.throws(() => other.updateRemarks(f.manager, "1", { expectedVersion: old.version, remarks: "stale" }), status(409));
    first.exec("BEGIN IMMEDIATE");
    try {
      assert.throws(() => other.updateRemarks(f.manager, "1", { expectedVersion: changed.version, remarks: "locked" }), status(503));
    } finally { first.exec("ROLLBACK"); }
    const saved = other.updateRemarks(f.manager, "1", { expectedVersion: changed.version, remarks: "Persisted isolated fixture" });
    assert.equal(saved.version, 3); assert.equal(audits(first).length, 2);
    first.close(); first = undefined; second.close(); second = undefined;
    reopened = openDatabase(disk.config);
    assert.equal(createJobsService(reopened, { now: () => NOW }).getJob(f.manager, "1").remarks, "Persisted isolated fixture");
    assert.deepEqual(reopened.pragma("foreign_key_check"), []);
  } finally { reopened?.close(); second?.close(); first?.close(); disk.cleanup(); }
});
