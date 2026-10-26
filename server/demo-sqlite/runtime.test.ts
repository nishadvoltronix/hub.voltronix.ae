import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { hashSync } from "bcryptjs";
import { strFromU8, unzipSync } from "fflate";
import type { CentralJobPage, CreatedDealsPage } from "@voltronix/crm-contracts";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { calculateQuotation, parseQuotationInput } from "../../tests/sqlite-reference/commercial/quotations.js";
import { JobsError } from "../../tests/sqlite-reference/jobs/service.js";
import { createApp } from "../src/app.js";
import { authFailure } from "../src/auth/errors.js";
import { createHttpLifecycle } from "../src/server.js";
import { createSqliteAuthStore, createSqliteExecutor } from "./auth-store.js";
import { createSqliteDemoRuntime } from "./runtime.js";
import { sqliteDomainError } from "./services.js";
import { JOB_EXPORT_COLUMNS, MAX_EXPORT_ROWS } from "../src/crm/exports/xlsx.js";

const requireNext = createRequire(new URL("../../package.json", import.meta.url));
const Database = requireNext("better-sqlite3") as new (filename: string) => SqliteDatabase;
const password = "Synthetic SQLite HTTP test password", passwordHash = hashSync(password, 4);
const origin = "http://127.0.0.1:3001";
function database(filename = ":memory:") {
  const db = new Database(filename); configureDatabase(db);
  assert.equal(migrateDatabase(db), 10); assert.equal(migrateDatabase(db), 0);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  return db;
}
function seed(db: SqliteDatabase) {
  for (const id of [1, 2]) db.prepare("INSERT INTO users(id,user_id,username,email,password,status,role) VALUES(?,?,?,?,?,'active','synthetic-demo')")
    .run(id, `external-${id}`, `Synthetic SQLite user ${id}`, `sqlite-${id}@example.invalid`, passwordHash);
  for (const permission of ["dashboard.view", "leads.view", "users.write", "permissions.manage", "items.view", "electrical.manage"]) {
    const record = db.prepare('INSERT INTO permissions("key",label) VALUES(?,?)').run(permission, permission);
    db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(1,?)").run(record.lastInsertRowid);
  }
  db.prepare("UPDATE users SET department_role='Electrical' WHERE id=1").run();
  db.prepare("INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status,Job_Status,account_name,job_deal_number,service_charge) VALUES(1,'synthetic-1','external-1','Synthetic SQLite job','Closed Won','Active','Synthetic account','DEMO-1','125.50')").run();
}
function grant(db: SqliteDatabase, id: number, key: string) {
  db.prepare('INSERT OR IGNORE INTO permissions("key",label) VALUES(?,?)').run(key, key);
  db.prepare('INSERT OR IGNORE INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
}
function localWrites(db: SqliteDatabase, id = 1) {
  for (const key of ["items.write", "leads.manage", "leads.view"]) grant(db, id, key);
}
function fixture(t: TestContext, filename = ":memory:") {
  const db = database(filename); seed(db); const runtime = createSqliteDemoRuntime(db);
  t.after(() => runtime.close()); return { db, runtime };
}
function cookies(response: Response, previous = "") {
  const result = new Map<string, string>();
  for (const cookie of [...previous.split("; "), ...response.headers.getSetCookie().map(value => value.split(";")[0]!)]) {
    const split = cookie.indexOf("="); if (split > 0) result.set(cookie.slice(0, split), cookie.slice(split + 1));
  }
  return [...result].map(([name, value]) => `${name}=${value}`).join("; ");
}
interface Session { cookie: string; csrf: string }
function workbookRows(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes), xml = strFromU8(files["xl/worksheets/sheet1.xml"]!);
  assert.doesNotMatch(xml, /<f(?:>|\s)|<hyperlink/);
  assert.equal(Object.keys(files).some(name => name.includes("externalLinks")), false);
  const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&amp;/g, "&");
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row =>
    [...row[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(cell => decode(cell[1]!)));
}
async function http(t: TestContext) {
  const f = fixture(t), app = createApp({ environment: "test", host: "127.0.0.1", port: 3002, appOrigin: origin },
    { auth: f.runtime.auth, crmServices: f.runtime.services });
  const server = createServer(app), lifecycle = createHttpLifecycle(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => lifecycle.stop());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const request = (path: string, method = "GET", session?: Session, body?: unknown, extra: Record<string, string> = {}) => fetch(base + path, {
    method, redirect: "error", headers: { origin, ...(session ? { cookie: session.cookie, "x-csrf-token": session.csrf } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async (id = 1, previous?: Session): Promise<Session> => {
    const challenge = await request("/auth/csrf", "GET", previous); assert.equal(challenge.status, 200);
    const csrf = (await challenge.json() as { csrfToken: string }).csrfToken;
    const response = await request("/auth/login", "POST", { cookie: cookies(challenge, previous?.cookie), csrf },
      { email: `sqlite-${id}@example.invalid`, password });
    assert.equal(response.status, 200);
    return { cookie: cookies(response), csrf: (await response.json() as { csrfToken: string }).csrfToken };
  };
  return { ...f, base, request, login };
}

test("REAL SQLITE source job metadata remains exact behind manager and current-assignee boundaries", async t => {
  const f = await http(t);
  grant(f.db, 2, "electrical.manage");
  const source = { complaintDescription: "Saved <script>description</script>\nSecond line", createdAt: "2026-10-11T20:00:00Z", qualificationNumber: "QUAL-SOURCE", quotationNumber: "QUOTE-STAGE", enquiryDate: "2026-10-01", quotationDate: "2026-10-02", customerEmail: "source@example.invalid", customerContact: "+971 source" };
  f.db.prepare("UPDATE tasks SET complaint_info=?,created_at=?,qual_deal_number=?,quote_deal_number=?,enq_deal_date=?,quote_deal_date=?,customer_email=?,customer_contact=? WHERE id=1").run(...Object.values(source));
  f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(1,1,'Electrical','Assigned')").run();
  const owner = await f.login(), other = await f.login(2);
  const before = f.db.prepare("SELECT * FROM tasks").all();
  const beforeAssignments = f.db.prepare("SELECT * FROM departments_assign").all();
  const beforeAudit = f.db.prepare("SELECT * FROM crm_department_audit_events").all();
  const beforeSessions = f.db.prepare("SELECT * FROM crm_sessions").all();
  for (const path of ["/jobs/1", "/departments/Electrical/jobs/1"]) {
    const response = await f.request(path, "GET", owner); assert.equal(response.status, 200);
    const job = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.fromEntries(Object.keys(source).map(key => [key, job[key]])), source);
    assert.equal((await f.request(path)).status, 401);
  }
  assert.equal((await f.request("/jobs/1", "GET", other)).status, 403);
  const foreign = await f.request("/departments/Electrical/jobs/1", "GET", other);
  assert.equal(foreign.status, 404); assert.doesNotMatch(await foreign.text(), /source@example|QUAL-SOURCE|Saved/);
  assert.equal((await f.request("/departments/Civil/jobs/1", "GET", owner)).status, 403);
  assert.deepEqual(f.db.prepare("SELECT * FROM tasks").all(), before);
  assert.deepEqual(f.db.prepare("SELECT * FROM departments_assign").all(), beforeAssignments);
  assert.deepEqual(f.db.prepare("SELECT * FROM crm_department_audit_events").all(), beforeAudit);
  assert.deepEqual(f.db.prepare("SELECT * FROM crm_sessions").all(), beforeSessions);
});

test("REAL SQLITE runtime requires explicit current schema and never seeds a user", async () => {
  const empty = new Database(":memory:"); configureDatabase(empty);
  try { assert.throws(() => createSqliteDemoRuntime(empty)); } finally { empty.close(); }
  const db = database();
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS total FROM users").get(), { total: 0 });
  const runtime = createSqliteDemoRuntime(db); await runtime.close(); await runtime.close();
  assert.equal(db.open, false); await assert.rejects(runtime.auth.authenticate("a".repeat(43)));
});
test("REAL SQLITE async auth transactions serialize, roll back, reject escapes and forbid nested work", async () => {
  const db = database(), executor = createSqliteExecutor(db), store = createSqliteAuthStore(db, executor);
  const bucket = `account:${"a".repeat(64)}`; let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const rejected = store.transaction(async tx => { await tx.incrementAttempt(bucket, 1); entered(); await gate; throw new Error("synthetic failure"); });
    await ready; let secondRan = false;
    const second = executor.run(() => { secondRan = true; assert.equal(db.inTransaction, false); });
    await Promise.resolve(); assert.equal(secondRan, false); release(); await assert.rejects(rejected); await second;
    assert.equal(db.prepare("SELECT 1 FROM crm_login_attempts").get(), undefined);
    let escaped: Parameters<Parameters<typeof store.transaction>[0]>[0] | undefined;
    await store.transaction(async tx => { escaped = tx; });
    await assert.rejects(escaped!.incrementAttempt(bucket, 1));
    await assert.rejects(store.transaction(async tx => {
      await tx.incrementAttempt(bucket, 1);
      await assert.rejects(store.transaction(async () => undefined));
    }));
    assert.equal(db.prepare("SELECT 1 FROM crm_login_attempts").get(), undefined);
  } finally { await executor.close(); }
});
test("REAL SQLITE backend auth rotates sessions atomically, refreshes grants and retains throttle limits", async t => {
  const { db, runtime } = fixture(t);
  const first = await runtime.auth.login("SQLITE-1@example.invalid", password);
  const second = await runtime.auth.login("sqlite-1@example.invalid", password, first.sessionToken);
  assert.equal(await runtime.auth.authenticate(first.sessionToken), null);
  assert.equal(await runtime.auth.verifySessionCsrf(second.sessionToken, second.csrfToken), true);
  assert.equal(await runtime.auth.verifySessionCsrf(second.sessionToken, first.csrfToken), false);
  db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  assert.deepEqual((await runtime.auth.authenticate(second.sessionToken))?.permissions, []);
  await runtime.auth.logout(second.sessionToken); assert.equal(await runtime.auth.authenticate(second.sessionToken), null);
  const parallel = await Promise.allSettled(Array.from({ length: 4 }, () => runtime.auth.login("sqlite-1@example.invalid", password)));
  assert.equal(parallel.filter(value => value.status === "fulfilled").length, 3);
  const failure = parallel.find(value => value.status === "rejected");
  assert.ok(failure?.status === "rejected"); assert.equal(authFailure(failure.reason).status, 429);
  const rows = db.prepare("SELECT token_hash,csrf_hash FROM crm_sessions").all() as Array<{ token_hash: string; csrf_hash: string }>;
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.token_hash) && /^[a-f0-9]{64}$/.test(row.csrf_hash)));
});
test("REAL SQLITE Express enforces login, permissions, CSRF/origin, rotation and logout", async t => {
  const f = await http(t);
  assert.equal((await f.request("/health/live")).status, 200);
  assert.equal((await f.request("/jobs")).status, 401);
  const session = await f.login(), deniedSession = await f.login(2);
  assert.equal((await f.request("/jobs", "GET", deniedSession)).status, 403);
  assert.equal((await f.request("/jobs/1/remarks", "PATCH", session, { expectedVersion: 1, remarks: "denied" }, { origin: "http://unapproved.invalid" })).status, 403);
  assert.equal((await f.request("/jobs/1/remarks", "PATCH", session, { expectedVersion: 1, remarks: "denied" }, { "x-csrf-token": "" })).status, 403);
  const rotated = await f.login(1, session);
  assert.equal((await f.request("/auth/me", "GET", session)).status, 401);
  assert.equal((await f.request("/auth/me", "GET", rotated)).status, 200);
  assert.equal((await f.request("/auth/logout", "POST", rotated)).status, 200);
  assert.equal((await f.request("/auth/me", "GET", rotated)).status, 401);
});
test("REAL SQLITE Express CRUD persists versions, concurrent conflicts and settings audit", async t => {
  const f = await http(t), session = await f.login();
  const input = { expectedVersion: 1, remarks: "Synthetic HTTP persistence" };
  const competing = await Promise.all([f.request("/jobs/1/remarks", "PATCH", session, input), f.request("/jobs/1/remarks", "PATCH", session, input)]);
  assert.deepEqual(competing.map(response => response.status).sort(), [200, 409]);
  assert.equal((await f.request("/jobs/1", "GET", session).then(response => response.json()) as { remarks: string }).remarks, input.remarks);
  const created = await f.request("/settings/users", "POST", session,
    { name: "Synthetic created user", email: "created@example.invalid", password, status: "active" });
  assert.equal(created.status, 201); const user = await created.json() as { id: string; version: number };
  assert.equal((await f.request(`/settings/users/${user.id}`, "PATCH", session,
    { name: "Synthetic changed user", email: "created@example.invalid", status: "active", version: user.version })).status, 200);
  assert.equal((await f.request(`/settings/users/${user.id}`, "GET", session)).status, 200);
  const audits = f.db.prepare("SELECT action FROM crm_audit_events ORDER BY id").all();
  assert.deepEqual(audits, [{ action: "users.create" }, { action: "users.update" }]);
  assert.equal((await f.request("/settings/users", "POST", session, { ignored: true })).status, 400);
});
test("REAL SQLITE Express multipart files preserve exact bytes and deny unsafe or unauthorized content", async t => {
  const f = await http(t), session = await f.login(), deniedSession = await f.login(2);
  const upload = async (name: string, version: number) => {
    const form = new FormData(); form.set("expectedVersion", String(version)); form.set("file", new Blob(["Synthetic private bytes"], { type: "text/plain" }), name);
    return fetch(f.base + "/leads/1/attachments", { method: "POST", body: form, redirect: "error",
      headers: { origin, cookie: session.cookie, "x-csrf-token": session.csrf } });
  };
  assert.equal((await upload("unsafe.php", 1)).status, 415);
  const accepted = await upload("synthetic.txt", 1); assert.equal(accepted.status, 200);
  const saved = await accepted.json() as { id: string; version: number }; assert.equal(saved.version, 2);
  const downloaded = await f.request(`/attachments/${saved.id}`, "GET", session);
  assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), "Synthetic private bytes");
  assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
  assert.equal((await f.request(`/attachments/${saved.id}`, "GET", deniedSession)).status, 404);
  assert.deepEqual(f.db.prepare("SELECT COUNT(*) AS total FROM crm_attachment_audit_events").get(), { total: 1 });
});
test("REAL SQLITE assignments, work logs, reports and exports execute through existing services", async t => {
  const { runtime } = fixture(t), session = await runtime.auth.login("sqlite-1@example.invalid", password), token = session.sessionToken;
  const assigned = await runtime.services.departments.assign(token, "1", { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "1" }] });
  assert.ok(assigned);
  const job = await runtime.services.departments.getJob(token, "Electrical", "1");
  await runtime.services.departments.addLog(token, "Electrical", "1", { expectedVersion: job.version, authority: "DESIGN", status: "DRAWING PREPARATION", notes: "Synthetic work log" });
  assert.equal((await runtime.services.departments.listLogs(token, "Electrical", "1")).items.length, 1);
  assert.equal((await runtime.services.reports.employeePerformance(token)).timeZone, "Asia/Dubai");
  const workbook = await runtime.services.exports.exportJobs(token); assert.equal(workbook.rowCount, 1);
  assert.equal(Buffer.from(workbook.bytes.subarray(0, 2)).toString(), "PK");
  const capability = await runtime.services.mutations.capabilities(token, "1"); assert.equal(capability.integrationAvailable, false);
});
test("REAL SQLITE both quotation templates render private PDFs through Express with live authorization", async t => {
  const f = await http(t), session = await f.login(), deniedSession = await f.login(2);
  const timestamp = new Date().toISOString();
  f.db.prepare("INSERT INTO products(product_id,product_name,description,unit_price,created_at,updated_at) VALUES('9001','Synthetic panel','Synthetic panel','100.10',?,?)").run(timestamp, timestamp);
  const quotation = parseQuotationInput({ subject: "Synthetic SQLite quotation", kindAttention: "Synthetic contact", discount: "0", adjustment: "0",
    notes: "Synthetic fixture only", items: [{ productId: "9001", productName: "Synthetic panel", description: "Synthetic panel", quantity: "2.5", unitPrice: "100.10", itemDiscount: "0", uom: "NOS" }] });
  const totals = calculateQuotation(quotation, "percentage"), { items, ...header } = quotation, item = items[0]!;
  for (const [offset, company] of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"].entries()) {
    const id = offset + 3, external = `900${id}`, quoteNumber = `SYNTHETIC-${id}`;
    f.db.prepare("INSERT INTO users(id,user_id,username,email,password,status,company,sale_name) VALUES(?,?,?,?,?,'active',?,'Synthetic salesperson')")
      .run(id, external, `Synthetic quotation owner ${id}`, `quote-${id}@example.invalid`, passwordHash, company);
    f.db.prepare("INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status,account_name,quote_id,quote_number,quote_deal_number) VALUES(?,?,?,'Synthetic quotation','Proposal/Price Quote','Synthetic customer',?,?,?)")
      .run(id, `9900${id}`, external, `8800${id}`, quoteNumber, quoteNumber);
    const saved = f.db.prepare("INSERT INTO crm_quotations(task_id,external_id,quote_number,header_json,totals_json,calculation_policy,remote_modified_at,created_at,updated_at) VALUES(?,?,?,?,?,'percentage-create-v1',?,?,?)")
      .run(id, `8800${id}`, quoteNumber, JSON.stringify(header), JSON.stringify(totals), timestamp, timestamp, timestamp);
    f.db.prepare("INSERT INTO proposal_items(quotation_id,task_id,position,product_id,product_name,product_description,uom,quantity,service_charge,item_discount,total) VALUES(?,?,0,?,?,?,?,?,?,?,?)")
      .run(saved.lastInsertRowid, id, item.productId, item.productName, item.description, item.uom, item.quantity, item.unitPrice, item.itemDiscount, totals.lineTotals[0]);
    const response = await f.request(`/quotations/${id}/pdf`, "GET", session);
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 8).toString(), "%PDF-1.7");
    assert.equal((await f.request(`/quotations/${id}/pdf`, "GET", deniedSession)).status, 404);
  }
});
test("REAL SQLITE file-backed records and sessions survive runtime close and reopen", async () => {
  const parent = resolve(tmpdir()), directory = mkdtempSync(join(parent, "voltronix-sqlite-runtime-"));
  const filename = join(directory, `${randomUUID()}.sqlite`); let runtime: ReturnType<typeof createSqliteDemoRuntime> | undefined;
  try {
    const db = database(filename); seed(db); runtime = createSqliteDemoRuntime(db);
    const session = await runtime.auth.login("sqlite-1@example.invalid", password);
    await runtime.services.jobs.updateRemarks(session.sessionToken, "1", { expectedVersion: 1, remarks: "Persisted across restart" });
    await runtime.close();
    const reopened = new Database(filename); configureDatabase(reopened); runtime = createSqliteDemoRuntime(reopened);
    assert.equal((await runtime.auth.authenticate(session.sessionToken))?.localUserId, "1");
    assert.equal((await runtime.services.jobs.getJob(session.sessionToken, "1")).remarks, "Persisted across restart");
    assert.deepEqual(reopened.pragma("foreign_key_check"), []);
  } finally {
    await runtime?.close();
    const selected = resolve(directory);
    assert.ok(selected.startsWith(parent + sep) && basename(selected).startsWith("voltronix-sqlite-runtime-"));
    rmSync(selected, { recursive: true, force: true });
  }
});
test("SQLite domain adapter accepts reviewed errors and redacts arbitrary driver failures", () => {
  assert.equal(sqliteDomainError(new JobsError(400)).status, 400);
  const safe = sqliteDomainError(Object.assign(new Error("synthetic private driver detail"), { status: 400 }));
  assert.equal(safe.status, 503); assert.equal(safe.message.includes("private"), false);
});

