import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { hashSync } from "bcryptjs";
import { strFromU8, unzipSync } from "fflate";
import { DEPARTMENTS, LOG_OPTIONS, type Department, type DepartmentJob, type JobAssignments, type Page, type WorkLog } from "@voltronix/crm-contracts";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase, migrations } from "../../tests/sqlite-reference/db/migrations.js";
import { createApp } from "../src/app.js";
import { DEPARTMENT_PERMISSIONS } from "../src/crm/auth/permissions.js";
import { createHttpLifecycle } from "../src/server.js";
import { createSqliteDemoRuntime } from "./runtime.js";

// Disposable HTTP evidence only. No demo path, saved credential, bypassed
// session or account/grant mutation is used by this acceptance fixture.
const requireNext = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireNext("better-sqlite3") as new (filename: string) => SqliteDatabase;
const origin = "http://127.0.0.1:3001";
interface Session { cookie: string; csrf: string }
function cookies(response: Response, previous = "") {
  const result = new Map<string, string>();
  for (const cookie of [...previous.split("; "), ...response.headers.getSetCookie().map(value => value.split(";")[0]!)]) {
    const split = cookie.indexOf("="); if (split > 0) result.set(cookie.slice(0, split), cookie.slice(split + 1));
  }
  return [...result].map(([name, value]) => `${name}=${value}`).join("; ");
}
function seed(db: SqliteDatabase, department: Department, password: string) {
  assert.equal(migrateDatabase(db), migrations.length);
  const hash = hashSync(password, 4), otherDepartment = department === "Civil" ? "Electrical" : "Civil";
  const user = db.prepare("INSERT INTO users(id,username,email,password,status,role,department_role) VALUES(?,?,?,?,?,'synthetic-worker-acceptance',?)");
  for (const [id, name, status, role] of [
    [1, "Manager", "active", null], [2, "Assigned worker", "active", department], [3, "Other worker", "active", department],
    [4, "Role without grant", "active", department], [5, "Inactive worker", "inactive", department], [6, "Wrong role", "active", otherDepartment],
  ] as const) user.run(id, name, `worker-${id}@example.invalid`, hash, status, role);
  for (const [id, permission] of [[1, "dashboard.view"], [2, DEPARTMENT_PERMISSIONS[department]], [3, DEPARTMENT_PERMISSIONS[department]],
    [5, DEPARTMENT_PERMISSIONS[department]], [6, DEPARTMENT_PERMISSIONS[department]]] as const) {
    db.prepare('INSERT OR IGNORE INTO permissions("key",label) VALUES(?,?)').run(permission, permission);
    db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, permission);
  }
  for (const id of [1, 2]) db.prepare("INSERT INTO tasks(id,deal_name,status,Job_Status,job_deal_number) VALUES(?,?,'Closed Won','Active',?)")
    .run(id, `Disposable ${department} job ${id}`, `WORKER-${id}`);
}
function png() {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); head.write(type, 4);
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([head, data, tail]);
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(1); head.writeUInt32BE(1, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
function identitySnapshot(db: SqliteDatabase) {
  return createHash("sha256").update(JSON.stringify([
    db.prepare("SELECT * FROM users ORDER BY id").all(), db.prepare("SELECT * FROM permissions ORDER BY id").all(),
    db.prepare("SELECT * FROM admin_user_permissions ORDER BY id").all(),
  ])).digest("hex");
}
function businessSnapshot(db: SqliteDatabase) {
  return createHash("sha256").update(JSON.stringify([
    "tasks", "departments_assign", "crm_department_work_logs", "crm_department_audit_events", "crm_department_log_attachments",
    "crm_department_log_attachment_audit_events", "crm_job_audit_events",
  ].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()))).digest("hex");
}
async function start(db: SqliteDatabase, password: string) {
  const runtime = createSqliteDemoRuntime(db);
  const server = createServer(createApp({ environment: "test", host: "127.0.0.1", port: 3002, appOrigin: origin },
    { auth: runtime.auth, crmServices: runtime.services })), lifecycle = createHttpLifecycle(server);
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const request = (path: string, session?: Session, method = "GET", body?: unknown, extra: Record<string, string> = {}) => fetch(base + path, {
    method, redirect: "error", headers: { origin, ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}),
      ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }), ...extra },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const login = async (id: number, expectedStatus = 200): Promise<Session> => {
    const challenge = await request("/auth/csrf"); assert.equal(challenge.status, 200);
    const csrf = (await challenge.json() as { csrfToken: string }).csrfToken;
    const response = await request("/auth/login", { cookie: cookies(challenge), csrf }, "POST", { email: `worker-${id}@example.invalid`, password });
    assert.equal(response.status, expectedStatus);
    const body = await response.json() as { csrfToken?: string };
    return { cookie: cookies(response), csrf: body.csrfToken ?? "" };
  };
  return { request, login, stop: async () => { await lifecycle.stop(); await runtime.close(); } };
}
async function json<T>(response: Response): Promise<T> {
  assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>;
}
async function refused(response: Response, status: number) { assert.equal(response.status, status); await response.arrayBuffer(); }

