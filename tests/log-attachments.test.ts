import assert from "node:assert/strict";
import { syntheticGif } from "./gif-fixture";
import { syntheticActionPdf } from "./helpers/pdf-upload-fixture";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService } from "./sqlite-reference/auth/service";
import { DEPARTMENT_PERMISSIONS } from "./sqlite-reference/auth/permissions";
import { createAttachmentsService, AttachmentError, MAX_ATTACHMENT_BYTES } from "./sqlite-reference/attachments/service";
import { createDepartmentsService, DepartmentsError } from "./sqlite-reference/departments/service";
import { DEPARTMENTS, LOG_OPTIONS, type Department } from "./sqlite-reference/departments/contracts";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { backupDatabase } from "./sqlite-reference/db/backup";
import { migrateDatabase, migrations } from "./sqlite-reference/db/migrations";
import { filesystemFixture } from "./database-fixture";
import { LARGE_LOG_ATTACHMENT_LIMIT, TASK_ATTACHMENT_LIMIT } from "@voltronix/crm-contracts";
import { compoundOffice, officeZip } from "./helpers/attachment-format-fixtures";

const NOW = Date.parse("2026-10-10T12:00:00Z"), password = "Synthetic log file fixture password", passwordHash = hashSync(password, 4);
function chunk(type: string, content: Buffer) {
  const header = Buffer.alloc(8), check = Buffer.alloc(4); header.writeUInt32BE(content.length); header.write(type, 4);
  check.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), content]))); return Buffer.concat([header, content, check]);
}
function png() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
const file = () => ({ name: "synthetic-log.png", mediaType: "image/png", content: png() });
function input(department: Department, expectedVersion: number) {
  const choices = LOG_OPTIONS[department];
  return "authority" in choices ? { expectedVersion, authority: choices.authority[1], status: choices.status[1], comments: "Synthetic authority comment", notes: "Synthetic work note" }
    : { expectedVersion, scope: choices.scope[1], status: choices.status[1], notes: "Synthetic work note" };
}
function error(code: number) { return (value: unknown) => (value instanceof DepartmentsError || value instanceof AttachmentError) && value.status === code; }
function counts(db: Database.Database) {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { logs: count("crm_department_work_logs"), files: count("crm_department_log_attachments"), audits: count("crm_department_audit_events"), fileAudits: count("crm_department_log_attachment_audit_events"), taskFiles: count("task_attachment") };
}
async function populate(db: Database.Database) {
  let clock = NOW;
  for (let id = 1; id <= 9; id++) db.prepare("INSERT INTO users(id,user_id,username,email,password,department_role) VALUES(?,?,?,?,?,?)")
    .run(id, `log-owner-${id}`, `Synthetic log employee ${id}`, `log-${id}@example.invalid`, passwordHash, DEPARTMENTS[id - 2] ?? (id === 7 ? "Electrical" : null));
  const grant = (id: number, permission: string) => {
    db.prepare("INSERT INTO permissions(key,label) VALUES(?,?) ON CONFLICT(key) DO NOTHING").run(permission, permission);
    db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE key=?").run(id, permission);
  };
  grant(1, "dashboard.view"); grant(7, "electrical.manage"); grant(9, "leads.view");
  DEPARTMENTS.forEach((department, i) => grant(i + 2, DEPARTMENT_PERMISSIONS[department]));
  for (let id = 1; id <= 2; id++) db.prepare("INSERT INTO tasks(id,deal_name,status,Job_Status,assigned_to) VALUES(?,?,'Close to Won','Active','log-owner-9')")
    .run(id, `Synthetic log job ${id}`);
  const auth = createAuthService(db, { now: () => clock }), service = createDepartmentsService(db, { now: () => clock }), attachments = createAttachmentsService(db, { now: () => clock });
  const login = async (id: number) => (await auth.login(`log-${id}@example.invalid`, password, "fixture")).sessionToken;
  const tokens = await Promise.all(Array.from({ length: 9 }, (_, index) => login(index + 1)));
  service.assign(tokens[0], "1", { expectedVersion: 1, assignments: DEPARTMENTS.map((department, index) => ({ department, userId: String(index + 2) })) });
  service.assign(tokens[0], "2", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "7" }] });
  return { db, service, attachments, tokens, grant, manager: tokens[0]!, worker: tokens[1]!, other: tokens[6]!, denied: tokens[7]!, reader: tokens[8]!, setNow: (value: number) => { clock = value; } };
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close()); return populate(db);
}