test("LOCAL SQLITE capabilities and product HTTP writes honor current grants and exact product readers", async t => {
  const f = await http(t), session = await f.login(), denied = await f.login(2);
  assert.equal((await f.request("/capabilities")).status, 401);
  assert.deepEqual(await f.request("/capabilities", "GET", session).then(r => r.json()),
    { persistence: "local-demo", productCreate: false, leadNotes: false, integrationAvailable: false, jobCohorts: true });
  localWrites(f.db);
  assert.deepEqual(await f.request("/capabilities", "GET", session).then(r => r.json()),
    { persistence: "local-demo", productCreate: true, leadNotes: true, integrationAvailable: false, jobCohorts: true });
  const input = { operationId: randomUUID(), name: "  Synthetic local product  ", description: "Locally persisted description" };
  assert.equal((await f.request("/items", "POST", denied, input)).status, 403);
  assert.equal((await f.request("/items", "POST", session, input, { "x-csrf-token": "" })).status, 403);
  assert.equal((await f.request("/items", "POST", session, input, { origin: "https://other.invalid" })).status, 403);
  assert.equal((await f.request("/items", "POST", session, { ...input, unexpected: true })).status, 400);
  const created = await f.request("/items", "POST", session, input); assert.equal(created.status, 200);
  const result = await created.json() as { operationId: string; productId: string; version: number; persistence: string };
  assert.match(result.productId, /^9[0-9]{39}$/); assert.equal(result.persistence, "local-demo");
  const product = await f.request(`/items/${result.productId}`, "GET", session).then(r => r.json()) as { name: string; unitPrice: null; externalId: string };
  assert.equal(product.name, "Synthetic local product"); assert.equal(product.unitPrice, null); assert.equal(product.externalId, result.productId);
  const list = await f.request("/items?query=local%20product", "GET", session).then(r => r.json()) as { items: { id: string }[]; total: number };
  assert.equal(list.total, 1); assert.equal(list.items[0]?.id, result.productId);
  const quote = parseQuotationInput({ subject: "Synthetic local preview", kindAttention: "Synthetic contact", discount: "0", adjustment: "0",
    items: [{ productId: result.productId, productName: product.name, description: "", uom: "NOS", quantity: "2.5", unitPrice: "100.10", itemDiscount: "0" }] });
  assert.equal(calculateQuotation(quote, "percentage").grandTotal, "262.76");
  assert.deepEqual(await f.request("/items", "POST", session, input).then(r => r.json()), result);
  assert.equal((await f.request("/items", "POST", session, { ...input, name: "Different payload" })).status, 409);
  const next = await f.request("/items", "POST", session, { ...input, operationId: randomUUID() }).then(r => r.json()) as { productId: string };
  assert.notEqual(next.productId, result.productId);
  const journals = f.db.prepare("SELECT state,remote_effect_possible,remote_references,result_json FROM crm_commercial_operations").all() as { state: string; remote_effect_possible: number; remote_references: string; result_json: string }[];
  assert.equal(journals.length, 2);
  assert.ok(journals.every(row => row.state === "completed" && row.remote_effect_possible === 0 && row.remote_references === "{}" && JSON.parse(row.result_json).persistence === "local-demo"));
  f.db.prepare('DELETE FROM admin_user_permissions WHERE admin_user_id=1 AND permission_id=(SELECT id FROM permissions WHERE "key"=\'items.write\')').run();
  assert.equal((await f.request("/items", "POST", session, input)).status, 403);
  assert.equal((await f.request("/capabilities", "GET", session).then(r => r.json()) as { productCreate: boolean }).productCreate, false);
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=1").run();
  assert.equal((await f.request("/capabilities", "GET", session)).status, 401);
});

