import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { strFromU8, unzipSync } from "fflate";
import { createAuthService } from "./sqlite-reference/auth/service";
import { configureDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase } from "./sqlite-reference/db/migrations";
import { createExportsService, ExportsError } from "./sqlite-reference/exports/service";
import { buildJobsWorkbook, ExportLimitError, JOB_EXPORT_COLUMNS, MAX_EXPORT_ROWS } from "./sqlite-reference/exports/xlsx";

const password = "Synthetic export fixture password";
const hash = hashSync(password, 4);
const now = Date.parse("2026-10-10T21:00:00Z");
function code(status: number) { return (error: unknown) => error instanceof ExportsError && error.status === status; }
function sheet(bytes: Uint8Array) { return strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!); }
function row(xml: string, number: number) {
  const text = xml.match(new RegExp(`<row r="${number}">([\\s\\S]*?)</row>`))?.[1] ?? "";
  return [...text.matchAll(/<t xml:space="preserve">([\s\S]*?)<\/t>/g)].map((match) => match[1]);
}
async function fixture(t: TestContext) {
  const db = new Database(":memory:"); configureDatabase(db); migrateDatabase(db); t.after(() => db.close());
  const grant = (id: number, key: string) => {
    db.prepare('INSERT INTO permissions(key,label) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run(key, key);
    db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE key=?').run(id, key);
  };
  for (let id = 1; id <= 4; id++) db.prepare("INSERT INTO users(id,user_id,username,email,password,status) VALUES(?,?,?,?,?,'active')")
    .run(id, `external-${id}`, `Fixture ${id}`, `export-${id}@example.invalid`, hash);
  grant(1, "dashboard.view"); grant(2, "electrical.manage"); grant(3, "civil.manage"); grant(4, "leads.view");
  const addJob = (id: number, status = "Close to Won", jobStatus: string | null = null, account = `Fixture account ${id}`) =>
    db.prepare("INSERT INTO tasks(id,deal_name,status,Job_Status,job_deal_number,job_deal_date,created_at,account_name,service_charge) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, `Fixture job ${id}`, status, jobStatus, `JOB-${id}`, "2026-10-10", "2026-10-10 12:00:00", account, id === 1 ? "9007199254740993.125" : null);
  const assign = (taskId: number, userId: number | null, department = "Electrical", status = "Assigned") =>
    db.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(?,?,?,?)").run(taskId, userId, department, status);
  addJob(1); addJob(2, "Closed Won", "Hold"); addJob(3, "Qualification"); addJob(4, "Close to Won", "Closed");
  assign(1, 2); assign(1, 2, "Electrical", "Process"); assign(1, 3, "Civil", "Completed");
  assign(2, 2); assign(2, 3); assign(3, 2); assign(4, 2); assign(4, null, "Electrical", "Unassigned");
  db.prepare("INSERT INTO accounts(task_id,user_id,payment_status) VALUES(1,1,'Pending'),(1,1,'Paid')").run();
  const auth = createAuthService(db, { now: () => now });
  const login = async (id: number) => (await auth.login(`export-${id}@example.invalid`, password, "fixture")).sessionToken;
  return { db, auth, grant, assign, addJob, manager: await login(1), electrical: await login(2), civil: await login(3), denied: await login(4),
    service: createExportsService(db, { now: () => now }) };
}

test("central XLSX export requires current dashboard.view and never infers rights from role or other grants", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.exportJobs(null, { invalid: true }), code(401));
  for (const token of [f.electrical, f.civil, f.denied]) assert.throws(() => f.service.exportJobs(token, { invalid: true }), code(403));
  f.db.prepare("UPDATE users SET role='admin',quote_access=1 WHERE id=4").run();
  assert.throws(() => f.service.exportJobs(f.denied), code(403));
  assert.equal(f.service.exportJobs(f.manager).rowCount, 3);
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  assert.throws(() => f.service.exportJobs(f.manager), code(403));
});
test("department exports restrict all five grants to the current latest local assignee", async (t) => {
  const f = await fixture(t);
  const result = f.service.exportDepartmentJobs(f.electrical, "Electrical");
  assert.equal(result.rowCount, 1); assert.equal(row(sheet(result.bytes), 2)[1], "JOB-1");
  assert.throws(() => f.service.exportDepartmentJobs(f.electrical, "Civil"), code(403));
  assert.throws(() => f.service.exportDepartmentJobs(f.manager, "Electrical"), code(403));
  assert.throws(() => f.service.exportDepartmentJobs(f.manager, null), code(400));
  for (const [department, permission] of [["PM", "project_manager.manage"], ["Switchgear", "switchgear.manage"], ["Maintenance", "maintenance.manage"]]) {
    f.grant(2, permission!); f.assign(1, 2, department);
    assert.equal(f.service.exportDepartmentJobs(f.electrical, department).rowCount, 1);
  }
  f.assign(1, null, "Electrical", "Unassigned");
  assert.equal(f.service.exportDepartmentJobs(f.electrical, "Electrical").rowCount, 0);
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=2").run();
  assert.throws(() => f.service.exportDepartmentJobs(f.electrical, "Electrical"), code(401));
});
test("export matches source columns, actual latest assignment/account states and exact rounded amounts", async (t) => {
  const f = await fixture(t);
  const result = f.service.exportJobs(f.manager, { query: "JOB-1" });
  assert.equal(result.filename, "All_Jobs_2026-10-11.xlsx");
  assert.equal(result.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  const xml = sheet(result.bytes);
  assert.deepEqual(row(xml, 1), [...JOB_EXPORT_COLUMNS]);
  assert.deepEqual(row(xml, 2), ["2026-10-10 12:00:00", "JOB-1", "2026-10-10", "Fixture account 1", "Close to Won",
    "Process", "Completed", "Not Assigned", "Paid", "9007199254740993.13"]);
  const missing = row(sheet(f.service.exportJobs(f.manager, { query: "JOB-2" }).bytes), 2);
  assert.equal(missing[8], ""); assert.equal(missing[9], "");
});
test("exports apply literal search and supported job-state filters without allowing caller-selected paths", async (t) => {
  const f = await fixture(t);
  f.addJob(5, "Close to Won", "", "Fixture 100%_literal");
  assert.equal(f.service.exportJobs(f.manager, { query: "%_" }).rowCount, 1);
  assert.equal(f.service.exportJobs(f.manager, { query: "' OR 1=1--" }).rowCount, 0);
  assert.equal(f.service.exportJobs(f.manager, { jobStatus: "Active" }).rowCount, 2);
  assert.equal(f.service.exportJobs(f.manager, { jobStatus: "Closed" }).rowCount, 1);
  for (const input of [{ path: "../elsewhere" }, { jobStatus: "invalid" }, { query: "a".repeat(121) }])
    assert.throws(() => f.service.exportJobs(f.manager, input), code(400));
});
test("XLSX archive is real fixed OOXML and all hostile cells are strings without formulas/macros/external links", () => {
  const hostile = ['=HYPERLINK("https://example.invalid","x")', "+SUM(1,2)", "-1+2", "@SUM(1,2)", "\t=1+1", "<script>&x", "_x0041_", "control\0text", "😀", null];
  const bytes = buildJobsWorkbook([hostile]);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString("hex"), "504b0304");
  const files = unzipSync(bytes);
  assert.deepEqual(Object.keys(files).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml"].sort());
  const xml = sheet(bytes);
  assert.equal((xml.match(/t="inlineStr"/g) ?? []).length, 20);
  assert.doesNotMatch(xml, /<f(?:\s|>)/); assert.doesNotMatch(xml, /<hyperlink/);
  assert.match(xml, /&lt;script&gt;&amp;x/); assert.match(xml, /_x005F_x0041_/); assert.match(xml, /control_x0000_text/);
  assert.ok(xml.includes("😀"));
  for (const contents of Object.values(files)) assert.doesNotMatch(strFromU8(contents), /TargetMode="External"|vbaProject/);
});
test("empty exports contain headers and bounded export size refuses silent truncation", async (t) => {
  const f = await fixture(t);
  assert.equal(row(sheet(f.service.exportJobs(f.manager, { query: "absent" }).bytes), 1).length, 10);
  assert.throws(() => buildJobsWorkbook(Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => Array(10).fill(""))), ExportLimitError);
  assert.throws(() => buildJobsWorkbook([["only-one"]]), ExportLimitError);
  assert.throws(() => buildJobsWorkbook([Array(10).fill("x".repeat(32_768))]), ExportLimitError);
  assert.throws(() => buildJobsWorkbook(Array.from({ length: 60 }, () => Array(10).fill("x".repeat(32_767)))), ExportLimitError);
  f.db.transaction(() => { for (let id = 10; id < MAX_EXPORT_ROWS + 10; id++) f.addJob(id); })();
  assert.throws(() => f.service.exportJobs(f.manager), code(413));
});
test("malformed persisted financial values and database failures return safe export errors", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE tasks SET service_charge='not money' WHERE id=1").run();
  assert.throws(() => f.service.exportJobs(f.manager), code(503));
  f.db.exec("DROP TABLE accounts");
  assert.throws(() => f.service.exportJobs(f.manager), (error: unknown) => error instanceof ExportsError
    && error.status === 503 && !error.message.includes("accounts"));
});
