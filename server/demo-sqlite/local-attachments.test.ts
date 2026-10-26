import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { hashSync } from "bcryptjs";
import { LARGE_LOG_ATTACHMENT_LIMIT, TASK_ATTACHMENT_LIMIT, LOG_OPTIONS, type Department, type DepartmentJob, type WorkLog } from "@voltronix/crm-contracts";
import { DEPARTMENT_PERMISSIONS } from "../src/crm/auth/permissions.js";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { createApp } from "../src/app.js";
import { createHttpLifecycle } from "../src/server.js";
import { createSqliteDemoRuntime } from "./runtime.js";
import { applyLocalWorkflowExtension } from "./workflow-schema.js";
import { syntheticActionPdf } from "../../tests/helpers/pdf-upload-fixture.js";
import { syntheticStreamPdf } from "../../tests/helpers/pdf-stream-http-fixture.js";
import { syntheticGif } from "../../tests/gif-fixture.js";
import { compoundOffice, officeZip, webp, bmp, rar4, sevenZip } from "../../tests/helpers/attachment-format-fixtures.js";
import { forwardToExpress } from "../../src/server/express-bridge.js";

const requireNext = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireNext("better-sqlite3") as new (path: string) => SqliteDatabase;
const password = "Disposable attachment HTTP fixture password", passwordHash = hashSync(password, 4);
const origin = "http://127.0.0.1:3001", bytes = Buffer.from("Synthetic local attachment scope evidence\n");
const deal = { firstName: "Attachment", lastName: "Fixture", companyName: "DISPOSABLE attachment fixture", email: "scope@example.invalid",
  mobile: "000000", phone: "000001", department: "VOLTRONIX CONTRACTING LLC", poBox: "", trn: "", address: "Disposable test", description: "Synthetic test only" };