test("LOCAL SQLITE notes create edit replay and parent isolation preserve remote identity and CAS", async t => {
  const f = await http(t), session = await f.login(); localWrites(f.db);
  f.db.prepare("INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status) VALUES(2,'synthetic-2','external-2','Synthetic other lead','Pending')").run();
  const input = { operationId: randomUUID(), expectedVersion: 1, title: " Local note ", content: " Local content " };
  assert.equal((await f.request("/leads/1/notes", "POST", session, { ...input, ignored: true })).status, 400);
  assert.equal((await f.request("/leads/1/notes", "POST", session, input, { "x-csrf-token": "" })).status, 403);
  const created = await f.request("/leads/1/notes", "POST", session, input); assert.equal(created.status, 200);
  const result = await created.json() as { noteId: string; version: number; persistence: string };
  assert.equal(result.version, 2); assert.equal(result.persistence, "local-demo");
  assert.deepEqual(f.db.prepare("SELECT note_title,note_content,zoho_note_id FROM job_notes WHERE id=?").get(result.noteId),
    { note_title: "Local note", note_content: "Local content", zoho_note_id: null });
  assert.deepEqual(await f.request("/leads/1/notes", "POST", session, input).then(r => r.json()), result);
  assert.equal((await f.request("/leads/1/notes", "POST", session, { ...input, content: "Conflicting content" })).status, 409);
  assert.equal((await f.request("/leads/1/notes", "POST", session, { ...input, operationId: randomUUID() })).status, 409);
  const edit = { operationId: randomUUID(), expectedVersion: 2, content: "Edited locally" };
  assert.equal((await f.request(`/leads/2/notes/${result.noteId}`, "PATCH", session, edit)).status, 404);
  assert.equal((await f.request("/leads/invalid/notes", "POST", session, input)).status, 404);
  f.db.prepare("UPDATE job_notes SET zoho_note_id='existing-synthetic-reference' WHERE id=?").run(result.noteId);
  const updated = await f.request(`/leads/1/notes/${result.noteId}`, "PATCH", session, edit); assert.equal(updated.status, 200);
  assert.equal((await updated.json() as { version: number }).version, 3);
  assert.deepEqual(f.db.prepare("SELECT note_title,note_content,zoho_note_id FROM job_notes WHERE id=?").get(result.noteId),
    { note_title: "Local note", note_content: "Edited locally", zoho_note_id: "existing-synthetic-reference" });
  assert.equal((await f.request("/leads/1/notes", "GET", session).then(r => r.json()) as { total: number }).total, 1);
  assert.equal((await f.request("/items", "POST", session, { operationId: input.operationId, name: "Cross-kind collision", description: "" })).status, 409);
  const journal = f.db.prepare("SELECT state,remote_effect_possible,remote_id,remote_references FROM crm_lead_operations WHERE operation_id=?").get(edit.operationId);
  assert.deepEqual(journal, { state: "completed", remote_effect_possible: 0, remote_id: null, remote_references: "{}" });
  localWrites(f.db, 2); grant(f.db, 2, "leads.manage.agents"); const other = await f.login(2);
  assert.equal((await f.request("/leads/1/notes", "POST", other, { ...input, operationId: randomUUID(), expectedVersion: 3 })).status, 404);
  f.db.prepare('DELETE FROM admin_user_permissions WHERE admin_user_id=1 AND permission_id=(SELECT id FROM permissions WHERE "key"=\'leads.manage\')').run();
  assert.equal((await f.request(`/leads/1/notes/${result.noteId}`, "PATCH", session, edit)).status, 403);
});

