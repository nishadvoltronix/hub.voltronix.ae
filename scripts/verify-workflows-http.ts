import { assertSqliteReferenceBuild } from "./sqlite-reference-http-guard";
assertSqliteReferenceBuild();
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hashSync } from "bcryptjs";
import { chromium } from "playwright";
import { strFromU8, unzipSync } from "fflate";
import { parseDatabaseConfig } from "../tests/sqlite-reference/config/database";
import { localDirectory, openDatabase, type SqliteDatabase } from "../tests/sqlite-reference/db/connection";
import { migrateDatabase } from "../tests/sqlite-reference/db/migrations";
import type { DepartmentJob, JobAssignments, Page, WorkLog } from "../tests/sqlite-reference/departments/contracts";
import type { PerformanceReport } from "../tests/sqlite-reference/reports/contracts";
import type { Attachment } from "../tests/sqlite-reference/attachments/service";
import { gifWithCodes, syntheticGif, syntheticLargeGif } from "../tests/gif-fixture";
import { syntheticActionPdf } from "../tests/helpers/pdf-upload-fixture";

let currentCheck = "isolated workflow fixture setup";
type AttachmentList = { items: Attachment[]; total: number; version: number; canUpload: boolean };
function syntheticLogPng() {
  function chunk(type: string, content: Buffer) {
    const header = Buffer.alloc(8), checksum = Buffer.alloc(4); header.writeUInt32BE(content.length); header.write(type, 4);
    checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), content]))); return Buffer.concat([header, content, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  const root = realpathSync(process.cwd()), testRoot = localDirectory(root, [".local-data", "test"], true);
  const directory = mkdtempSync(join(testRoot, "workflows-")), databasePath = relative(root, join(directory, "crm.sqlite"));
  const reportDirectory = mkdtempSync(join(localDirectory(root, [".local-data", "reports"], true), "workflow-browser-"));
  const desktopScreenshot = join(reportDirectory, "report-desktop.png"), mobileScreenshot = join(reportDirectory, "department-mobile.png");
  let database: SqliteDatabase | undefined, child: ChildProcess | undefined, exited: Promise<unknown> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const password = randomBytes(24).toString("base64url"), storedHash = hashSync(password, 4);
  const htmlFixture = "<script>globalThis.__workflowXss=1</script>";
  try {
    database = openDatabase(parseDatabaseConfig({ DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath }, root), { create: true });
    migrateDatabase(database);
    for (const [id, name, role] of [[1, "Workflow manager fixture", null], [2, "Workflow denied fixture", null], [3, "Workflow electrician fixture", "Electrical"],
      [4, "Workflow other electrician", "Electrical"], [5, "Workflow viewer fixture", null]] as const) {
      database.prepare("INSERT INTO users(id,user_id,username,email,password,department_role) VALUES(?,?,?,?,?,?)")
        .run(id, `workflow-owner-${id}`, name, `workflow-${id}@example.test`, storedHash, role);
    }
    function grant(id: number, key: string) {
      database!.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
      database!.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
    }
    grant(1, "dashboard.view"); grant(3, "electrical.manage"); grant(4, "electrical.manage"); grant(5, "leads.view");
    const task = database.prepare(`INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status,Job_Status,account_name,job_deal_number,service_charge,created_at)
      VALUES(?,?,?, ?,?,'Active','Synthetic workflow account',?,?,'2000-01-02 12:00:00')`);
    task.run(1, "workflow-deal-1", "workflow-owner-3", "Workflow primary won job", "Close to Won", "WF-1", "10.25");
    task.run(2, "workflow-deal-2", "workflow-owner-4", "Workflow other won job", "Closed Won", "WF-2", "20.50");
    task.run(3, "workflow-deal-3", "workflow-owner-3", "Workflow pending lead", "Qualification", "WF-3", "0");
    database.prepare("UPDATE tasks SET account_name='=1+1' WHERE id=2").run();
    const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const address = listener.address(); assert(address && typeof address !== "string"); const port = address.port;
    await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: root, windowsHide: true, stdio: "ignore",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath, APP_ORIGIN: base },
    });
    exited = once(child, "exit");
    function client() {
      const cookies = new Map<string, string>(); let csrf = "";
      async function request(path: string, options: RequestInit = {}) {
        const headers = new Headers(options.headers); headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
        const response = await fetch(base + path, { ...options, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(";")[0]!, i = pair.indexOf("="); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
        return response;
      }
      async function login(id: number) {
        const challenge = await request("/api/auth/csrf"); assert.equal(challenge.status, 200); csrf = (await challenge.json() as { csrfToken: string }).csrfToken;
        const response = await request("/api/auth/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ email: `workflow-${id}@example.test`, password }) });
        assert.equal(response.status, 200); csrf = (await response.json() as { csrfToken: string }).csrfToken;
      }
      function mutate(path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) {
        return request(path, { method, headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrf, ...headers }, body: JSON.stringify(body) });
      }
      function upload(taskId: number, expectedVersion: number, name: string, content: string | Buffer, type = "text/plain", headers: Record<string, string> = {}) {
        const body = new FormData(); body.append("expectedVersion", String(expectedVersion)); body.append("file", new Blob([typeof content === "string" ? content : new Uint8Array(content)], { type }), name);
        return request(`/api/leads/${taskId}/attachments`, { method: "POST", headers: { Origin: base, "X-CSRF-Token": csrf, ...headers }, body });
      }
      function uploadLog(taskId: number, payload: unknown, options: { name?: string; type?: string; bytes?: Buffer; headers?: Record<string, string>; duplicate?: boolean; extraField?: boolean } = {}) {
        const body = new FormData(); body.append("payload", JSON.stringify(payload));
        body.append("file", new Blob([new Uint8Array(options.bytes ?? syntheticLogPng())], { type: options.type ?? "image/png" }), options.name ?? "synthetic-work-log.png");
        if (options.duplicate) body.append("payload", JSON.stringify(payload));
        if (options.extraField) body.append("attachmentId", "ordinary-task-file");
        return request(`/api/departments/Electrical/jobs/${taskId}/logs`, { method: "POST", headers: { Origin: base, "X-CSRF-Token": csrf, ...options.headers }, body });
      }
      return { request, login, mutate, upload, uploadLog };
    }
    async function json<T>(response: Response, expected = 200): Promise<T> {
      assert.equal(response.status, expected); assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      const raw = await response.text(); assert(!raw.includes(password) && !raw.includes(storedHash), "Response exposed synthetic authentication data.");
      return JSON.parse(raw) as T;
    }
    currentCheck = "workflow production server startup";
    const deadline = Date.now() + 20_000; let online = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Owned workflow server exited during startup.");
      try { online = (await fetch(base + "/api/health/live", { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ }
      if (online) break; await delay(150);
    }
    assert(online);
    const anonymous = client(), manager = client(), worker = client(), other = client(), denied = client(), viewer = client();
    const assignmentUrl = "/api/jobs/1/assignments", departmentUrl = "/api/departments/Electrical/jobs/1";
    currentCheck = "authentication, module authorization and empty source-backed queues";
    for (const path of [assignmentUrl, "/api/departments/Electrical/assignees", "/api/departments/Electrical/jobs", departmentUrl,
      departmentUrl + "/logs", "/api/reports/employee-performance", "/api/leads/1/attachments"]) assert.equal((await anonymous.request(path)).status, 401);
    for (const path of ["/departments/Electrical/jobs", "/departments/Electrical/jobs/1", "/reports/employee-performance"]) {
      const response = await anonymous.request(path); assert.equal(response.status, 307); assert.equal(response.headers.get("location"), "/login");
    }
    for (const [caller, id] of [[manager, 1], [denied, 2], [worker, 3], [other, 4], [viewer, 5]] as const) await caller.login(id);
    for (const path of ["/departments/Electrical/jobs", "/departments/Electrical/jobs/1", "/reports/employee-performance"]) assert.equal((await denied.request(path)).status, 404);
    assert.equal((await denied.request(assignmentUrl)).status, 403); assert.equal((await worker.request(assignmentUrl)).status, 403);
    assert.equal((await manager.request("/api/departments/Electrical/jobs")).status, 403);
    assert.equal((await worker.request(departmentUrl)).status, 404);
    assert.equal((await json<Page<DepartmentJob>>(await worker.request("/api/departments/Electrical/jobs"))).total, 0);
    assert.equal((await json<Page<{ id: string; name: string }>>(await manager.request("/api/departments/Electrical/assignees?pageSize=1"))).total, 2);
    currentCheck = "manager assignment validation, CSRF, conflicts and persistence";
    const assignBody = { expectedVersion: 1, assignments: [{ department: "Electrical", userId: "3" }] };
    assert.equal((await manager.mutate(assignmentUrl, assignBody, "POST", { "X-CSRF-Token": "wrong" })).status, 403);
    assert.equal((await manager.mutate(assignmentUrl, assignBody, "POST", { Origin: "https://invalid.example" })).status, 403);
    assert.equal((await worker.mutate(assignmentUrl, assignBody)).status, 403);
    assert.equal((await manager.mutate(assignmentUrl, { ...assignBody, assignments: [{ department: "Electrical", userId: "2" }] })).status, 400);
    let assigned = await json<JobAssignments>(await manager.mutate(assignmentUrl, assignBody));
    assert.equal(assigned.version, 2); assert.equal(assigned.assignments[0]!.userId, "3");
    assert.equal((await manager.mutate(assignmentUrl, assignBody)).status, 409);
    assert.equal((await other.request(departmentUrl)).status, 404);
    let record = await json<DepartmentJob>(await worker.request(departmentUrl)); assert.equal(record.assignment.userId, "3");
    assert.equal((await json<Page<DepartmentJob>>(await worker.request("/api/departments/Electrical/jobs?query=primary&pageSize=1"))).total, 1);
    assert.equal((await worker.request("/api/departments/Electrical/jobs?page=1&page=2")).status, 400);
    assert.equal((await worker.request("/api/departments/Electrical/jobs?userId=4")).status, 400);
    database.exec("CREATE TRIGGER workflow_fixture_audit_failure BEFORE INSERT ON crm_department_audit_events BEGIN SELECT RAISE(ABORT,'internal fixture error'); END");
    const failed = await json<{ error: string }>(await worker.mutate(departmentUrl + "/status", { expectedVersion: 2, status: "Process" }, "PATCH"), 503);
    assert(!failed.error.includes("internal fixture"));
    assert.equal((await json<DepartmentJob>(await worker.request(departmentUrl))).version, 2);
    database.exec("DROP TRIGGER workflow_fixture_audit_failure");
    currentCheck = "text logs, statuses, local actor, invalid fields and permission-scoped history";
    const entry = { expectedVersion: 2, authority: "DESIGN", status: "DOCUMENTS PENDING", comments: "Synthetic authority response", notes: htmlFixture };
    assert.equal((await worker.mutate(departmentUrl + "/logs", { ...entry, actorId: "1" })).status, 400);
    assert.equal((await other.mutate(departmentUrl + "/logs", entry)).status, 404);
    assert.equal((await worker.uploadLog(1, entry, { headers: { "X-CSRF-Token": "wrong" } })).status, 403);
    assert.equal((await worker.uploadLog(1, entry, { headers: { Origin: "https://invalid.example" } })).status, 403);
    assert.equal((await anonymous.uploadLog(1, entry)).status, 401);
    assert.equal((await other.uploadLog(1, entry)).status, 404);
    assert.equal((await manager.uploadLog(1, entry)).status, 403);
    assert.equal((await worker.uploadLog(1, entry, { duplicate: true })).status, 400);
    assert.equal((await worker.uploadLog(1, entry, { extraField: true })).status, 400);
    assert.equal((await worker.uploadLog(1, entry, { bytes: Buffer.from("spoofed PNG") })).status, 415);
    assert.equal((await worker.uploadLog(1, entry, { bytes: Buffer.alloc(0) })).status, 400);
    assert.equal((await worker.uploadLog(1, entry, { name: "not-allowed.txt", type: "text/plain", bytes: Buffer.from("Text") })).status, 415);
    assert.equal((await worker.uploadLog(1, entry, { name: "invalid.gif", type: "image/gif", bytes: Buffer.concat([syntheticGif(), Buffer.from("appended content")]) })).status, 415);
    assert.equal((await worker.uploadLog(1, entry, { name: "active.pdf", type: "application/pdf", bytes: syntheticActionPdf("/S /Named /N /Print", "#41") })).status, 415);
    assert.equal((await json<DepartmentJob>(await worker.request(departmentUrl))).version, 2);
    assert.equal((await json<Page<WorkLog>>(await worker.request(departmentUrl + "/logs"))).total, 0);
    record = await json<DepartmentJob>(await worker.uploadLog(1, entry)); assert.equal(record.version, 3);
    const logs = await json<Page<WorkLog>>(await worker.request(departmentUrl + "/logs?pageSize=1"));
    assert.equal(logs.total, 1); assert.equal(logs.items[0]!.actorId, "3"); assert.equal(logs.items[0]!.notes, htmlFixture);
    const privateLogFile = logs.items[0]!.attachment; assert.ok(privateLogFile);
    const logFilePath = `/api/log-attachments/${privateLogFile.id}`;
    for (const caller of [worker, manager]) {
      const response = await caller.request(logFilePath); assert.equal(response.status, 200);
      assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), syntheticLogPng());
    }
    for (const caller of [other, viewer, denied]) assert.equal((await caller.request(logFilePath)).status, 404);
    assert.equal((await anonymous.request(logFilePath)).status, 401);
    assert.equal((await manager.request(`/api/attachments/${privateLogFile.id}`)).status, 404);
    assert.equal((await json<AttachmentList>(await viewer.request("/api/leads/1/attachments"))).total, 0);
    assert.equal((await worker.uploadLog(1, entry)).status, 409);
    assert.equal((await worker.request(logFilePath + "?taskId=2")).status, 400);
    assert.equal((await worker.mutate(logFilePath, { taskId: "2" }, "PATCH")).status, 405);
    assert.equal((await json<Page<WorkLog>>(await manager.request("/api/jobs/1/logs?department=Electrical"))).total, 1);
    record = await json<DepartmentJob>(await worker.mutate(departmentUrl + "/status", { expectedVersion: 3, status: "Completed" }, "PATCH"));
    assert.equal(record.assignment.status, "Completed"); assert.equal(record.version, 4);
    assert.equal((await worker.mutate(departmentUrl + "/logs", { ...entry, expectedVersion: 4 })).status, 409);
    assert.equal((await manager.mutate("/api/jobs/1/unassign", { expectedVersion: 4, department: "Electrical" })).status, 409);
    record = await json<DepartmentJob>(await worker.mutate(departmentUrl + "/status", { expectedVersion: 4, status: "Process" }, "PATCH"));
    assert.equal(record.version, 5);
    const concurrent = await Promise.all([worker.mutate(departmentUrl + "/status", { expectedVersion: 5, status: "Process" }, "PATCH"),
      worker.mutate(departmentUrl + "/status", { expectedVersion: 5, status: "Completed" }, "PATCH")]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    record = await json<DepartmentJob>(await worker.request(departmentUrl));
    if (record.assignment.status === "Completed") record = await json<DepartmentJob>(await worker.mutate(departmentUrl + "/status", { expectedVersion: record.version, status: "Process" }, "PATCH"));
    currentCheck = "protected local attachments, validation, version conflict, download bytes and headers";
    let files = await json<AttachmentList>(await worker.request("/api/leads/1/attachments")); assert.equal(files.canUpload, true);
    assert.equal((await json<AttachmentList>(await viewer.request("/api/leads/1/attachments"))).canUpload, false);
    assert.equal((await viewer.upload(1, files.version, "denied.txt", "Synthetic denied upload")).status, 403);
    assert.equal((await worker.upload(1, files.version, "synthetic.png", "This is not a PNG", "image/png")).status, 415);
    assert.equal((await worker.upload(1, files.version, "active.pdf", syntheticActionPdf("/S /Named /N /Print"), "application/pdf")).status, 415);
    assert.deepEqual(await json<AttachmentList>(await worker.request("/api/leads/1/attachments")), files);
    assert.equal((await worker.upload(1, files.version, "synthetic.txt", "Synthetic upload", "text/plain", { "X-CSRF-Token": "wrong" })).status, 403);
    const upload = await json<{ id: string; version: number }>(await worker.upload(1, files.version, "synthetic.txt", htmlFixture));
    assert.equal((await worker.upload(1, files.version, "stale.txt", "Synthetic stale upload")).status, 409);
    files = await json<AttachmentList>(await manager.request("/api/leads/1/attachments")); assert.equal(files.total, 1);
    const download = await worker.request(`/api/attachments/${upload.id}`);
    assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff"); assert.match(download.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(await download.text(), htmlFixture);
    assert.equal((await anonymous.request(`/api/attachments/${upload.id}`)).status, 401);
    assert.equal((await other.request(`/api/attachments/${upload.id}`)).status, 404);
    assert.equal((await worker.request(`/api/attachments/${upload.id}?download=1`)).status, 400);
    currentCheck = "static GIF private task upload, malformed content, CSRF and protected download";
    assert.equal((await worker.upload(1, files.version, "synthetic.gif", syntheticGif(), "image/png")).status, 415);
    assert.equal((await worker.upload(1, files.version, "synthetic.gif", Buffer.concat([syntheticGif(), Buffer.from("trailing content")]), "image/gif")).status, 415);
    assert.equal((await worker.upload(1, files.version, "synthetic.gif", syntheticGif(), "image/gif", { "X-CSRF-Token": "wrong" })).status, 403);
    const gifUpload = await json<{ id: string; version: number }>(await worker.upload(1, files.version, "synthetic.gif", syntheticGif(), "image/gif"));
    const gifDownload = await worker.request(`/api/attachments/${gifUpload.id}`);
    assert.equal(gifDownload.status, 200); assert.equal(gifDownload.headers.get("content-type"), "image/gif");
    assert.match(gifDownload.headers.get("content-disposition") ?? "", /^attachment;/); assert.match(gifDownload.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(Buffer.from(await gifDownload.arrayBuffer()), syntheticGif());
    assert.equal((await other.request(`/api/attachments/${gifUpload.id}`)).status, 404);
    assert.equal((await anonymous.request(`/api/attachments/${gifUpload.id}`)).status, 401);
    files = await json<AttachmentList>(await manager.request("/api/leads/1/attachments")); assert.equal(files.total, 2);
    currentCheck = "unassignment and reassignment revoke current worker logs and attachment access while retaining history";
    assigned = await json<JobAssignments>(await manager.mutate("/api/jobs/1/unassign", { expectedVersion: files.version, department: "Electrical" }));
    assert.equal(assigned.assignments[0]!.userId, null);
    for (const path of [departmentUrl, departmentUrl + "/logs", `/api/attachments/${upload.id}`]) assert.equal((await worker.request(path)).status, 404);
    assert.equal((await worker.request(logFilePath)).status, 404);
    assigned = await json<JobAssignments>(await manager.mutate(assignmentUrl, { expectedVersion: assigned.version, assignments: [{ department: "Electrical", userId: "4" }] }));
    assert.equal((await json<Page<WorkLog>>(await other.request(departmentUrl + "/logs"))).total, 1);
    assert.equal((await other.request(`/api/attachments/${upload.id}`)).status, 200);
    assert.equal((await other.request(logFilePath)).status, 200);
    assigned = await json<JobAssignments>(await manager.mutate("/api/jobs/1/accounts", { expectedVersion: assigned.version, userId: "2" }));
    assert.equal(assigned.accounts!.userId, "2");
    assigned = await json<JobAssignments>(await manager.mutate(assignmentUrl, { expectedVersion: assigned.version, assignments: [{ department: "Electrical", userId: "3" }] }));
    currentCheck = "employee report exact fixture totals, dates, paging, search, denial and safe errors";
    const reportPath = "/api/reports/employee-performance?dateFrom=2000-01-01&dateTo=2000-01-31";
    for (const caller of [denied, worker, viewer]) assert.equal((await caller.request(reportPath)).status, 403);
    const report = await json<PerformanceReport>(await manager.request(reportPath + "&pageSize=2"));
    assert.equal(report.summary.totalDeals, 3); assert.equal(report.summary.wonJobs, 2); assert.equal(report.summary.wonAmount, "30.75");
    assert.equal(report.summary.activeEmployees, 5); assert.equal(report.employees.total, 5); assert.equal(report.employees.items.length, 2);
    assert.equal((await json<PerformanceReport>(await manager.request(reportPath + "&query=electrician"))).employees.total, 2);
    assert.equal((await manager.request("/api/reports/employee-performance?dateFrom=2000-02-30")).status, 400);
    assert.equal((await manager.request(reportPath, { headers: { Origin: "https://invalid.example" } })).status, 403);
    assert.equal((await manager.mutate("/api/reports/employee-performance", {})).status, 405);
    currentCheck = "XLSX job export exact rows, scoped access, downloads and formula-safe text";
    async function workbook(response: Response) {
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
      assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
      assert.ok(archive["[Content_Types].xml"]); assert.ok(archive["xl/workbook.xml"]); assert.ok(archive["xl/worksheets/sheet1.xml"]);
      const worksheet = strFromU8(archive["xl/worksheets/sheet1.xml"]!); assert(!worksheet.includes("<f>")); return worksheet;
    }
    const allSheet = await workbook(await manager.request("/api/jobs/export"));
    assert.equal((allSheet.match(/<row r=/g) ?? []).length, 3); assert(allSheet.includes("=1+1"));
    const ownSheet = await workbook(await worker.request("/api/departments/Electrical/export"));
    assert.equal((ownSheet.match(/<row r=/g) ?? []).length, 2); assert(ownSheet.includes("WF-1")); assert(!ownSheet.includes("WF-2"));
    assert.equal(((await workbook(await other.request("/api/departments/Electrical/export"))).match(/<row r=/g) ?? []).length, 1);
    assert.equal((await anonymous.request("/api/jobs/export")).status, 401);
    assert.equal((await denied.request("/api/jobs/export")).status, 403);
    assert.equal((await worker.request("/api/jobs/export")).status, 403);
    assert.equal((await manager.request("/api/departments/Electrical/export")).status, 403);
    assert.equal((await worker.request("/api/departments/Electrical/export?userId=4")).status, 400);
    currentCheck = "Chromium manager assignments and employee report filters";
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(); const runtimeErrors: string[] = []; page.on("pageerror", (error) => runtimeErrors.push(error.name));
    currentCheck = "independent Chromium GIF decoding across dictionary width and reset boundaries";
    const decodedGifs = await page.evaluate(async (fixtures) => {
      const result = [];
      for (const bytes of fixtures) {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/gif" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), graphics = canvas.getContext("2d")!;
        graphics.drawImage(bitmap, 0, 0); const pixels = graphics.getImageData(0, 0, bitmap.width, bitmap.height).data;
        if (bitmap.width === 2731) {
          for (let pixel = 0; pixel < 8193; pixel++) {
            const color = (pixel === 8192 || pixel % 2) ? 255 : 0;
            if (pixels[pixel * 4] !== color || pixels[pixel * 4 + 1] !== color || pixels[pixel * 4 + 2] !== color || pixels[pixel * 4 + 3] !== 255) throw new Error("Synthetic GIF decoding mismatch.");
          }
        }
        result.push({ width: bitmap.width, height: bitmap.height, first: [...pixels.slice(0, 4)], second: [...pixels.slice(4, 8)], last: [...pixels.slice(-4)] });
        bitmap.close();
      }
      return result;
    }, [syntheticGif(), gifWithCodes(4, 1, [[4, 3], [0, 3], [1, 3], [6, 3], [5, 4]]),
      gifWithCodes(3, 1, [[4, 3], [0, 3], [6, 3], [5, 3]], true), syntheticLargeGif()].map((value) => [...value]));
    assert.deepEqual(decodedGifs, [
      { width: 1, height: 1, first: [0, 0, 0, 255], second: [], last: [0, 0, 0, 255] },
      { width: 4, height: 1, first: [0, 0, 0, 255], second: [255, 255, 255, 255], last: [255, 255, 255, 255] },
      { width: 3, height: 1, first: [0, 0, 0, 255], second: [0, 0, 0, 255], last: [0, 0, 0, 255] },
      { width: 2731, height: 3, first: [0, 0, 0, 255], second: [255, 255, 255, 255], last: [255, 255, 255, 255] },
    ]);
    async function browserLogin(id: number) {
      await page.goto(base + "/login"); await page.getByLabel("Email").fill(`workflow-${id}@example.test`); await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.origin === base && ["/account", "/dashboard"].includes(url.pathname));
    }
    await browserLogin(1); await page.goto(base + "/jobs/2");
    await page.getByLabel("Assignment department", { exact: true }).selectOption("Electrical");
    await page.getByLabel("Assignment user", { exact: true }).selectOption("3");
    await Promise.all([page.waitForResponse((r) => r.url() === base + "/api/jobs/2/assignments" && r.request().method() === "POST" && r.status() === 200),
      page.getByRole("button", { name: "Assign department", exact: true }).click()]);
    await page.goto(base + "/jobs");
    const managerExport = page.waitForEvent("download"); await page.getByRole("link", { name: "Export jobs (XLSX)", exact: true }).click();
    assert.match((await managerExport).suggestedFilename(), /^All_Jobs_.*\.xlsx$/);
    await page.goto(base + "/reports/employee-performance"); await page.getByLabel("From date").fill("2000-01-01"); await page.getByLabel("To date").fill("2000-01-31");
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/reports/employee-performance?") && r.url().includes("dateFrom=2000-01-01") && r.status() === 200),
      page.getByRole("button", { name: "Apply dates", exact: true }).click()]);
    await page.getByRole("region", { name: "Report summary", exact: true }).waitFor();
    await page.getByLabel("Search report employees", { exact: true }).fill("electrician");
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/reports/employee-performance?") && r.url().includes("query=electrician") && r.status() === 200),
      page.getByRole("region", { name: "Employee results", exact: true }).getByRole("button", { name: "Search", exact: true }).click()]);
    const employeeResults = page.getByRole("region", { name: "Employee results", exact: true });
    await employeeResults.getByText("Workflow manager fixture", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await employeeResults.getByRole("row").count(), 3);
    await page.screenshot({ path: desktopScreenshot, fullPage: true });
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(base + "/login");
    currentCheck = "Chromium worker text log, status persistence and protected upload/download";
    await browserLogin(3); await page.goto(base + "/departments/Electrical/jobs/2");
    await page.getByLabel("Authority", { exact: true }).selectOption("DESIGN");
    await page.getByLabel("Log status", { exact: true }).selectOption("DOCUMENTS PENDING");
    await page.getByLabel("Authority comments", { exact: true }).fill("Synthetic browser authority comment");
    await page.getByLabel("Work notes", { exact: true }).fill(htmlFixture);
    await page.getByLabel("Work log attachment (optional)", { exact: true }).setInputFiles({ name: "browser-log.gif", mimeType: "image/gif", buffer: syntheticGif() });
    await Promise.all([page.waitForResponse((r) => r.url() === base + "/api/departments/Electrical/jobs/2/logs" && r.request().method() === "POST" && r.status() === 200),
      page.getByRole("button", { name: "Add work log", exact: true }).click()]);
    await page.getByText(htmlFixture, { exact: true }).waitFor();
    const browserLogDownload = page.waitForEvent("download");
    await page.getByRole("region", { name: "Work log history", exact: true }).getByRole("link", { name: "browser-log.gif", exact: true }).click();
    const savedLogDownload = await browserLogDownload;
    assert.equal(savedLogDownload.suggestedFilename(), "browser-log.gif");
    const downloadedStream = await savedLogDownload.createReadStream(); assert.ok(downloadedStream);
    const downloadedParts: Buffer[] = []; for await (const part of downloadedStream) downloadedParts.push(Buffer.from(part));
    assert.deepEqual(Buffer.concat(downloadedParts), syntheticGif());
    assert.equal(await page.evaluate(() => Reflect.get(globalThis, "__workflowXss")), undefined);
    await page.getByLabel("Department status", { exact: true }).selectOption("Completed");
    await Promise.all([page.waitForResponse((r) => r.url() === base + "/api/departments/Electrical/jobs/2/status" && r.request().method() === "PATCH" && r.status() === 200),
      page.getByRole("button", { name: "Save department status", exact: true }).click()]);
    await page.reload(); await page.getByText(htmlFixture, { exact: true }).waitFor();
    assert.equal((await json<DepartmentJob>(await worker.request("/api/departments/Electrical/jobs/2"))).assignment.status, "Completed");
    await page.getByLabel("Department status", { exact: true }).selectOption("Process");
    await Promise.all([page.waitForResponse((r) => r.url() === base + "/api/departments/Electrical/jobs/2/status" && r.status() === 200),
      page.getByRole("button", { name: "Save department status", exact: true }).click()]);
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/leads/2/attachments?") && r.status() === 200),
      page.getByRole("button", { name: "Refresh attachments", exact: true }).click()]);
    await page.getByLabel("Attachment file", { exact: true }).setInputFiles({ name: "browser-fixture.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic browser attachment") });
    await Promise.all([page.waitForResponse((r) => r.url() === base + "/api/leads/2/attachments" && r.request().method() === "POST" && r.status() === 200),
      page.getByRole("button", { name: "Upload attachment", exact: true }).click()]);
    const downloaded = page.waitForEvent("download"); await page.getByRole("link", { name: "browser-fixture.txt", exact: true }).click();
    assert.equal((await downloaded).suggestedFilename(), "browser-fixture.txt");
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Department detail overflows mobile viewport.");
    await page.screenshot({ path: mobileScreenshot, fullPage: true });
    await page.goto(base + "/departments/Electrical/jobs"); await page.getByRole("link", { name: "Workflow other won job", exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Department queue overflows mobile viewport.");
    const workerExport = page.waitForEvent("download"); await page.getByRole("link", { name: "Export assigned jobs (XLSX)", exact: true }).click();
    assert.match((await workerExport).suggestedFilename(), /^Electrical_Jobs_.*\.xlsx$/);
    assert.deepEqual(runtimeErrors, []);
    currentCheck = "fresh grant revocation and persisted SQLite audit integrity";
    database.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=3").run();
    assert.equal((await worker.request(departmentUrl)).status, 403);
    assert.equal((await worker.request(`/api/attachments/${upload.id}`)).status, 404);
    assert.equal((await worker.request(`/api/attachments/${gifUpload.id}`)).status, 404);
    assert.equal((await worker.request(logFilePath)).status, 404);
    assert.equal((await worker.request("/api/departments/Electrical/export")).status, 403);
    assert.deepEqual(database.pragma("foreign_key_check"), []); assert.deepEqual(database.pragma("quick_check"), [{ quick_check: "ok" }]);
    assert((database.prepare("SELECT COUNT(*) AS n FROM crm_department_audit_events").get() as { n: number }).n >= 10);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM crm_department_log_attachments").get() as { n: number }).n, 2);
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM crm_department_log_attachment_audit_events").get() as { n: number }).n, 2);
    console.log("PASS: Workflow HTTP assignment/reassignment/unassignment/accounts, worker logs/statuses, persistence, version conflicts, permissions, IDOR, CSRF and audit integrity.");
    console.log("PASS: Employee report HTTP fixture counts, exact amounts, date/search/paging and access controls; protected upload/download byte checks, file-type rejection and revoked access; scoped XLSX worksheet rows and formula-safe text.");
    console.log("PASS: Chromium manager assignment, report date/search, worker logs/status reload, escaped text, protected upload/download, manager/worker XLSX downloads and 390px department layouts; no runtime errors.");
    console.log("PASS: Atomic private log-file multipart uploads, protected byte-for-byte downloads, log/department relation, task-file separation, rejected spoofed/duplicate fields and revoked former-author/grant access; Chromium log-specific upload/download.");
    console.log("PASS: Static GIF content/MIME/CSRF rejection, private HTTP task upload/download, Chromium log-file byte-preserving upload/download, and independent Chromium pixel decoding through full LZW dictionary/reset boundaries.");
    console.log("PASS: Active PDF action annotations, including escaped names, return 415 for task and log uploads without creating records or changing parent versions.");
    console.log(`Synthetic screenshots: ${desktopScreenshot}; ${mobileScreenshot}`);
  } finally {
    await browser?.close().catch(() => { /* Complete owned resource cleanup. */ });
    if (child?.exitCode === null) child.kill(); if (exited) await exited; database?.close();
    const target = realpathSync(directory); assert.equal(dirname(target), resolve(testRoot)); assert.equal(target, resolve(directory)); rmSync(target, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  console.error(`Workflow HTTP/browser verification failed during ${currentCheck}. No real CRM data was used.`);
  if (error instanceof assert.AssertionError && typeof error.actual === "number" && typeof error.expected === "number") console.error(`Numeric assertion: expected ${error.expected}, received ${error.actual}.`);
  process.exitCode = 1;
});