interface Session { cookie: string; csrf: string }
function cookies(response: Response) { return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]!).join("; "); }
async function fixture(t: TestContext, department: Department = "Electrical") {
  // Always a disposable in-memory database. No path, credential, account or grant
  // from the user's persistent demo is opened, copied or modified by these tests.
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); applyLocalWorkflowExtension(db);
  for (let id = 1; id <= 8; id++) db.prepare("INSERT INTO users(id,user_id,username,email,password,status,department_role) VALUES(?,?,?,?,?,'active',?)")
    .run(id, id === 4 ? "legacy-agent" : id === 5 ? "another-agent" : null, `Synthetic attachment user ${id}`, `attachment-http-${id}@example.invalid`, passwordHash, id === 7 ? department : null);
  const permissions = ["deals.manage", "leads.manage.agents", "leads.view", "leads.manage", "dashboard.view", DEPARTMENT_PERMISSIONS[department]];
  for (const key of permissions) db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run(key, key);
  for (const [id, grants] of [[1, permissions.slice(0, 4)], [2, permissions.slice(0, 4)], [3, ["leads.view"]],
    [4, ["leads.manage.agents", "leads.view"]], [6, ["dashboard.view"]], [7, [DEPARTMENT_PERMISSIONS[department]]], [8, ["deals.manage"]]] as const)
    for (const key of grants) db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
  db.prepare(`INSERT INTO tasks(id,deal_name,status,assigned_to,deal_crm_created_by) VALUES
    (100,'Historical null ID is not local','Qualification',NULL,1),
    (101,'Historical own agent','Qualification','legacy-agent',4),
    (102,'Historical outside agent','Qualification','another-agent',5),
    (103,'Historical won job','Closed Won',NULL,5)`).run();
  db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(102,7,'Electrical','Assigned')").run();
  const runtime = createSqliteDemoRuntime(db), app = createApp({ environment: "test", host: "127.0.0.1", port: 3002, appOrigin: origin },
    { auth: runtime.auth, crmServices: runtime.services });
  const server = createServer(app), lifecycle = createHttpLifecycle(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await lifecycle.stop(); await runtime.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const request = (path: string, session?: Session, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, redirect: "error", headers: { origin, ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}),
      ...(body === undefined || body instanceof FormData ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  const login = async (id: number): Promise<Session> => {
    const challenge = await request("/auth/csrf"); assert.equal(challenge.status, 200);
    const csrf = (await challenge.json() as { csrfToken: string }).csrfToken;
    const response = await request("/auth/login", { cookie: cookies(challenge), csrf }, "POST", { email: `attachment-http-${id}@example.invalid`, password });
    assert.equal(response.status, 200);
    return { cookie: cookies(response), csrf: (await response.json() as { csrfToken: string }).csrfToken };
  };
  const create = async (session: Session) => {
    const response = await request("/deals", session, "POST", { operationId: randomUUID(), ...deal }); assert.equal(response.status, 200);
    return await response.json() as { taskId: string; version: number };
  };
  const upload = (session: Session, taskId: string, version = 1, csrf = session.csrf, name = "fixture.txt", content: Buffer = bytes, type = "text/plain") => {
    const form = new FormData(); form.set("expectedVersion", String(version)); form.set("file", new File([new Uint8Array(content)], name, { type }));
    return fetch(`${base}/leads/${taskId}/attachments`, { method: "POST", body: form, redirect: "error",
      headers: { origin, cookie: session.cookie, "x-csrf-token": csrf } });
  };
  const staticRequest = (path: string, session?: Session) => fetch(new URL(path, base), {
    redirect: "error", headers: { origin, ...(session ? { cookie: session.cookie } : {}) },
  });
  return { db, runtime, request, staticRequest, login, create, upload, base };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
test("LOCAL ATTACHMENT HTTP bounded PDF stream validation retains upload, CSRF, size, private GET/HEAD and foreign-owner boundaries", async t => {
  const f = await fixture(t), owner = await f.login(1), other = await f.login(2), task = await f.create(owner);
  const content = syntheticStreamPdf(), before = snapshot(f);
  assert.equal((await f.upload(other, task.taskId, 1, other.csrf, "stream.pdf", content, "application/pdf")).status, 404);
  assert.equal((await f.upload(owner, task.taskId, 1, "invalid-csrf", "stream.pdf", content, "application/pdf")).status, 403);
  const anonymous = new FormData(); anonymous.set("expectedVersion", "1"); anonymous.set("file", new File([new Uint8Array(content)], "stream.pdf", { type: "application/pdf" }));
  assert.equal((await f.request(`/leads/${task.taskId}/attachments`, undefined, "POST", anonymous)).status, 401);
  for (const [name, type, bytes, status] of [
    ["stream.png", "image/png", content, 415],
    ["stream.pdf", "image/png", content, 415],
    ["stream.pdf", "application/pdf", Buffer.concat([content, Buffer.from("hidden object")]), 415],
    ["stream.pdf", "application/pdf", syntheticActionPdf("/S /Named /N /Print"), 415],
    ["stream.pdf", "application/pdf", Buffer.alloc(TASK_ATTACHMENT_LIMIT + 1, 65), 413],
  ] as const) assert.equal((await f.upload(owner, task.taskId, 1, owner.csrf, name, bytes, type)).status, status);
  assert.deepEqual(snapshot(f), before);
  const uploaded = await f.upload(owner, task.taskId, 1, owner.csrf, "stream.pdf", content, "application/pdf");
  assert.equal(uploaded.status, 200);
  const file = await uploaded.json() as { id: string; version: number }; assert.equal(file.version, 2);
  assert.equal((await f.upload(owner, task.taskId, 1, owner.csrf, "stream.pdf", content, "application/pdf")).status, 409);
  for (const method of ["GET", "HEAD"]) {
    const response = await f.request(`/attachments/${file.id}`, owner, method); assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy")!, /sandbox/);
    if (method === "GET") assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    assert.equal((await f.request(`/attachments/${file.id}`, other, method)).status, 404);
    assert.equal((await f.request(`/attachments/${file.id}`, undefined, method)).status, 401);
    assert.equal((await f.request(`/attachments/${file.id}/preview`, owner, method)).status, 415);
  }
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM crm_attachment_audit_events").get() as { n: number }).n, 1);
});

test("LOCAL LOG HTTP bounded PDF private bytes retain preview refusal and current assignment authorization", async t => {
  const f = await fixture(t), content = syntheticStreamPdf(true);
  const log = await ownLog(f, "Electrical", { name: "stream.pdf", type: "application/pdf", content });
  for (const method of ["GET", "HEAD"]) {
    const response = await f.request(`/log-attachments/${log.id}`, log.worker, method); assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition")!, /^attachment;/); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.match(response.headers.get("content-security-policy")!, /sandbox/);
    if (method === "GET") assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    assert.equal((await f.request(`/log-attachments/${log.id}/preview`, log.worker, method)).status, 415);
    assert.equal((await f.request(`/log-attachments/${log.id}`, undefined, method)).status, 401);
  }
  const before = logSnapshot(f), form = new FormData();
  form.set("payload", JSON.stringify({ expectedVersion: log.version, status: LOG_OPTIONS.Electrical.status[1], notes: "Rejected synthetic action", authority: LOG_OPTIONS.Electrical.authority[1], comments: "Synthetic" }));
  form.set("file", new File([new Uint8Array(syntheticActionPdf("/S /Named /N /Print"))], "active.pdf", { type: "application/pdf" }));
  assert.equal((await f.request("/departments/Electrical/jobs/103/logs", log.worker, "POST", form)).status, 415);
  assert.deepEqual(logSnapshot(f), before);
  assert.equal((await f.request("/jobs/103/unassign", log.manager, "POST", { expectedVersion: log.version, department: "Electrical" })).status, 200);
  for (const method of ["GET", "HEAD"]) for (const suffix of ["", "/preview"])
    assert.equal((await f.request(`/log-attachments/${log.id}${suffix}`, log.worker, method)).status, 404);
});

test("LOCAL ATTACHMENT HTTP Office/archive/BMP task uploads retain exact bytes, versions/audits and download-only boundaries", async t => {
  const f = await fixture(t), owner = await f.login(1), task = await f.create(owner); let version = task.version;
  const files = [["fixture.doc", compoundOffice("doc")], ["fixture.xls", compoundOffice("xls", true)], ["fixture.ppt", compoundOffice("ppt")], ["fixture.docx", officeZip("docx")], ["fixture.xlsx", officeZip("xlsx")], ["fixture.pptx", officeZip("pptx")], ["fixture.rar", rar4()], ["fixture.7z", sevenZip()], ["fixture.bmp", bmp()], ["fixture.webp", webp()]] as const;
  for (const [name, content] of files) {
    const response = await f.upload(owner, task.taskId, version, owner.csrf, name, content, "application/octet-stream"); assert.equal(response.status, 200, name);
    const file = await response.json() as { id: string; version: number }; assert.equal(file.version, ++version);
    const saved = await f.request(`/attachments/${file.id}`, owner); assert.equal(saved.status, 200); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), content);
    assert.match(saved.headers.get("content-disposition")!, /^attachment;/); assert.equal((await f.request(`/attachments/${file.id}/preview`, owner)).status, 415);
    assert.equal((await f.request(`/attachments/${file.id}`)).status, 401);
  }
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM crm_attachment_audit_events").get() as { n: number }).n, files.length);
});