test("DISPOSABLE AUTHORIZATION source distinction: own task cross-department history is separate from foreign task and broad export", async () => {
  const password = randomBytes(24).toString("base64url"), db = new Database(":memory:");
  configureDatabase(db); seed(db, "Electrical", password);
  // Synthetic setup only: an extra department grant still does not authorize
  // that department's writes/detail; own-task history is independently readable.
  db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run("civil.manage", "civil.manage");
  for (const id of [2, 6]) db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, "civil.manage");
  const app = await start(db, password);
  try {
    const manager = await app.login(1), electrical = await app.login(2), foreign = await app.login(3), civil = await app.login(6);
    await json(await app.request("/jobs/1/assignments", manager, "POST", { expectedVersion: 1,
      assignments: [{ department: "Electrical", userId: "2" }, { department: "Civil", userId: "6" }] }));
    await json(await app.request("/jobs/2/assignments", manager, "POST", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] }));
    const entry = (department: "Electrical" | "Civil", expectedVersion: number) => ({ expectedVersion,
      authority: LOG_OPTIONS[department].authority[1], status: LOG_OPTIONS[department].status[1], notes: `${department} synthetic recorded history` });
    await json(await app.request("/departments/Electrical/jobs/1/logs", electrical, "POST", entry("Electrical", 2)));
    const content = png(), form = new FormData(); form.set("payload", JSON.stringify(entry("Civil", 3)));
    form.set("file", new Blob([new Uint8Array(content)], { type: "image/png" }), "synthetic-other-department.png");
    await json(await app.request("/departments/Civil/jobs/1/logs", civil, "POST", form));
    const beforeBusiness = businessSnapshot(db), beforeIdentity = identitySnapshot(db);
    const beforeSessions = db.prepare("SELECT * FROM crm_sessions ORDER BY token_hash").all();
    const own = await json<Page<WorkLog>>(await app.request("/departments/Electrical/jobs/1/logs", electrical));
    assert.equal(own.total, 1); assert.equal(own.items[0]!.department, "Electrical");
    const otherDepartment = await json<Page<WorkLog>>(await app.request("/departments/Civil/jobs/1/logs", civil));
    assert.equal(otherDepartment.total, 1); assert.equal(otherDepartment.items[0]!.department, "Civil");
    const fileId = otherDepartment.items[0]!.attachment!.id;
    assert.equal((await json<DepartmentJob>(await app.request("/departments/Electrical/jobs/1", electrical))).id, "1");
    await refused(await app.request("/departments/Civil/jobs/1", electrical), 404); // detail stays department-owned
    assert.deepEqual(await json(await app.request("/departments/Civil/jobs/1/logs", electrical)), otherDepartment);
    for (const suffix of ["", "/logs"]) await refused(await app.request("/departments/Electrical/jobs/2" + suffix, electrical), 404);
    await refused(await app.request("/departments/Civil/jobs/1", foreign), 403);
    await refused(await app.request("/departments/Civil/jobs/1/logs", foreign), 404); // other assignment belongs to another task
    await refused(await app.request("/departments/Civil/jobs/1/logs", electrical, "POST", entry("Civil", 4)), 404);
    await refused(await app.request("/departments/Civil/jobs/1/status", electrical, "PATCH", { expectedVersion: 4, status: "Process" }), 404);
    await refused(await app.request("/jobs/1/logs?department=Civil", electrical), 403); // manager endpoint is not an alternate route
    for (const method of ["GET", "HEAD"]) for (const suffix of ["", "/preview"]) {
      await refused(await app.request(`/log-attachments/${fileId}` + suffix, electrical, method), 200);
      await refused(await app.request(`/log-attachments/${fileId}` + suffix, foreign, method), 404);
      for (const actor of [manager, civil]) await refused(await app.request(`/log-attachments/${fileId}` + suffix, actor, method), 200);
    }
    const managerLogs = await json<Page<WorkLog>>(await app.request("/jobs/1/logs?department=Civil", manager));
    assert.equal(managerLogs.items[0]!.id, otherDepartment.items[0]!.id);
    const exported = await app.request("/departments/Electrical/export", electrical); assert.equal(exported.status, 200);
    const xml = strFromU8(unzipSync(new Uint8Array(await exported.arrayBuffer()))["xl/worksheets/sheet1.xml"]!);
    assert.match(xml, /WORKER-1/); assert.doesNotMatch(xml, /WORKER-2/);
    const emptyExport = await app.request("/departments/Civil/export", electrical); assert.equal(emptyExport.status, 200);
    const emptyXml = strFromU8(unzipSync(new Uint8Array(await emptyExport.arrayBuffer()))["xl/worksheets/sheet1.xml"]!);
    assert.doesNotMatch(emptyXml, /WORKER-1|WORKER-2/);
    await refused(await app.request("/jobs/export", electrical), 403);
    assert.equal(businessSnapshot(db), beforeBusiness); assert.equal(identitySnapshot(db), beforeIdentity);
    assert.deepEqual(db.prepare("SELECT * FROM crm_sessions ORDER BY token_hash").all(), beforeSessions);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    for (const session of [electrical, foreign, civil, manager]) await refused(await app.request("/auth/logout", session, "POST", {}), 200);
  } finally { await app.stop(); }
});