test("LOCAL SQLITE concurrent note writes and unfinished remote operations refuse conflicts", async t => {
  const f = await http(t), session = await f.login(); localWrites(f.db);
  const requests = [1, 2].map(index => f.request("/leads/1/notes", "POST", session,
    { operationId: randomUUID(), expectedVersion: 1, title: `Competing note ${index}`, content: "Synthetic content" }));
  assert.deepEqual((await Promise.all(requests)).map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(f.db.prepare("SELECT COUNT(*) n FROM job_notes").get(), { n: 1 });
  assert.deepEqual(f.db.prepare("SELECT COUNT(*) n FROM crm_lead_audit_events").get(), { n: 1 });
  f.db.prepare("INSERT INTO crm_commercial_operations(operation_id,actor_user_id,task_id,kind,request_hash,state,created_at,updated_at) VALUES(?,1,1,'quote.edit',?,'reconciliation','synthetic','synthetic')")
    .run(randomUUID(), "a".repeat(64));
  const capabilities = await f.request("/leads/1/capabilities", "GET", session).then(r => r.json()) as { canWriteNotes: boolean; integrationAvailable: boolean; blockedOperationId: string };
  assert.equal(capabilities.canWriteNotes, false); assert.equal(capabilities.integrationAvailable, false); assert.ok(capabilities.blockedOperationId);
  assert.equal((await f.request("/leads/1/notes", "POST", session,
    { operationId: randomUUID(), expectedVersion: 2, title: "Blocked", content: "Synthetic content" })).status, 409);
});

test("LOCAL SQLITE refuses product ID collisions and replay with remote or missing local provenance", async t => {
  const { db, runtime } = fixture(t); localWrites(db);
  const { sessionToken: token } = await runtime.auth.login("sqlite-1@example.invalid", password);
  const operationId = "00000000-0000-4000-8000-000000000001";
  const collisionId = "9" + BigInt("0x00000000000040008000000000000001").toString().padStart(39, "0");
  db.prepare("INSERT INTO products(product_id,product_name,created_at,updated_at) VALUES(?,'Preserved existing product','synthetic','synthetic')").run(collisionId);
  const rejected = (error: unknown) => (error as { status: number }).status === 409;
  await assert.rejects(runtime.services.commercial.createProduct(token, { operationId, name: "Must not overwrite", description: "" }), rejected);
  assert.deepEqual(db.prepare("SELECT product_name FROM products WHERE product_id=?").get(collisionId), { product_name: "Preserved existing product" });
  assert.deepEqual(db.prepare("SELECT COUNT(*) n FROM crm_commercial_operations").get(), { n: 0 });
  const product = { operationId: randomUUID(), name: "Local replay provenance", description: "" };
  const productResult = await runtime.services.commercial.createProduct(token, product);
  db.prepare("UPDATE crm_commercial_operations SET result_json=? WHERE operation_id=?")
    .run(JSON.stringify({ operationId: product.operationId, productId: productResult.productId, version: 1 }), product.operationId);
  await assert.rejects(runtime.services.commercial.createProduct(token, product), rejected);
  const note = { operationId: randomUUID(), expectedVersion: 1, title: "Local note provenance", content: "Synthetic content" };
  await runtime.services.mutations.addNote(token, "1", note);
  db.prepare("UPDATE crm_lead_operations SET remote_effect_possible=1 WHERE operation_id=?").run(note.operationId);
  await assert.rejects(runtime.services.mutations.addNote(token, "1", note), rejected);
  db.prepare("INSERT INTO tasks(id,deal_name,status) VALUES(2,'Unlinked synthetic lead','Pending')").run();
  assert.equal((await runtime.services.mutations.capabilities(token, "2")).canWriteNotes, false);
  await assert.rejects(runtime.services.mutations.addNote(token, "2", { ...note, operationId: randomUUID() }), rejected);
});

test("LOCAL SQLITE audit failures roll back notes products versions and journal reservations", async t => {
  const f = await http(t), session = await f.login(); localWrites(f.db);
  f.db.exec("CREATE TRIGGER synthetic_fail_note_audit BEFORE INSERT ON crm_lead_audit_events BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END");
  f.db.exec("CREATE TRIGGER synthetic_fail_product_audit BEFORE INSERT ON crm_commercial_audit_events BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END");
  const noteInput = { operationId: randomUUID(), expectedVersion: 1, title: "Rolled back", content: "Synthetic content" };
  const productInput = { operationId: randomUUID(), name: "Rolled back product", description: "" };
  for (const [path, input] of [["/leads/1/notes", noteInput], ["/items", productInput]] as const) {
    const response = await f.request(path, "POST", session, input); assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("private"), false);
  }
  for (const table of ["job_notes", "products", "crm_lead_operations", "crm_commercial_operations"]) {
    assert.deepEqual(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get(), { n: 0 });
  }
  assert.deepEqual(f.db.prepare("SELECT version FROM tasks WHERE id=1").get(), { version: 1 });
  f.db.exec("DROP TRIGGER synthetic_fail_note_audit"); f.db.exec("DROP TRIGGER synthetic_fail_product_audit");
  assert.equal((await f.request("/leads/1/notes", "POST", session, noteInput)).status, 200);
  assert.equal((await f.request("/items", "POST", session, productInput)).status, 200);
});