test("LOCAL ATTACHMENT HTTP and Next forwarding carry exact 51,200KB Switchgear CSV bytes; +1 and task limits refuse atomically", { timeout: 120_000 }, async t => {
  const f = await fixture(t, "Switchgear"), manager = await f.login(6), worker = await f.login(7);
  assert.equal((await f.request("/jobs/103/assignments", manager, "POST", { expectedVersion: 1, assignments: [{ department: "Switchgear", userId: "7" }] })).status, 200);
  const path = "/api/departments/Switchgear/jobs/103/logs", environment = { CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: new URL(f.base).origin, APP_ORIGIN: origin };
  const submit = (size: number, version: number, session = worker, department = "Switchgear") => {
    const form = new FormData(); form.set("payload", JSON.stringify({ expectedVersion: version, status: LOG_OPTIONS.Switchgear.status[1], scope: LOG_OPTIONS.Switchgear.scope[1], notes: "Synthetic exact-limit fixture" })); form.set("file", new File([new Uint8Array(size).fill(65)], "limit.csv", { type: "text/csv" }));
    return forwardToExpress(new Request(origin + path.replace("Switchgear", department), { method: "POST", headers: { origin, cookie: session.cookie, "x-csrf-token": session.csrf }, body: form }), environment);
  };
  const saved = await submit(LARGE_LOG_ATTACHMENT_LIMIT, 2); assert.equal(saved.status, 200); assert.equal((await saved.json() as DepartmentJob).version, 3);
  const page = await (await f.request("/departments/Switchgear/jobs/103/logs", worker)).json() as { items: WorkLog[] }; const file = page.items[0]!.attachment!;
  assert.equal(file.size, LARGE_LOG_ATTACHMENT_LIMIT);
  for (const suffix of ["", "/preview"]) {
    const response = await forwardToExpress(new Request(origin + `/api/log-attachments/${file.id}${suffix}`, { headers: { origin, cookie: worker.cookie } }), environment);
    assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, LARGE_LOG_ATTACHMENT_LIMIT);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(Buffer.alloc(LARGE_LOG_ATTACHMENT_LIMIT, 65)).digest("hex"));
    assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("content-type"), suffix ? "text/plain; charset=utf-8" : "text/csv; charset=utf-8");
  }
  const before = logSnapshot(f); assert.equal((await submit(LARGE_LOG_ATTACHMENT_LIMIT + 1, 3)).status, 413); assert.deepEqual(logSnapshot(f), before);
  assert.equal((await submit(1, 3, manager)).status, 403); assert.deepEqual(logSnapshot(f), before);
  const owner = await f.login(1), ownTask = await f.create(owner); const taskTooLarge = await f.upload(owner, ownTask.taskId, 1, owner.csrf, "limit.txt", Buffer.alloc(TASK_ATTACHMENT_LIMIT + 1, 65)); assert.equal(taskTooLarge.status, 413);
});
function snapshot(f: Fixture) {
  return ["tasks", "task_attachment", "crm_attachment_audit_events"].map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
async function ownFile(f: Fixture, session: Session) {
  const task = await f.create(session), response = await f.upload(session, task.taskId); assert.equal(response.status, 200);
  const file = await response.json() as { id: string; version: number }; return { taskId: task.taskId, ...file };
}
async function ownLog(f: Fixture, department: Department = "Electrical", file: { name: string; type: string; content: Buffer } = { name: "fixture.gif", type: "image/gif", content: syntheticGif() }) {
  const manager = await f.login(6), worker = await f.login(7);
  const assigned = await f.request("/jobs/103/assignments", manager, "POST", { expectedVersion: 1, assignments: [{ department, userId: "7" }] });
  assert.equal(assigned.status, 200);
  const jobReply = await f.request(`/departments/${department}/jobs/103`, worker); assert.equal(jobReply.status, 200);
  const job = await jobReply.json() as DepartmentJob, form = new FormData(), choices = LOG_OPTIONS[department];
  form.set("payload", JSON.stringify({ expectedVersion: job.version, status: choices.status[1], notes: "Disposable attachment scope log",
    ...("authority" in choices ? { authority: choices.authority[1], comments: "Synthetic" } : { scope: choices.scope[1] }) }));
  form.set("file", new File([new Uint8Array(file.content)], file.name, { type: file.type }));
  const saved = await f.request(`/departments/${department}/jobs/103/logs`, worker, "POST", form); assert.equal(saved.status, 200);
  const updated = await saved.json() as DepartmentJob;
  const logs = await (await f.request(`/departments/${department}/jobs/103/logs`, worker)).json() as { items: WorkLog[] };
  return { manager, worker, content: file.content, id: logs.items[0]!.attachment!.id, version: updated.version };
}
function logSnapshot(f: Fixture) {
  return ["tasks", "departments_assign", "crm_department_work_logs", "crm_department_log_attachments", "crm_department_log_attachment_audit_events"]
    .map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test("LOCAL ATTACHMENT HTTP restrictive creator with no external ID uploads, lists, downloads and previews exact private bytes", async t => {
  const f = await fixture(t), owner = await f.login(1), accounts = f.db.prepare("SELECT * FROM users ORDER BY id").all();
  const grants = f.db.prepare("SELECT * FROM admin_user_permissions ORDER BY id").all(), historical = f.db.prepare("SELECT * FROM tasks WHERE id<=103 ORDER BY id").all();
  const file = await ownFile(f, owner); assert.equal(file.version, 2);
  const list = await f.request(`/leads/${file.taskId}/attachments`, owner); assert.equal(list.status, 200);
  const page = await list.json() as { total: number; version: number; canUpload: boolean; items: { id: string }[] };
  assert.equal(page.total, 1); assert.equal(page.version, 2); assert.equal(page.canUpload, true); assert.equal(page.items[0]!.id, file.id);
  assert.deepEqual(Object.keys(page.items[0]!).sort(), ["createdAt", "id", "mediaType", "name", "size"]);
  const response = await f.request(`/attachments/${file.id}`, owner); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.match(response.headers.get("content-disposition")!, /^attachment;/);
  const preview = await f.request(`/attachments/${file.id}/preview`, owner); assert.equal(preview.status, 200);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
  assert.equal(preview.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(preview.headers.get("content-disposition")!, /^inline;/);
  for (const key of ["cache-control", "vary", "x-content-type-options", "content-security-policy"])
    assert.equal(preview.headers.get(key), response.headers.get(key));
  assert.deepEqual(f.db.prepare("SELECT user_id,uploaded_by,content_sha256 FROM task_attachment WHERE id=?").get(file.id),
    { user_id: null, uploaded_by: 1, content_sha256: createHash("sha256").update(bytes).digest("hex") });
  assert.deepEqual(f.db.prepare("SELECT actor_user_id,task_id,action FROM crm_attachment_audit_events").all(),
    [{ actor_user_id: 1, task_id: Number(file.taskId), action: "attachments.create" }]);
  assert.deepEqual(f.db.prepare("SELECT * FROM users ORDER BY id").all(), accounts);
  assert.deepEqual(f.db.prepare("SELECT * FROM admin_user_permissions ORDER BY id").all(), grants);
  assert.deepEqual(f.db.prepare("SELECT * FROM tasks WHERE id<=103 ORDER BY id").all(), historical);
  assert.deepEqual(f.db.pragma("foreign_key_check"), []);
});

test("LOCAL ATTACHMENT HTTP other restrictive agent, no-grant creator and historical NULL owner cannot gain scope", async t => {
  const f = await fixture(t), owner = await f.login(1), other = await f.login(2), denied = await f.login(5), creatorOnly = await f.login(8);
  const file = await ownFile(f, owner), outside = await ownFile(f, other), noLead = await f.create(creatorOnly), before = snapshot(f);
  for (const [session, taskId, attachmentId] of [[other, file.taskId, file.id], [owner, outside.taskId, outside.id], [denied, file.taskId, file.id]] as const) {
    assert.equal((await f.request(`/leads/${taskId}/attachments`, session)).status, 404);
    const response = await f.request(`/attachments/${attachmentId}`, session); assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Attachment or record not found." });
    const preview = await f.request(`/attachments/${attachmentId}/preview`, session); assert.equal(preview.status, 404);
    assert.deepEqual(await preview.json(), { error: "Attachment or record not found." });
    assert.equal((await f.upload(session, taskId)).status, 404);
  }
  assert.equal((await f.request(`/leads/${noLead.taskId}/attachments`, creatorOnly)).status, 404);
  assert.equal((await f.upload(creatorOnly, noLead.taskId)).status, 404);
  assert.equal((await f.request("/leads/100/attachments", owner)).status, 404);
  assert.equal((await f.upload(owner, "100")).status, 404);
  assert.deepEqual(snapshot(f), before);
});

test("LOCAL ATTACHMENT HTTP historical assigned agent, broad reader, won manager and current worker scopes remain intact", async t => {
  const f = await fixture(t), agent = await f.login(4), reader = await f.login(3), manager = await f.login(6), worker = await f.login(7);
  const response = await f.upload(agent, "101"); assert.equal(response.status, 200); const file = await response.json() as { id: string };
  assert.equal((await f.request(`/attachments/${file.id}`, agent)).status, 200);
  assert.equal((await f.request(`/attachments/${file.id}/preview`, agent)).status, 200);
  assert.equal((await f.request(`/attachments/${file.id}/preview`, reader)).status, 200);
  assert.equal((await f.request("/leads/102/attachments", agent)).status, 404);
  const list = await f.request("/leads/101/attachments", reader); assert.equal(list.status, 200);
  assert.equal((await list.json() as { canUpload: boolean }).canUpload, false);
  assert.equal((await f.upload(reader, "101", 2)).status, 403);
  assert.equal((await f.upload(manager, "103")).status, 200);
  assert.equal((await f.request("/leads/101/attachments", manager)).status, 404);
  const upload = await f.upload(worker, "102"); assert.equal(upload.status, 200); const workerFile = await upload.json() as { id: string };
  assert.equal((await f.request(`/attachments/${workerFile.id}`, worker)).status, 200);
  assert.equal((await f.request(`/attachments/${workerFile.id}/preview`, worker)).status, 200);
  // A later assignment in this disposable fixture revokes the old worker's file access.
  f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(102,5,'Electrical','Assigned')").run();
  assert.equal((await f.request("/leads/102/attachments", worker)).status, 404);
  assert.equal((await f.request(`/attachments/${workerFile.id}`, worker)).status, 404);
  assert.equal((await f.request(`/attachments/${workerFile.id}/preview`, worker)).status, 404);
  assert.equal((await f.request(`/attachments/${workerFile.id}/preview`, worker, "HEAD")).status, 404);
});

test("LOCAL ATTACHMENT HTTP anonymous, forged, expired and logged-out sessions cannot reuse attachment URLs", async t => {
  const f = await fixture(t), owner = await f.login(1), file = await ownFile(f, owner);
  const paths = [`/leads/${file.taskId}/attachments`, `/attachments/${file.id}`, `/attachments/${file.id}/preview`];
  for (const path of paths) {
    assert.equal((await f.request(path)).status, 401);
    assert.equal((await f.request(path, { cookie: "crm_session=forged", csrf: "forged" })).status, 401);
  }
  f.db.prepare("UPDATE crm_sessions SET created_at=0,expires_at=1").run();
  for (const path of paths) assert.equal((await f.request(path, owner)).status, 401);
  const fresh = await f.login(1); assert.equal((await f.request(`/attachments/${file.id}`, fresh)).status, 200);
  assert.equal((await f.request("/auth/logout", fresh, "POST")).status, 200);
  for (const path of paths) assert.equal((await f.request(path, fresh)).status, 401);
});

test("LOCAL ATTACHMENT HTTP preview overrides and public upload URLs cannot bypass authenticated file scope", async t => {
  const f = await fixture(t), owner = await f.login(1), other = await f.login(2), file = await ownFile(f, owner);
  // Preview has a separate authorized route, never a disposition override.
  for (const suffix of ["?preview=1", "?inline=true", "?download=0", "?taskId=100", "?disposition=inline"])
    for (const session of [owner, other]) for (const route of ["", "/preview"])
      assert.equal((await f.request(`/attachments/${file.id}${route}${suffix}`, session)).status, 400);
  for (const session of [owner, other]) {
    for (const path of ["/uploads/task_attachments/fixture.txt", "/uploads/deal_attachments/fixture.txt"])
      assert.equal((await f.staticRequest(path, session)).status, 404);
  }
  for (const path of ["/uploads/task_attachments/fixture.txt", "/uploads/deal_attachments/fixture.txt"])
    assert.equal((await f.staticRequest(path)).status, 404);
  assert.equal((await f.request(`/attachments/${file.id}`, other, "GET", undefined, { accept: "text/html" })).status, 404);
  const own = await f.request(`/attachments/${file.id}`, owner, "GET", undefined, { accept: "text/html" });
  assert.equal(own.status, 200); assert.match(own.headers.get("content-disposition")!, /^attachment;/);
  assert.equal((await f.request(`/attachments/${file.id}`, owner, "GET", undefined, { origin: "https://outside.invalid" })).status, 403);
  assert.equal((await f.request(`/attachments/${file.id}/preview`, owner, "GET", undefined, { origin: "https://outside.invalid" })).status, 403);
  assert.equal((await f.request(`/attachments/${file.id}/preview`, owner, "GET", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
});

test("LOCAL ATTACHMENT HTTP stale versions, missing CSRF, invalid files and changed provenance never mutate attachments", async t => {
  const f = await fixture(t), owner = await f.login(1), file = await ownFile(f, owner), before = snapshot(f);
  assert.equal((await f.upload(owner, file.taskId, 1)).status, 409);
  assert.equal((await f.upload(owner, file.taskId, 2, "")).status, 403);
  assert.equal((await f.upload(owner, file.taskId, 2, owner.csrf, "unsafe.html", Buffer.from("<script>alert(1)</script>"), "text/html")).status, 415);
  assert.deepEqual(snapshot(f), before);
  // Corrupt only this disposable task; provenance must not be inferred from its
  // local row once remote identity or recorded creator disagrees with the journal.
  for (const [column, value] of [["assigned_to", "another-agent"], ["zoho_crm_id", "foreign"], ["owner_id", "another-agent"], ["quote_id", "foreign"], ["deal_crm_created_by", 2]] as const) {
    const old = f.db.prepare(`SELECT ${column} value FROM tasks WHERE id=?`).get(file.taskId) as { value: string | number | null };
    f.db.prepare(`UPDATE tasks SET ${column}=? WHERE id=?`).run(value, file.taskId); const corrupted = snapshot(f);
    assert.equal((await f.request(`/leads/${file.taskId}/attachments`, owner)).status, 404);
    assert.equal((await f.request(`/attachments/${file.id}`, owner)).status, 404);
    assert.equal((await f.request(`/attachments/${file.id}/preview`, owner)).status, 404);
    assert.equal((await f.upload(owner, file.taskId, 2)).status, 404); assert.deepEqual(snapshot(f), corrupted);
    f.db.prepare(`UPDATE tasks SET ${column}=? WHERE id=?`).run(old.value, file.taskId);
  }
  assert.deepEqual(snapshot(f), before);
  f.db.prepare("UPDATE task_attachment SET content_sha256=? WHERE id=?").run("0".repeat(64), file.id);
  const denied = await f.request(`/attachments/${file.id}`, owner); assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), { error: "Attachments are temporarily unavailable." });
  assert.equal((await f.request(`/attachments/${file.id}/preview`, owner)).status, 503);
});

test("LOCAL ATTACHMENT HTTP upload rechecks current grants and version after multipart preauthorization", async t => {
  const f = await fixture(t), owner = await f.login(1), task = await f.create(owner), before = snapshot(f);
  const authorize = f.runtime.services.attachments.authorizeUpload;
  f.runtime.services.attachments.authorizeUpload = async (...args) => {
    await authorize(...args);
    f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  };
  assert.equal((await f.upload(owner, task.taskId)).status, 404);
  assert.deepEqual(snapshot(f), before);
  assert.equal((await f.request(`/leads/${task.taskId}/attachments`, owner)).status, 404);
});

test("LOCAL ATTACHMENT HTTP upload rechecks a changed parent version after multipart preauthorization", async t => {
  const f = await fixture(t), owner = await f.login(1), task = await f.create(owner);
  const authorize = f.runtime.services.attachments.authorizeUpload;
  f.runtime.services.attachments.authorizeUpload = async (...args) => {
    await authorize(...args); f.db.prepare("UPDATE tasks SET version=version+1 WHERE id=?").run(task.taskId);
  };
  assert.equal((await f.upload(owner, task.taskId)).status, 409);
  assert.equal((f.db.prepare("SELECT version FROM tasks WHERE id=?").get(task.taskId) as { version: number }).version, 2);
  assert.deepEqual(f.db.prepare("SELECT * FROM task_attachment").all(), []);
  assert.deepEqual(f.db.prepare("SELECT * FROM crm_attachment_audit_events").all(), []);
});

test("LOCAL ATTACHMENT HTTP previously listed URLs recheck removed grants and disabled accounts", async t => {
  const f = await fixture(t), owner = await f.login(1), other = await f.login(2), own = await ownFile(f, owner), second = await ownFile(f, other);
  const before = snapshot(f);
  assert.equal((await f.request(`/leads/${own.taskId}/attachments`, owner)).status, 200);
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  assert.equal((await f.request(`/leads/${own.taskId}/attachments`, owner)).status, 404);
  assert.equal((await f.request(`/attachments/${own.id}`, owner)).status, 404);
  assert.equal((await f.request(`/attachments/${own.id}/preview`, owner)).status, 404);
  assert.equal((await f.request(`/attachments/${own.id}/preview`, owner, "HEAD")).status, 404);
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=2").run();
  assert.equal((await f.request(`/leads/${second.taskId}/attachments`, other)).status, 401);
  assert.equal((await f.request(`/attachments/${second.id}`, other)).status, 401);
  assert.equal((await f.request(`/attachments/${second.id}/preview`, other)).status, 401);
  f.db.prepare("UPDATE users SET status='active' WHERE id=2").run();
  assert.equal((await f.request(`/attachments/${second.id}`, other)).status, 401); // Old session cannot revive.
  assert.equal((await f.request(`/attachments/${second.id}/preview`, other)).status, 401);
  assert.deepEqual(snapshot(f), before);
});

test("LOCAL ATTACHMENT HTTP audit failure rolls back bytes and version without a fallback write", async t => {
  const f = await fixture(t), owner = await f.login(1), task = await f.create(owner), before = snapshot(f);
  f.db.exec("CREATE TRIGGER synthetic_attachment_audit_fail BEFORE INSERT ON crm_attachment_audit_events BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END");
  const response = await f.upload(owner, task.taskId); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Attachments are temporarily unavailable." });
  assert.deepEqual(snapshot(f), before); assert.deepEqual(f.db.pragma("foreign_key_check"), []);
});

test("LOCAL ATTACHMENT HTTP authorized preview revalidates static images and renders CSV or markup as inert UTF-8 text", async t => {
  const f = await fixture(t), owner = await f.login(1);
  for (const [name, type, content, responseType] of [
    ["fixture.gif", "image/gif", syntheticGif(), "image/gif"],
    ["fixture.csv", "text/csv", Buffer.from("name,value\nsynthetic,7\n"), "text/plain; charset=utf-8"],
    ["fixture.txt", "text/plain", Buffer.from("<script>window.privateFileExecuted=true</script>"), "text/plain; charset=utf-8"],
  ] as const) {
    const task = await f.create(owner), upload = await f.upload(owner, task.taskId, 1, owner.csrf, name, content, type);
    assert.equal(upload.status, 200); const file = await upload.json() as { id: string }, before = snapshot(f);
    const preview = await f.request(`/attachments/${file.id}/preview`, owner); assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), responseType); assert.match(preview.headers.get("content-disposition")!, /^inline;/);
    assert.equal(preview.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), content); assert.deepEqual(snapshot(f), before);
  }
});

test("LOCAL ATTACHMENT HTTP PDF preview is explicitly refused after authorization while exact original download remains intact", async t => {
  const f = await fixture(t), owner = await f.login(1), other = await f.login(2), task = await f.create(owner), content = syntheticActionPdf(undefined, "A", "/a null");
  const upload = await f.upload(owner, task.taskId, 1, owner.csrf, "fixture.pdf", content, "application/pdf"); assert.equal(upload.status, 200);
  const file = await upload.json() as { id: string }, before = snapshot(f);
  const blocked = await f.request(`/attachments/${file.id}/preview`, owner); assert.equal(blocked.status, 415);
  assert.deepEqual(await blocked.json(), { error: "Inline preview supports static images and text files only. Use Download for this file." });
  const hidden = await f.request(`/attachments/${file.id}/preview`, other); assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "Attachment or record not found." });
  const download = await f.request(`/attachments/${file.id}`, owner); assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content); assert.match(download.headers.get("content-disposition")!, /^attachment;/);
  assert.deepEqual(snapshot(f), before);
});