test("active PDF log files reject atomically before creating any log, file, audit or version change", async (t) => {
  const f = await fixture(t), before = counts(f.db);
  assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), {
    name: "synthetic.pdf", mediaType: "application/pdf", content: syntheticActionPdf("/S /Named /N /Print", "#41"),
  }), error(415));
  assert.deepEqual(counts(f.db), before);
  assert.equal((f.db.prepare("SELECT version FROM tasks WHERE id=1").get() as { version: number }).version, 2);
  const saved = f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), {
    name: "synthetic.pdf", mediaType: "application/pdf", content: syntheticActionPdf(),
  });
  assert.equal(saved.version, 3);
});

test("migration 9 preserves existing log rows and ordinary attachment bytes/audits without manufacturing log files", async () => {
  const db = new Database(":memory:"); configureDatabase(db);
  try {
    db.exec("CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT");
    for (const migration of migrations.filter((m) => m.version < 9)) {
      db.exec(migration.sql); db.prepare("INSERT INTO crm_schema_migrations(version,name,checksum) VALUES(?,?,?)")
        .run(migration.version, migration.name, createHash("sha256").update(migration.sql).digest("hex"));
    }
    const f = await populate(db);
    // The previous service's text-only persistence shape, before M9 exists.
    db.prepare("INSERT INTO crm_department_work_logs(task_id,department,assignment_id,actor_user_id,status,notes) VALUES(1,'Electrical',1,2,'DOCUMENTS PENDING','Existing synthetic note')").run();
    f.attachments.upload(f.manager, "1", { expectedVersion: 2, name: "existing.txt", mediaType: "text/plain" }, Buffer.from("Existing synthetic task file"));
    const oldLogs = db.prepare("SELECT * FROM crm_department_work_logs").all(), oldFiles = db.prepare("SELECT * FROM task_attachment").all(), oldAudits = db.prepare("SELECT * FROM crm_attachment_audit_events").all();
    assert.equal(migrateDatabase(db), migrations.length - 8);
    assert.deepEqual(db.prepare("SELECT * FROM crm_department_work_logs").all(), oldLogs); assert.deepEqual(db.prepare("SELECT * FROM task_attachment").all(), oldFiles);
    assert.deepEqual(db.prepare("SELECT * FROM crm_attachment_audit_events").all(), oldAudits); assert.equal(counts(db).files, 0);
    assert.equal(f.service.listLogs(f.worker, "Electrical", "1").items[0]!.attachment, null);
    assert.equal(migrateDatabase(db), 0); assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("all five department optional files commit with log, current local actor, version and audit, never with ordinary task attachments", async (t) => {
  const f = await fixture(t); let version = 2;
  for (const [index, department] of DEPARTMENTS.entries()) {
    const token = f.tokens[index + 1]!, result = f.service.addLog(token, department, "1", input(department, version), file());
    assert.equal(result.version, ++version);
    const log = f.service.listLogs(token, department, "1").items[0]!; assert.ok(log.attachment);
    assert.equal(log.actorId, String(index + 2)); assert.equal(log.attachment.name, "synthetic-log.png"); assert.equal(log.attachment.size, png().length);
    assert.deepEqual(f.service.downloadLogAttachment(token, log.attachment.id).content, png());
    assert.deepEqual(f.service.downloadLogAttachment(f.manager, log.attachment.id).content, png());
    assert.equal(f.service.listJobLogs(f.manager, "1", department).items[0]!.attachment!.id, log.attachment.id);
    assert.throws(() => f.attachments.download(f.reader, log.attachment!.id), error(404));
  }
  assert.deepEqual(counts(f.db), { logs: 5, files: 5, audits: 11, fileAudits: 5, taskFiles: 0 });
  assert.equal(f.attachments.list(f.reader, "1").total, 0);
  const event = f.db.prepare("SELECT actor_user_id,log_id,action FROM crm_department_log_attachment_audit_events ORDER BY id LIMIT 1").get();
  assert.deepEqual(event, { actor_user_id: 2, log_id: 1, action: "log_attachments.create" });
});
test("all five departments accept bounded static GIFs with private authorized downloads and atomic invalid-content rejection", async (t) => {
  const f = await fixture(t); let version = 2;
  const value = { name: "synthetic.gif", mediaType: "image/gif", content: syntheticGif() };
  for (const [index, department] of DEPARTMENTS.entries()) {
    const token = f.tokens[index + 1]!, before = counts(f.db);
    assert.throws(() => f.service.addLog(token, department, "1", input(department, version), { ...value, content: Buffer.concat([value.content, Buffer.from("trailing payload")]) }), error(415));
    assert.deepEqual(counts(f.db), before);
    assert.equal(f.service.addLog(token, department, "1", input(department, version), value).version, ++version);
    const id = f.service.listLogs(token, department, "1").items[0]!.attachment!.id;
    assert.deepEqual(f.service.downloadLogAttachment(token, id).content, value.content);
    assert.deepEqual(f.service.downloadLogAttachment(f.manager, id).content, value.content);
    assert.equal(f.service.downloadLogAttachment(f.manager, id).mediaType, "image/gif");
    assert.throws(() => f.service.downloadLogAttachment(f.reader, id), error(404));
    assert.throws(() => f.attachments.download(f.reader, id), error(404));
    assert.throws(() => f.service.addLog(token, department, "1", input(department, version - 1), value), error(409));
  }
  assert.deepEqual(counts(f.db), { logs: 5, files: 5, audits: 11, fileAudits: 5, taskFiles: 0 });
});

test("log-file writes authorize current department assignee before content and reject manager/reader/actor/assignment spoofing", async (t) => {
  const f = await fixture(t), before = counts(f.db), value = input("Electrical", 2);
  for (const [token, code] of [[null, 401], [f.manager, 403], [f.reader, 403], [f.denied, 403], [f.other, 404]] as const) {
    assert.throws(() => f.service.addLog(token, "Electrical", "1", value, { ...file(), content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }), error(code));
  }
  for (const extra of [{ actorId: "1" }, { assignmentId: "9" }, { attachmentId: "existing" }, { file: "ordinary-file" }]) {
    assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", { ...value, ...extra }, file()), error(400));
  }
  assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", value, { ...file(), logId: "10" }), error(400));
  assert.deepEqual(counts(f.db), before);
});

test("approved download scope includes other current department assignees but excludes foreign tasks, former authors, inactive sessions and revoked grants", async (t) => {
  const f = await fixture(t);
  f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), file());
  const id = f.service.listLogs(f.worker, "Electrical", "1").items[0]!.attachment!.id;
  for (const [token, code] of [[null, 401], [f.reader, 404], [f.denied, 404], [f.other, 404]] as const) assert.throws(() => f.service.downloadLogAttachment(token, id), error(code));
  assert.deepEqual(f.service.downloadLogAttachment(f.tokens[2]!, id).content, png());
  for (const bad of ["bad", "../../private", "", null]) assert.throws(() => f.service.downloadLogAttachment(f.manager, bad), error(404));
  f.service.assign(f.manager, "1", { expectedVersion: 3, assignments: [{ department: "Electrical", userId: "7" }] });
  assert.throws(() => f.service.downloadLogAttachment(f.worker, id), error(404));
  assert.deepEqual(f.service.downloadLogAttachment(f.other, id).content, png());
  f.service.unassign(f.manager, "1", { expectedVersion: 4, department: "Electrical" });
  assert.throws(() => f.service.downloadLogAttachment(f.other, id), error(404));
  assert.deepEqual(f.service.downloadLogAttachment(f.manager, id).content, png());
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  assert.throws(() => f.service.downloadLogAttachment(f.manager, id), error(404));
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=2").run();
  assert.throws(() => f.service.downloadLogAttachment(f.worker, id), error(401));
  f.setNow(NOW + 2 * 60 * 60 * 1000 + 1);
  assert.throws(() => f.service.downloadLogAttachment(f.other, id), error(401));
});

test("department files follow source extensions and Excel/CSV are available only to Switchgear and Maintenance", async (t) => {
  const f = await fixture(t); let version = 2;
  const csv = { name: "synthetic.csv", mediaType: "text/csv", content: Buffer.from("Part,Count\nSynthetic,1\n") };
  for (const [index, department] of DEPARTMENTS.entries()) {
    if (["Switchgear", "Maintenance"].includes(department)) {
      assert.equal(f.service.addLog(f.tokens[index + 1], department, "1", input(department, version), csv).version, ++version);
    } else assert.throws(() => f.service.addLog(f.tokens[index + 1], department, "1", input(department, version), csv), error(415));
    for (const [name, content] of [["fixture.xls", compoundOffice("xls", true)], ["fixture.xlsx", officeZip("xlsx")]] as const) {
      const upload = { name, mediaType: "application/octet-stream", content };
      if (["Switchgear", "Maintenance"].includes(department)) assert.equal(f.service.addLog(f.tokens[index + 1], department, "1", input(department, version), upload).version, ++version);
      else assert.throws(() => f.service.addLog(f.tokens[index + 1], department, "1", input(department, version), upload), error(415));
    }
  }
  const before = counts(f.db);
  for (const bad of [
    { name: "synthetic.txt", mediaType: "text/plain", content: Buffer.from("Text") }, { name: "synthetic.gif", mediaType: "image/gif", content: Buffer.from("GIF89a") },
    { name: "synthetic.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: Buffer.from("PK") },
    { ...file(), name: "../synthetic.png" }, { ...file(), mediaType: "application/pdf" }, { ...file(), content: Buffer.from("fake PNG") },
    { ...file(), content: Buffer.alloc(0) }, { ...file(), content: Buffer.alloc(LARGE_LOG_ATTACHMENT_LIMIT + 1) },
  ]) assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", input("Electrical", version), bad), (e) => error(400)(e) || error(413)(e) || error(415)(e));
  assert.throws(() => f.service.addLog(f.tokens[4], "Switchgear", "1", input("Switchgear", version), { ...csv, content: Buffer.from("=HYPERLINK(1),1") }), error(415));
  assert.deepEqual(counts(f.db), before);
});

test("source PM stays at16,000KB and large worker limits reject +1 before persistence", async t => {
  const f = await fixture(t), before = counts(f.db);
  for (const [index, department] of DEPARTMENTS.entries()) {
    const limit = department === "PM" ? TASK_ATTACHMENT_LIMIT : LARGE_LOG_ATTACHMENT_LIMIT;
    assert.throws(() => f.service.addLog(f.tokens[index + 1], department, "1", input(department, 2), { ...file(), content: Buffer.alloc(limit + 1) }), error(413));
  }
  assert.deepEqual(counts(f.db), before);
});

test("stale versions, completed assignments and held/closed jobs never leave orphan log files", async (t) => {
  const f = await fixture(t); const before = counts(f.db);
  assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 1), file()), error(409));
  for (const state of ["Hold", "Closed"]) {
    f.db.prepare("UPDATE tasks SET Job_Status=? WHERE id=1").run(state);
    assert.throws(() => f.service.authorizeLog(f.worker, "Electrical", "1"), error(409));
    assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), file()), error(409));
  }
  f.db.prepare("UPDATE tasks SET Job_Status='Active' WHERE id=1").run();
  f.db.prepare("UPDATE departments_assign SET status='Completed' WHERE task_id=1 AND department='Electrical'").run();
  assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), file()), error(409));
  assert.deepEqual(counts(f.db), before); assert.equal(f.service.getJob(f.worker, "Electrical", "1").version, 2);
});