test("LOCAL SQLITE broad reader with no external identity can write notes without an ownership bypass", async t => {
  const { db, runtime } = fixture(t); localWrites(db, 2);
  db.prepare("UPDATE users SET user_id=NULL WHERE id=2").run();
  const session = await runtime.auth.login("sqlite-2@example.invalid", password);
  const saved = await runtime.services.mutations.addNote(session.sessionToken, "1",
    { operationId: randomUUID(), expectedVersion: 1, title: "Broad authorized note", content: "No external identity was invented." });
  assert.equal(saved.version, 2);
  grant(db, 2, "leads.manage.agents");
  await assert.rejects(runtime.services.mutations.addNote(session.sessionToken, "1",
    { operationId: randomUUID(), expectedVersion: 2, title: "Denied own scope", content: "Still denied." }), (error: unknown) => (error as { status: number }).status === 404);
  assert.deepEqual(db.prepare("SELECT user_id FROM users WHERE id=2").get(), { user_id: null });
});

test("LOCAL SQLITE note and product records and replay provenance survive real file reopen", async () => {
  const parent = resolve(tmpdir()), directory = mkdtempSync(join(parent, "voltronix-sqlite-local-writes-"));
  const filename = join(directory, `${randomUUID()}.sqlite`); let runtime: ReturnType<typeof createSqliteDemoRuntime> | undefined;
  try {
    const db = database(filename); seed(db); localWrites(db); runtime = createSqliteDemoRuntime(db);
    const session = await runtime.auth.login("sqlite-1@example.invalid", password);
    const note = { operationId: randomUUID(), expectedVersion: 1, title: "Persisted note", content: "Persistent local content" };
    const product = { operationId: randomUUID(), name: "Persisted product", description: "Persistent local description" };
    const noteResult = await runtime.services.mutations.addNote(session.sessionToken, "1", note);
    const productResult = await runtime.services.commercial.createProduct(session.sessionToken, product);
    await runtime.close();
    const reopened = new Database(filename); configureDatabase(reopened); runtime = createSqliteDemoRuntime(reopened);
    assert.deepEqual(await runtime.services.mutations.addNote(session.sessionToken, "1", note), noteResult);
    assert.deepEqual(await runtime.services.commercial.createProduct(session.sessionToken, product), productResult);
    assert.equal((await runtime.services.commercial.getProduct(session.sessionToken, productResult.productId)).name, product.name);
    assert.equal((await runtime.services.leads.listNotes(session.sessionToken, "1")).total, 1);
    assert.deepEqual(reopened.prepare("SELECT note_content FROM job_notes WHERE id=?").get(noteResult.noteId), { note_content: note.content });
    assert.deepEqual(reopened.pragma("foreign_key_check"), []);
  } finally {
    await runtime?.close(); const selected = resolve(directory);
    assert.ok(selected.startsWith(parent + sep) && basename(selected).startsWith("voltronix-sqlite-local-writes-"));
    rmSync(selected, { recursive: true, force: true });
  }
});