test("LOCAL ATTACHMENT HTTP direct HEAD preview checks scope, and metadata or byte corruption never becomes inline content", async t => {
  const f = await fixture(t), owner = await f.login(1), other = await f.login(2), file = await ownFile(f, owner), before = snapshot(f);
  for (const route of ["", "/preview"]) for (const [session, status] of [[owner, 200], [other, 404], [undefined, 401]] as const) {
    const reply = await f.request(`/attachments/${file.id}${route}`, session, "HEAD"); assert.equal(reply.status, status);
    assert.equal(await reply.text(), "");
    if (status !== 200) assert.equal(reply.headers.has("content-disposition"), false);
  }
  assert.deepEqual(snapshot(f), before);
  f.db.prepare("UPDATE task_attachment SET file_name='fixture.png',media_type='image/png' WHERE id=?").run(file.id);
  const invalid = await f.request(`/attachments/${file.id}/preview`, owner); assert.equal(invalid.status, 415);
  assert.equal(invalid.headers.has("content-disposition"), false);
  assert.notDeepEqual(Buffer.from(await invalid.arrayBuffer()), bytes);
});

test("LOCAL ATTACHMENT HTTP restrictive lead access cannot cross into department log file URLs", async t => {
  const f = await fixture(t), { manager, worker, content, id: fileId } = await ownLog(f), agent = await f.login(1), before = logSnapshot(f);
  for (const session of [worker, manager]) for (const suffix of ["", "/preview"]) for (const method of ["GET", "HEAD"]) {
    const reply = await f.request(`/log-attachments/${fileId}${suffix}`, session, method); assert.equal(reply.status, 200);
    assert.deepEqual(Buffer.from(await reply.arrayBuffer()), method === "HEAD" ? Buffer.alloc(0) : content);
    assert.match(reply.headers.get("content-disposition")!, suffix ? /^inline;/ : /^attachment;/);
    assert.equal(reply.headers.get("cache-control"), "private, no-store"); assert.equal(reply.headers.get("vary"), "Cookie");
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff"); assert.equal(reply.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  }
  for (const [session, status] of [[agent, 404], [undefined, 401]] as const) for (const method of ["GET", "HEAD"]) for (const suffix of ["", "/preview"]) {
    const reply = await f.request(`/log-attachments/${fileId}${suffix}`, session, method); assert.equal(reply.status, status);
    assert.equal(reply.headers.has("content-disposition"), false);
  }
  for (const query of ["?preview=1", "?inline=1", "?department=Civil", "?taskId=100"]) for (const suffix of ["", "/preview"])
    assert.equal((await f.request(`/log-attachments/${fileId}${suffix}${query}`, worker)).status, 400);
  for (const headers of [{ origin: "https://outside.invalid" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[])
    assert.equal((await f.request(`/log-attachments/${fileId}/preview`, worker, "GET", undefined, headers)).status, 403);
  // The task attachment preview route cannot be repurposed for a log BLOB UUID.
  assert.equal((await f.request(`/attachments/${fileId}/preview`, agent)).status, 404);
  assert.equal((await f.request(`/attachments/${fileId}/preview`, worker)).status, 404);
  assert.deepEqual(logSnapshot(f), before);
});

test("LOCAL LOG PREVIEW HTTP rereads current department/manager grants and latest assignment on every GET and HEAD", async t => {
  const f = await fixture(t), log = await ownLog(f), before = logSnapshot(f), path = `/log-attachments/${log.id}/preview`;
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=7").run();
  for (const method of ["GET", "HEAD"]) assert.equal((await f.request(path, log.worker, method)).status, 404);
  assert.equal((await f.request(path, log.manager)).status, 200);
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=6").run();
  assert.equal((await f.request(path, log.manager)).status, 404); assert.deepEqual(logSnapshot(f), before);
  const g = await fixture(t), second = await ownLog(g);
  assert.equal((await g.request("/jobs/103/unassign", second.manager, "POST", { expectedVersion: second.version, department: "Electrical" })).status, 200);
  for (const method of ["GET", "HEAD"]) assert.equal((await g.request(`/log-attachments/${second.id}/preview`, second.worker, method)).status, 404);
  assert.equal((await g.request(`/log-attachments/${second.id}/preview`, second.manager)).status, 200);
});

test("LOCAL LOG PREVIEW HTTP forged, expired, logged-out and disabled sessions cannot retain file access", async t => {
  const f = await fixture(t), log = await ownLog(f), path = `/log-attachments/${log.id}/preview`, before = logSnapshot(f);
  assert.equal((await f.request(path, { cookie: "crm_session=forged", csrf: "forged" })).status, 401);
  assert.equal((await f.request("/auth/logout", log.worker, "POST")).status, 200);
  assert.equal((await f.request(path, log.worker)).status, 401);
  const fresh = await f.login(7); f.db.prepare("UPDATE crm_sessions SET created_at=0,expires_at=1 WHERE user_id=7").run();
  assert.equal((await f.request(path, fresh)).status, 401);
  const active = await f.login(7); f.db.prepare("UPDATE users SET status='inactive' WHERE id=7").run();
  for (const method of ["GET", "HEAD"]) assert.equal((await f.request(path, active, method)).status, 401);
  f.db.prepare("UPDATE users SET status='active' WHERE id=7").run(); assert.equal((await f.request(path, active)).status, 401);
  assert.deepEqual(logSnapshot(f), before);
});

test("LOCAL LOG PREVIEW HTTP PDF refusal preserves downloads and supported department CSV renders inert text", async t => {
  const f = await fixture(t), content = syntheticActionPdf(undefined, "A", "/a null"), log = await ownLog(f, "Electrical", { name: "fixture.pdf", type: "application/pdf", content });
  const before = logSnapshot(f), denied = await f.request(`/log-attachments/${log.id}/preview`, log.worker);
  assert.equal(denied.status, 415); assert.deepEqual(await denied.json(), { error: "Inline preview supports static images and text files only. Use Download for this file." });
  const file = await f.request(`/log-attachments/${log.id}`, log.worker); assert.equal(file.status, 200); assert.deepEqual(Buffer.from(await file.arrayBuffer()), content);
  assert.deepEqual(logSnapshot(f), before);
  for (const department of ["Switchgear", "Maintenance"] as const) {
    const g = await fixture(t, department), csv = Buffer.from("label,value\n<script>inert</script>,7\n"), saved = await ownLog(g, department, { name: "fixture.csv", type: "text/csv", content: csv });
    const preview = await g.request(`/log-attachments/${saved.id}/preview`, saved.worker); assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "text/plain; charset=utf-8"); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), csv);
  }
});