test("file insert and either audit failure roll back the entire log-file transaction", async (t) => {
  const f = await fixture(t), before = counts(f.db);
  for (const table of ["crm_department_log_attachments", "crm_department_log_attachment_audit_events", "crm_department_audit_events"]) {
    f.db.exec(`CREATE TRIGGER fixture_log_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'internal file failure'); END`);
    assert.throws(() => f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), file()), (e: unknown) => error(503)(e) && e instanceof Error && !e.message.includes("internal file failure"));
    assert.deepEqual(counts(f.db), before); assert.equal(f.service.getJob(f.worker, "Electrical", "1").version, 2);
    f.db.exec("DROP TRIGGER fixture_log_failure");
  }
});

test("immutable log files cannot be relinked, edited or deleted and parent-author consistency is enforced by SQLite", async (t) => {
  const f = await fixture(t);
  f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), file());
  const log = f.service.listLogs(f.worker, "Electrical", "1").items[0]!;
  assert.throws(() => f.db.prepare("UPDATE crm_department_log_attachments SET log_id=999").run(), /immutable/);
  assert.throws(() => f.db.prepare("UPDATE crm_department_log_attachments SET content=zeroblob(file_size)").run(), /immutable/);
  assert.throws(() => f.db.prepare("DELETE FROM crm_department_log_attachments").run(), /immutable/);
  assert.throws(() => f.db.prepare("UPDATE crm_department_log_attachment_audit_events SET actor_user_id=1").run(), /immutable/);
  assert.throws(() => f.db.prepare("DELETE FROM crm_department_log_attachment_audit_events").run(), /immutable/);
  const insert = f.db.prepare(`INSERT INTO crm_department_log_attachments(id,log_id,uploaded_by,file_name,media_type,file_size,content_sha256,content)
    SELECT ?,?,?,file_name,media_type,file_size,content_sha256,content FROM crm_department_log_attachments WHERE id=?`);
  assert.throws(() => insert.run("synthetic-wrong-author", log.id, 1, log.attachment!.id), /author must match/);
  assert.throws(() => insert.run("synthetic-duplicate", log.id, 2, log.attachment!.id), /UNIQUE/);
  assert.throws(() => insert.run("synthetic-orphan", 999, 2, log.attachment!.id), /author must match/);
  assert.equal(counts(f.db).files, 1); assert.deepEqual(f.db.pragma("foreign_key_check"), []);
});