test("LOCAL SQLITE CRM-created deals preserve the non-null creator cohort and independent detail scope", async t => {
  const f = await http(t), session = await f.login(); grant(f.db, 1, "deals.view");
  f.db.prepare("UPDATE tasks SET deal_crm_created_by=1,qual_deal_number='QUAL-1',created_at='2026-01-01 01:00:00' WHERE id=1").run();
  f.db.prepare(`INSERT INTO tasks(id,deal_crm_created_by,assigned_to,deal_name,status,qual_deal_number,account_name,service_charge,created_at)
    VALUES(2,2,'external-2','Other creator','Closed Lost','QUAL-2','Literal 10%_! account','999999999999.99','2026-01-03 01:00:00'),
      (3,NULL,NULL,'Not CRM-created','Pending',NULL,'Excluded',NULL,'2026-01-04 01:00:00'),
      (4,1,NULL,'Unassigned creator record','Site Visit',NULL,NULL,NULL,'2026-01-03 01:00:00')`).run();
  const allResponse = await f.request("/deals", "GET", session); assert.equal(allResponse.status, 200);
  const all = await allResponse.json() as CreatedDealsPage;
  assert.equal(all.total, 3); assert.deepEqual(all.items.map(row => row.id), ["4", "2", "1"]);
  assert.equal(all.items[1]!.status, "Closed Lost"); assert.equal(all.items[1]!.serviceCharge, "999999999999.99");
  assert.equal(all.items[1]!.assignedName, "Synthetic SQLite user 2");
  assert.equal(all.items[0]!.serviceCharge, null); assert.equal(all.items[0]!.assignedName, null);
  const page = await (await f.request("/deals?page=2&pageSize=1", "GET", session)).json() as CreatedDealsPage;
  assert.equal(page.total, 3); assert.equal(page.items[0]!.id, "2");
  const escaped = await (await f.request("/deals?query=10%25_%21", "GET", session)).json() as CreatedDealsPage;
  assert.deepEqual(escaped.items.map(row => row.id), ["2"]);
  assert.equal((await f.request("/deals?scope=own", "GET", session)).status, 400);
  assert.equal((await f.request("/deals?page=1&page=2", "GET", session)).status, 400);
  assert.equal((await f.request("/deals?pageSize=101", "GET", session)).status, 400);
  assert.equal((await f.request("/deals", "GET", session, undefined, { origin: "https://other.invalid" })).status, 403);
  grant(f.db, 1, "leads.manage.agents");
  const scoped = await (await f.request("/deals", "GET", session)).json() as CreatedDealsPage;
  assert.equal(scoped.total, 3); // The created-deals source is not the own-leads list.
  assert.equal((await f.request("/leads/2", "GET", session)).status, 404);
  grant(f.db, 2, "deals.manage"); const manager = await f.login(2);
  assert.equal((await f.request("/deals", "GET", manager)).status, 403);
  f.db.prepare('DELETE FROM admin_user_permissions WHERE admin_user_id=1 AND permission_id=(SELECT id FROM permissions WHERE "key"=?)').run("deals.view");
  assert.equal((await f.request("/deals", "GET", session)).status, 403);
  grant(f.db, 1, "deals.view"); f.db.prepare("UPDATE users SET status='inactive' WHERE id=1").run();
  assert.equal((await f.request("/deals", "GET", session)).status, 401);
});