test("LOCAL LOG PREVIEW HTTP corrupt digest and unsupported stored content fail closed", async t => {
  const f = await fixture(t), log = await ownLog(f), path = `/log-attachments/${log.id}/preview`;
  // Isolated storage-corruption probes only; no trigger or BLOB in the demo is touched.
  f.db.exec("DROP TRIGGER crm_log_attachment_no_update");
  f.db.prepare("UPDATE crm_department_log_attachments SET content_sha256=? WHERE id=?").run("0".repeat(64), log.id);
  for (const session of [log.manager, log.worker]) {
    const response = await f.request(path, session); assert.equal(response.status, 503); assert.equal(response.headers.has("content-disposition"), false);
  }
  f.db.prepare("UPDATE crm_department_log_attachments SET content_sha256=?,file_name='fixture.png',media_type='image/png' WHERE id=?")
    .run(createHash("sha256").update(log.content).digest("hex"), log.id);
  const invalid = await f.request(path, log.worker); assert.equal(invalid.status, 415); assert.equal(invalid.headers.has("content-disposition"), false);
  f.db.prepare("UPDATE crm_department_log_attachments SET file_name='fixture.txt',media_type='text/plain' WHERE id=?").run(log.id);
  assert.equal((await f.request(path, log.worker)).status, 415);
});