test("APPROVED DISPOSABLE READS: all five assigned workers read every department history and file while foreign writes and tasks remain denied", async () => {
  const password = randomBytes(24).toString("base64url"), db = new Database(":memory:");
  configureDatabase(db); seed(db, "Electrical", password);
  for (const [index, department] of DEPARTMENTS.entries()) {
    db.prepare("INSERT INTO users(id,username,email,password,status,department_role) VALUES(?,?,?,?,'active',?)")
      .run(index + 10, `Synthetic ${department}`, `worker-${index + 10}@example.invalid`, hashSync(password, 4), department);
    db.prepare('INSERT OR IGNORE INTO permissions("key",label) VALUES(?,?)').run(DEPARTMENT_PERMISSIONS[department], department);
    db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(index + 10, DEPARTMENT_PERMISSIONS[department]);
  }
  const app = await start(db, password);
  try {
    const manager = await app.login(1), foreign = await app.login(3);
    const workers = await Promise.all(DEPARTMENTS.map((_, index) => app.login(index + 10)));
    await json(await app.request("/jobs/1/assignments", manager, "POST", { expectedVersion: 1,
      assignments: DEPARTMENTS.map((department, index) => ({ department, userId: String(index + 10) })) }));
    await json(await app.request("/jobs/2/assignments", manager, "POST", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] }));
    const files: string[] = [];
    for (const [index, department] of DEPARTMENTS.entries()) {
      const options = LOG_OPTIONS[department], form = new FormData();
      form.set("payload", JSON.stringify({ expectedVersion: index + 2, status: options.status[1], notes: `${department} synthetic history`,
        ...("authority" in options ? { authority: options.authority[1] } : { scope: options.scope[1] }) }));
      form.set("file", new Blob([new Uint8Array(png())], { type: "image/png" }), `synthetic-${department}.png`);
      await json(await app.request(`/departments/${department}/jobs/1/logs`, workers[index], "POST", form));
      files.push((await json<Page<WorkLog>>(await app.request(`/departments/${department}/jobs/1/logs`, workers[index]))).items[0]!.attachment!.id);
    }
    const before = businessSnapshot(db), identities = identitySnapshot(db), sessions = db.prepare("SELECT * FROM crm_sessions ORDER BY token_hash").all();
    for (const [index, worker] of workers.entries()) for (const [target, department] of DEPARTMENTS.entries()) {
      const history = await json<Page<WorkLog>>(await app.request(`/departments/${department}/jobs/1/logs`, worker));
      assert.equal(history.items[0]!.department, department); assert.equal(history.items[0]!.attachment!.id, files[target]);
      for (const method of ["GET", "HEAD"]) for (const suffix of ["", "/preview"]) {
        await refused(await app.request(`/log-attachments/${files[target]}` + suffix, worker, method), 200);
        await refused(await app.request(`/log-attachments/${files[target]}` + suffix, foreign, method), 404);
      }
      await refused(await app.request(`/departments/${department}/jobs/2/logs`, worker), 404);
      if (index !== target) {
        await refused(await app.request(`/departments/${department}/jobs/1`, worker), 403);
        await refused(await app.request(`/departments/${department}/jobs/1/logs`, worker, "POST", { expectedVersion: 7 }), 403);
        await refused(await app.request(`/departments/${department}/jobs/1/status`, worker, "PATCH", { expectedVersion: 7, status: "Process" }), 403);
        await refused(await app.request(`/departments/${department}/export`, worker), 403);
      }
    }
    assert.equal(businessSnapshot(db), before); assert.equal(identitySnapshot(db), identities);
    assert.deepEqual(db.prepare("SELECT * FROM crm_sessions ORDER BY token_hash").all(), sessions);
    // Simulate changes only in this disposable fixture to prove reads recheck
    // current grants/status/assignment/expiry rather than a cached tab decision.
    db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=10").run();
    await refused(await app.request("/departments/Civil/jobs/1/logs", workers[0]), 403);
    await refused(await app.request(`/log-attachments/${files[1]}`, workers[0]), 404);
    db.prepare("UPDATE users SET status='inactive' WHERE id=11").run();
    await refused(await app.request("/departments/Electrical/jobs/1/logs", workers[1]), 401);
    await refused(await app.request(`/log-attachments/${files[0]}`, workers[1]), 401);
    db.prepare("UPDATE crm_sessions SET expires_at=? WHERE user_id=12").run(Date.now() - 1);
    await refused(await app.request("/departments/Civil/jobs/1/logs", workers[2]), 401);
    await refused(await app.request(`/log-attachments/${files[1]}`, workers[2]), 401);
    await json(await app.request("/jobs/1/unassign", manager, "POST", { expectedVersion: 7, department: "Switchgear" }));
    await refused(await app.request("/departments/Civil/jobs/1/logs", workers[3]), 404);
    await refused(await app.request(`/log-attachments/${files[1]}`, workers[3]), 404);
    db.prepare("UPDATE tasks SET status='Qualification' WHERE id=1").run();
    await refused(await app.request("/departments/Civil/jobs/1/logs", workers[4]), 404);
    await refused(await app.request(`/log-attachments/${files[1]}`, workers[4]), 404);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { await app.stop(); }
});