test("LOCAL SQLITE central jobs use latest department rows and exact overlapping source cohorts", async t => {
  const f = await http(t), session = await f.login();
  f.db.prepare("UPDATE tasks SET job_deal_date='2026-01-02',service_charge='123456789012.34' WHERE id=1").run();
  const task = f.db.prepare("INSERT INTO tasks(id,deal_name,status,Job_Status,job_deal_number) VALUES(?,?,?,?,?)");
  for (const [id, status, jobStatus] of [[2, "Closed Won", "Active"], [3, "Close to Won", "Active"], [4, "Closed Won", "Closed"],
    [5, "Pending", "Active"], [6, "Closed Won", "Hold"], [7, "Closed Won", null], [8, "Closed Won", ""],
    [9, "Closed Won", "Closed"], [10, "Closed Won", null]] as const) task.run(id, `Cohort ${id}`, status, jobStatus, `JOB-${id.toString().padStart(2, "0")}`);
  const assignment = f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(?,?,?,?)");
  for (const [id, userId, department, status] of [[2, 2, "Electrical", "Process"], [2, 1, "Civil", "Completed"],
    [3, 2, "Electrical", "Process"], [3, 1, "Electrical", "Hold"], [5, 1, "Electrical", "Assigned"],
    [7, 1, "Other department", "Process"], [8, 1, "Electrical", "Completed"], [8, 2, "Electrical", "Assigned"],
    [9, 2, "Maintenance", "Completed"], [10, 2, "PM", "Process"], [10, null, "PM", "Unassigned"]] as const) {
    assignment.run(id, userId, department, status);
  }
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=2").run(); // Historic assignee names remain source data.
  const snapshot = JSON.stringify(f.db.prepare("SELECT * FROM tasks ORDER BY id").all());
  const list = async (query = "") => {
    const response = await f.request(`/jobs${query}`, "GET", session); assert.equal(response.status, 200);
    return await response.json() as CentralJobPage;
  };
  const ids = (result: CentralJobPage) => result.items.map(row => row.id).sort((a, b) => Number(a) - Number(b));
  const all = await list(); assert.equal(all.total, 9); assert.deepEqual(ids(all), ["1", "2", "3", "4", "6", "7", "8", "9", "10"]);
  assert.deepEqual(ids(await list("?cohort=pending")), ["1", "6"]);
  assert.deepEqual(ids(await list("?cohort=process")), ["2", "8"]);
  assert.deepEqual(ids(await list("?cohort=completed")), ["2", "9"]);
  assert.deepEqual(ids(await list("?cohort=hold")), ["6"]);
  assert.deepEqual(ids(await list("?cohort=closed")), ["4", "9"]);
  assert.deepEqual(ids(await list("?cohort=completed&jobStatus=Active")), ["2"]);
  assert.equal((await list("?cohort=closed&jobStatus=Active")).total, 0);
  const first = all.items.find(row => row.id === "1")!;
  assert.equal(first.jobDate, "2026-01-02"); assert.equal(first.serviceCharge, "123456789012.34");
  assert.equal(first.assignedName, "Synthetic SQLite user 1"); assert.deepEqual(first.departments, []);
  assert.deepEqual(all.items.find(row => row.id === "2")!.departments,
    [{ department: "Electrical", userName: "Synthetic SQLite user 2", status: "Process" }, { department: "Civil", userName: "Synthetic SQLite user 1", status: "Completed" }]);
  assert.deepEqual(all.items.find(row => row.id === "10")!.departments, [{ department: "PM", userName: null, status: "Unassigned" }]);
  const page = await list("?page=2&pageSize=2"); assert.equal(page.total, 9); assert.deepEqual(ids(page), ["7", "8"]);
  assert.equal((await list("?query=SQLite%20user%201")).total, 1);
  for (const query of ["?cohort=own", "?cohort=process&cohort=completed", "?pageSize=0", "?scope=own", "?query=%00"]) {
    assert.equal((await f.request(`/jobs${query}`, "GET", session)).status, 400);
  }
  for (const cohort of ["all", "pending", "process", "completed", "hold", "closed"]) {
    const matching = await list(`?cohort=${cohort}`), response = await f.request(`/jobs/export?cohort=${cohort}`, "GET", session);
    assert.equal(response.status, 200);
    const rows = workbookRows(new Uint8Array(await response.arrayBuffer()));
    assert.deepEqual(rows[0], [...JOB_EXPORT_COLUMNS]);
    assert.deepEqual(rows.slice(1).map(row => row[1]), matching.items.map(item => item.jobNumber));
  }
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM tasks ORDER BY id").all()), snapshot);
  assert.deepEqual(f.db.pragma("foreign_key_check"), []);
  f.db.prepare('DELETE FROM admin_user_permissions WHERE admin_user_id=1 AND permission_id=(SELECT id FROM permissions WHERE "key"=?)').run("dashboard.view");
  assert.equal((await f.request("/jobs?cohort=process", "GET", session)).status, 403);
  assert.equal((await f.request("/jobs/export?cohort=process", "GET", session)).status, 403);
});

test("LOCAL SQLITE source lists authorize direct calls and keep infrastructure errors opaque", async t => {
  const { db, runtime } = fixture(t), session = await runtime.auth.login("sqlite-2@example.invalid", password);
  const reads = runtime.services.localReads!;
  await assert.rejects(reads.listCreatedDeals(session.sessionToken, {}), (error: unknown) => (error as { status: number }).status === 403);
  await assert.rejects(reads.listJobs(session.sessionToken, {}), (error: unknown) => (error as { status: number }).status === 403);
  await assert.rejects(reads.exportJobs(session.sessionToken, {}), (error: unknown) => (error as { status: number }).status === 403);
  grant(db, 2, "deals.view"); grant(db, 2, "dashboard.view");
  for (const input of [{ page: "1" }, { page: 1.5 }, { creatorId: "2" }, { query: "x".repeat(121) }]) {
    await assert.rejects(reads.listCreatedDeals(session.sessionToken, input), (error: unknown) => (error as { status: number }).status === 400);
  }
  db.prepare("ALTER TABLE tasks RENAME COLUMN deal_crm_created_by TO synthetic_private_column").run();
  await assert.rejects(reads.listCreatedDeals(session.sessionToken, {}), (error: unknown) => {
    assert.equal((error as { status: number }).status, 503);
    assert.equal((error as Error).message, "Local lists are temporarily unavailable."); return true;
  });
});