test("corrupt log-file content fails closed without returning file bytes", async (t) => {
  const f = await fixture(t);
  f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), file());
  const id = f.service.listLogs(f.worker, "Electrical", "1").items[0]!.attachment!.id;
  // Deliberate isolated storage-corruption fixture, never an application operation.
  f.db.exec("DROP TRIGGER crm_log_attachment_no_update");
  f.db.prepare("UPDATE crm_department_log_attachments SET content=zeroblob(file_size) WHERE id=?").run(id);
  assert.throws(() => f.service.downloadLogAttachment(f.worker, id), error(503));
  assert.throws(() => f.service.downloadLogAttachment(f.manager, id), error(503));
});

test("two SQLite connections reject concurrent stale log-files and online backup/reopen preserves bytes and relationships", async () => {
  const disk = filesystemFixture(); let db: Database.Database | undefined, second: Database.Database | undefined;
  try {
    db = openDatabase(disk.config, { create: true }); migrateDatabase(db); const f = await populate(db);
    second = openDatabase(disk.config); const other = createDepartmentsService(second, { now: () => NOW });
    f.service.addLog(f.worker, "Electrical", "1", input("Electrical", 2), file());
    const id = f.service.listLogs(f.worker, "Electrical", "1").items[0]!.attachment!.id;
    assert.throws(() => other.addLog(f.worker, "Electrical", "1", input("Electrical", 2), file()), error(409));
    assert.equal(counts(db).files, 1);
    const backup = await backupDatabase(db, disk.config), copy = new Database(backup, { readonly: true, fileMustExist: true });
    try {
      configureDatabase(copy, true);
      assert.deepEqual(createDepartmentsService(copy, { now: () => NOW }).downloadLogAttachment(f.worker, id).content, png());
      assert.deepEqual(copy.pragma("foreign_key_check"), []); assert.deepEqual(copy.pragma("quick_check"), [{ quick_check: "ok" }]);
    } finally { copy.close(); }
    second.close(); second = undefined; db.close(); db = undefined;
    db = openDatabase(disk.config);
    assert.deepEqual(createDepartmentsService(db, { now: () => NOW }).downloadLogAttachment(f.manager, id).content, png());
    assert.equal(counts(db).fileAudits, 1);
  } finally { second?.close(); db?.close(); disk.cleanup(); }
});