for (const department of DEPARTMENTS) test(`DISPOSABLE AUTHENTICATED HTTP ${department}: assignment, log/file, status, scope revocation and reopen persistence`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "crm-worker-http-")), filename = join(directory, "worker.sqlite");
  const password = randomBytes(24).toString("base64url"), db = new Database(filename); configureDatabase(db); seed(db, department, password);
  const identities = identitySnapshot(db); let app = await start(db, password);
  try {
    const manager = await app.login(1), worker = await app.login(2), other = await app.login(3), roleOnly = await app.login(4);
    await app.login(5, 401);
    const path = `/departments/${department}/jobs/1`, queue = `/departments/${department}/jobs`;
    await refused(await app.request(queue), 401);
    for (const caller of [manager, roleOnly]) await refused(await app.request(queue, caller), 403);
    await refused(await app.request(path, worker), 404);
    const assignees = await json<Page<{ id: string }>>(await app.request(`/departments/${department}/assignees`, manager));
    assert.deepEqual(assignees.items.map(user => user.id).sort(), ["2", "3", "4"]);
    const assign = (taskId: string, userId: string, version: number, caller = manager) =>
      app.request(`/jobs/${taskId}/assignments`, caller, "POST", { expectedVersion: version, assignments: [{ department, userId }] });
    for (const id of ["5", "6"]) await refused(await assign("1", id, 1), 400);
    await refused(await assign("1", "2", 1, worker), 403);
    let state = await json<JobAssignments>(await assign("1", "2", 1)); assert.equal(state.version, 2);
    await json<JobAssignments>(await assign("2", "3", 1));
    let record = await json<DepartmentJob>(await app.request(path, worker));
    assert.equal(record.assignment.userId, "2"); assert.equal(record.assignment.actorId, "1");
    assert.deepEqual((await json<Page<DepartmentJob>>(await app.request(queue, worker))).items.map(item => item.id), ["1"]);
    for (const suffix of ["", "/logs"]) await refused(await app.request(path + suffix, other), 404);
    await refused(await app.request(`/departments/${department === "Electrical" ? "Civil" : "Electrical"}/jobs/1`, worker), 403);
    const options = LOG_OPTIONS[department], notes = `<script>synthetic ${department} notes</script>`;
    const entry = { expectedVersion: record.version, status: options.status[1], notes,
      ...("authority" in options ? { authority: options.authority[1], comments: "Synthetic authority response" } : { scope: options.scope[1] }) };
    const snapshot = businessSnapshot(db);
    await refused(await app.request(path + "/logs", worker, "POST", { ...entry, actorId: "1" }), 400);
    await refused(await app.request(path + "/logs", worker, "POST", entry, { "x-csrf-token": "wrong" }), 403);
    await refused(await app.request(path + "/logs", worker, "POST", entry, { origin: "https://untrusted.invalid" }), 403);
    await refused(await app.request(path + "/logs", other, "POST", entry), 404);
    assert.equal(businessSnapshot(db), snapshot);
    const file = png(), form = new FormData(); form.set("payload", JSON.stringify(entry));
    form.set("file", new Blob([new Uint8Array(file)], { type: "image/png" }), "synthetic-worker-log.png");
    record = await json<DepartmentJob>(await app.request(path + "/logs", worker, "POST", form)); assert.equal(record.version, 3);
    const logs = await json<Page<WorkLog>>(await app.request(path + "/logs", worker)); assert.equal(logs.total, 1);
    const log = logs.items[0]!; assert.equal(log.actorId, "2"); assert.equal(log.assignmentId, record.assignment.id); assert.equal(log.notes, notes);
    assert.equal(log.department, department); assert.ok(log.attachment); const filePath = `/log-attachments/${log.attachment.id}`;
    for (const caller of [worker, manager]) {
      const downloaded = await app.request(filePath, caller); assert.equal(downloaded.status, 200);
      assert.equal(downloaded.headers.get("cache-control"), "private, no-store"); assert.match(downloaded.headers.get("content-disposition")!, /^attachment;/);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), file);
      const preview = await app.request(filePath + "/preview", caller); assert.equal(preview.status, 200);
      assert.equal(preview.headers.get("content-type"), "image/png"); assert.match(preview.headers.get("content-disposition")!, /^inline;/);
      assert.equal(preview.headers.get("cache-control"), "private, no-store");
      assert.equal(preview.headers.get("content-security-policy"), "sandbox; default-src 'none'");
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), file);
    }
    await refused(await app.request(filePath), 401);
    await refused(await app.request(filePath + "/preview"), 401);
    for (const caller of [other, roleOnly]) for (const suffix of ["", "/preview"]) await refused(await app.request(filePath + suffix, caller), 404);
    const status = (value: string, expectedVersion = record.version) => app.request(path + "/status", worker, "PATCH", { expectedVersion, status: value });
    record = await json<DepartmentJob>(await status("Completed")); assert.equal(record.assignment.status, "Completed");
    await refused(await app.request(path + "/logs", worker, "POST", { ...entry, expectedVersion: record.version }), 409);
    await refused(await app.request("/jobs/1/unassign", manager, "POST", { expectedVersion: record.version, department }), 409);
    record = await json<DepartmentJob>(await status("Process")); assert.equal(record.assignment.status, "Process");
    await refused(await status("Completed", record.version - 1), 409);
    const changed = await json<{ version: number }>(await app.request("/jobs/1/status", manager, "PATCH", { expectedVersion: record.version, jobStatus: "Hold" }));
    const heldSnapshot = businessSnapshot(db);
    await refused(await status("Completed", changed.version), 409);
    await refused(await app.request(path + "/logs", worker, "POST", { ...entry, expectedVersion: changed.version }), 409);
    assert.equal(businessSnapshot(db), heldSnapshot);
    assert.equal((await json<Page<DepartmentJob>>(await app.request(queue + "?status=Hold", worker))).total, 1);
    assert.equal((await json<Page<DepartmentJob>>(await app.request(queue + "?status=Process", worker))).total, 0);
    await json(await app.request("/jobs/1/status", manager, "PATCH", { expectedVersion: changed.version, jobStatus: "Active" }));
    record = await json<DepartmentJob>(await app.request(path, worker));
    const exported = await app.request(`/departments/${department}/export`, worker); assert.equal(exported.status, 200);
    const xml = strFromU8(unzipSync(new Uint8Array(await exported.arrayBuffer()))["xl/worksheets/sheet1.xml"]!);
    assert.match(xml, /WORKER-1/); assert.doesNotMatch(xml, /WORKER-2|<f>/);
    state = await json<JobAssignments>(await assign("1", "3", record.version));
    for (const deniedPath of [path, path + "/logs", filePath, filePath + "/preview"]) await refused(await app.request(deniedPath, worker), 404);
    await refused(await app.request(path + "/logs", worker, "POST", { ...entry, expectedVersion: state.version }), 404);
    assert.equal((await json<Page<DepartmentJob>>(await app.request(queue, worker))).total, 0);
    assert.deepEqual(await json<Page<WorkLog>>(await app.request(path + "/logs", other)), logs);
    const reassignedFile = await app.request(filePath, other); assert.equal(reassignedFile.status, 200);
    assert.deepEqual(Buffer.from(await reassignedFile.arrayBuffer()), file);
    state = await json<JobAssignments>(await app.request("/jobs/1/unassign", manager, "POST", { expectedVersion: state.version, department }));
    for (const deniedPath of [path, path + "/logs", filePath, filePath + "/preview"]) await refused(await app.request(deniedPath, other), 404);
    state = await json<JobAssignments>(await assign("1", "3", state.version));
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS total FROM departments_assign WHERE task_id=1").get(), { total: 4 });
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS total FROM crm_department_work_logs").get(), { total: 1 });
    assert.equal(identitySnapshot(db), identities); assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    const finalBusiness = businessSnapshot(db);
    for (const session of [worker, other, roleOnly, manager]) await refused(await app.request("/auth/logout", session, "POST", {}), 200);
    await app.stop();
    const reopened = new Database(filename); configureDatabase(reopened);
    assert.equal(businessSnapshot(reopened), finalBusiness); assert.equal(identitySnapshot(reopened), identities);
    app = await start(reopened, password);
    const fresh = await app.login(3);
    assert.equal((await json<DepartmentJob>(await app.request(path, fresh))).version, state.version);
    assert.deepEqual(await json<Page<WorkLog>>(await app.request(path + "/logs", fresh)), logs);
    const persisted = await app.request(filePath, fresh); assert.equal(persisted.status, 200); assert.deepEqual(Buffer.from(await persisted.arrayBuffer()), file);
    const previewAfterReopen = await app.request(filePath + "/preview", fresh); assert.equal(previewAfterReopen.status, 200);
    assert.deepEqual(Buffer.from(await previewAfterReopen.arrayBuffer()), file);
    assert.equal(identitySnapshot(reopened), identities); assert.equal(businessSnapshot(reopened), finalBusiness);
    await refused(await app.request("/auth/logout", fresh, "POST", {}), 200);
  } finally {
    await app.stop();
    // Resolve and bound the recursive cleanup to this newly allocated fixture.
    const target = resolve(directory), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && basename(target).startsWith("crm-worker-http-"));
    rmSync(target, { recursive: true, force: true });
  }
});