test("LOCAL SQLITE job export matches agent search across every page and keeps money and formula-like text literal", async t => {
  const f = await http(t), session = await f.login();
  const formula = '=HYPERLINK("https://example.invalid","Synthetic & <text>")';
  f.db.prepare("UPDATE tasks SET account_name=?,service_charge='999999999999.99' WHERE id=1").run(formula);
  f.db.prepare(`INSERT INTO tasks(id,assigned_to,deal_name,status,Job_Status,job_deal_number,service_charge)
    VALUES(2,'external-1','Second matching row','Closed Won','Active','DEMO-2',NULL),
      (3,'external-2','Other salesperson','Closed Won','Active','DEMO-3','1.005')`).run();
  const query = "query=Synthetic%20SQLite%20user%201&cohort=pending&jobStatus=Active";
  const page = await (await f.request(`/jobs?${query}&pageSize=1`, "GET", session)).json() as CentralJobPage;
  assert.equal(page.total, 2); assert.equal(page.items.length, 1);
  const exported = await f.request(`/jobs/export?${query}`, "GET", session); assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(exported.headers.get("cache-control"), "private, no-store");
  assert.equal(exported.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  const bytes = new Uint8Array(await exported.arrayBuffer());
  assert.equal(Number(exported.headers.get("content-length")), bytes.length);
  const rows = workbookRows(bytes); assert.equal(rows.length, 3); assert.deepEqual(rows[0], [...JOB_EXPORT_COLUMNS]);
  assert.deepEqual(rows.slice(1).map(row => [row[1], row[9]]), [["DEMO-2", ""], ["DEMO-1", "999999999999.99"]]);
  assert.equal(rows[2]![3], formula); assert.deepEqual(rows[2]!.slice(5, 9), ["Not Assigned", "Not Assigned", "Not Assigned", ""]);
  const rounded = await f.request("/jobs/export?query=Other%20salesperson", "GET", session);
  assert.equal(rounded.status, 200); assert.equal(workbookRows(new Uint8Array(await rounded.arrayBuffer()))[1]![9], "1.01");
  for (const invalid of ["page=1", "pageSize=25", "cohort=unknown", "cohort=all&cohort=hold", "query=%00", "scope=own"]) {
    assert.equal((await f.request(`/jobs/export?${invalid}`, "GET", session)).status, 400);
  }
  assert.equal((await f.request("/jobs/export")).status, 401);
  assert.equal((await f.request("/jobs/export", "GET", session, undefined, { origin: "https://other.invalid" })).status, 403);
});

test("LOCAL SQLITE job export enforces row and workbook byte limits without truncating the matching set", async t => {
  const { db, runtime } = fixture(t), session = await runtime.auth.login("sqlite-1@example.invalid", password);
  db.prepare(`WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<=?)
    INSERT INTO tasks(id,deal_name,status,job_deal_number) SELECT x,'Export limit row','Closed Won',CAST(x AS TEXT) FROM n`).run(MAX_EXPORT_ROWS);
  const reads = runtime.services.localReads!;
  await assert.rejects(reads.exportJobs(session.sessionToken, {}), (error: unknown) => (error as { status: number }).status === 413);
  const bounded = await reads.exportJobs(session.sessionToken, { query: "Export limit row" });
  assert.equal(bounded.rowCount, MAX_EXPORT_ROWS); assert.equal(workbookRows(bounded.bytes).length, MAX_EXPORT_ROWS + 1);
  db.prepare("UPDATE tasks SET account_name=?,deal_name='Large export bytes' WHERE id<=710").run("x".repeat(24_000));
  await assert.rejects(reads.exportJobs(session.sessionToken, { query: "Large export bytes" }), (error: unknown) => (error as { status: number }).status === 413);
  db.prepare("UPDATE tasks SET account_name=?,deal_name='Single oversized cell' WHERE id=1").run("x".repeat(32_768));
  await assert.rejects(reads.exportJobs(session.sessionToken, { query: "Single oversized cell" }), (error: unknown) => (error as { status: number }).status === 413);
  db.prepare("UPDATE tasks SET account_name=NULL,service_charge='unparseable private value' WHERE id=1").run();
  await assert.rejects(reads.exportJobs(session.sessionToken, { query: "Single oversized cell" }), (error: unknown) => {
    assert.equal((error as { status: number }).status, 503);
    assert.equal((error as Error).message, "Local lists are temporarily unavailable."); return true;
  });
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("LOCAL SQLITE department queue dates retain current assignment scope and nullable source values", async t => {
  const f = await http(t), session = await f.login();
  f.db.prepare("UPDATE tasks SET job_deal_date='2026-02-03' WHERE id=1").run();
  f.db.prepare(`INSERT INTO tasks(id,deal_name,status,job_deal_date) VALUES(2,'Other worker date','Closed Won','2026-02-04'),
    (3,'Unknown date','Closed Won',NULL),(4,'Reassigned job','Closed Won','2026-02-05')`).run();
  const assign = f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(?,?,'Electrical','Assigned')");
  for (const [taskId, userId] of [[1, 1], [2, 2], [3, 1], [4, 1], [4, 2]]) assign.run(taskId, userId);
  const response = await f.request("/departments/Electrical/jobs", "GET", session); assert.equal(response.status, 200);
  const page = await response.json() as { total: number; items: { id: string; jobDate: string | null }[] };
  assert.equal(page.total, 2); assert.deepEqual(page.items.map(row => ({ id: row.id, jobDate: row.jobDate })).sort((a, b) => Number(a.id) - Number(b.id)),
    [{ id: "1", jobDate: "2026-02-03" }, { id: "3", jobDate: null }]);
  assert.equal((await f.request("/departments/Civil/jobs", "GET", session)).status, 403);
  const other = await f.login(2); grant(f.db, 2, "dashboard.view");
  assert.equal((await f.request("/departments/Electrical/jobs", "GET", other)).status, 403); // No manager bypass.
  f.db.prepare('DELETE FROM admin_user_permissions WHERE admin_user_id=1 AND permission_id=(SELECT id FROM permissions WHERE "key"=?)').run("electrical.manage");
  assert.equal((await f.request("/departments/Electrical/jobs", "GET", session)).status, 403);
});

test("LOCAL SQLITE job complaint description retains saved text and the original authorized won-job boundary", async t => {
  const f = await http(t), session = await f.login(), denied = await f.login(2);
  const description = "Synthetic complaint <text> & details\nA second line.";
  f.db.prepare("UPDATE tasks SET complaint_info=? WHERE id=1").run(description);
  f.db.prepare("INSERT INTO tasks(id,deal_name,status,complaint_info) VALUES(2,'Unknown complaint','Closed Won',NULL),(3,'Not a won job','Pending','Excluded private fixture text')").run();
  const read = await f.request("/jobs/1", "GET", session); assert.equal(read.status, 200);
  assert.equal((await read.json() as { complaintDescription: string | null }).complaintDescription, description);
  const absent = await f.request("/jobs/2", "GET", session); assert.equal(absent.status, 200);
  assert.equal((await absent.json() as { complaintDescription: string | null }).complaintDescription, null);
  const nonJob = await f.request("/jobs/3", "GET", session); assert.equal(nonJob.status, 404);
  assert.deepEqual(await nonJob.json(), { error: "Job not found." });
  const forbidden = await f.request("/jobs/1", "GET", denied); assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "Access denied." });
  const snapshot = JSON.stringify(f.db.prepare("SELECT * FROM tasks ORDER BY id").all());
  f.db.prepare('DELETE FROM admin_user_permissions WHERE admin_user_id=1 AND permission_id=(SELECT id FROM permissions WHERE "key"=?)').run("dashboard.view");
  assert.equal((await f.request("/jobs/1", "GET", session)).status, 403);
  const signedIn = await f.runtime.auth.login("sqlite-1@example.invalid", password);
  await assert.rejects(f.runtime.services.jobs.getJob(signedIn.sessionToken, "1"), (error: unknown) => (error as { status: number }).status === 403);
  assert.equal(JSON.stringify(f.db.prepare("SELECT * FROM tasks ORDER BY id").all()), snapshot);
});
