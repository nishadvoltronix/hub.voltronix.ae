import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { privateAccess } from "../scripts/mysql-auth/files.js";
import { acknowledgement, access, backendRoot, demoConfiguration, openDemo, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";
import { captureChildEnvironment, settleCapturePage } from "./ui-capture.js";
import { refusal } from "./approved-role-browser.js";

const origin = "http://127.0.0.1:3001";
const baselineBackup = "crm-demo-5feb1631-c567-4693-a597-f5c0177ba822.sqlite";
const partialReceipt = "approved-role-writes-9842f8c2-3d03-428a-95af-de6319905f33";
const marker = "CRM SQLite authorized local acceptance 2026-10-13 task 7";
export const workerPlan = [
  { department: "Electrical", id: "6", grant: "electrical.manage", selection: "DESIGN", status: "DRAWING PREPARATION" },
  { department: "Civil", id: "7", grant: "civil.manage", selection: "DESIGN", status: "DRAWING PREPARATION" },
  { department: "PM", id: "8", grant: "project_manager.manage", selection: "Electrical Panel Works", status: "Process" },
  { department: "Switchgear", id: "9", grant: "switchgear.manage", selection: "Panel Design and Engineering", status: "Process" },
  { department: "Maintenance", id: "10", grant: "maintenance.manage", selection: "Preventive Maintenance Works", status: "Process" },
] as const;
export const retainedFilePlan = {
  worker: { name: "crm-local-acceptance-user6-task7-20261013.txt", mimeType: "text/plain", buffer: Buffer.from("CRM SQLite role acceptance only. user=6 task=7 date=2026-10-13\n") },
  restrictive: { name: "crm-local-acceptance-user5-task4-20261013.txt", mimeType: "text/plain", buffer: Buffer.from("CRM SQLite role acceptance only. user=5 task=4 date=2026-10-13\n") },
  log: { name: "crm-local-acceptance-user6-task7-20261013.gif", mimeType: "image/gif", buffer: Buffer.from("47494638376101000100800000000000ffffff2c00000000010001000002024401003b", "hex") },
};
export function permittedRoleWriteRequest(value: string, method: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || /%(?:2e|2f|5c|00)|\\/i.test(url.pathname)) return false;
    if (["GET", "HEAD"].includes(method)) return true;
    if (method === "POST") return ["/api/auth/login", "/api/auth/logout", "/api/jobs/7/assignments", "/api/leads/7/attachments", "/api/leads/4/attachments"].includes(url.pathname)
      || /^\/api\/departments\/(?:Electrical|Civil|PM|Switchgear|Maintenance)\/jobs\/7\/logs$/.test(url.pathname);
    return method === "PATCH" && /^\/api\/departments\/(?:Electrical|Civil|PM|Switchgear|Maintenance)\/jobs\/7\/status$/.test(url.pathname);
  } catch { return false; }
}
type Row = Record<string, unknown>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function snapshot() {
  const db = openDemo(true);
  try {
    return db.transaction(() => {
      const tables: Record<string, { count: number; digest: string; rows: Record<string, string> }> = {};
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string }[]) {
        assert.match(name, /^[a-z_]+$/);
        const rows = db.prepare(`SELECT rowid AS __rowid,* FROM "${name}" ORDER BY rowid`).all() as Row[];
        tables[name] = { count: rows.length, digest: digest(rows), rows: Object.fromEntries(rows.map(row => [String(row.__rowid), digest(row)])) };
      }
      const tasks = db.prepare("SELECT * FROM tasks WHERE id IN(4,7) ORDER BY id").all() as Row[];
      const owner = db.prepare("SELECT * FROM crm_sessions WHERE user_id=15 ORDER BY created_at").all() as Row[];
      const taskVersions = tasks.map(row => ({ id: row.id, version: row.version, status: row.status, jobStatus: row.Job_Status }));
      const taskStableHashes = tasks.map(row => ({ id: row.id, digest: digest(Object.fromEntries(Object.entries(row).filter(([key]) => !["version", "updated_at"].includes(key)))) }));
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok"); assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
      return { checkedAtUtc: new Date().toISOString(), tables, ownerSessionHash: digest(owner), ownerSessionCount: owner.length,
        taskVersions, taskStableHashes, activeUsers: (db.prepare("SELECT COUNT(*) n FROM users WHERE status='active'").get() as { n: number }).n,
        assignments: db.prepare("SELECT id,task_id,user_id,department,status,assigned_by,version FROM departments_assign WHERE task_id=7 ORDER BY id").all() as Row[],
        logs: db.prepare("SELECT id,task_id,department,assignment_id,actor_user_id,authority,scope,status,comments,notes,created_at FROM crm_department_work_logs WHERE task_id=7 ORDER BY id").all() as Row[],
        files: db.prepare("SELECT id,task_id,uploaded_by,file_name,file_size,media_type,content_sha256 FROM task_attachment WHERE task_id IN(4,7) ORDER BY id").all() as Row[],
        logFiles: db.prepare("SELECT f.id,f.log_id,f.file_name,f.file_size,f.media_type,f.content_sha256 FROM crm_department_log_attachments f JOIN crm_department_work_logs l ON l.id=f.log_id WHERE l.task_id=7 ORDER BY f.id").all() as Row[],
        departmentAudit: db.prepare("SELECT * FROM crm_department_audit_events WHERE task_id=7 ORDER BY id").all() as Row[],
        attachmentAudit: db.prepare("SELECT * FROM crm_attachment_audit_events WHERE task_id IN(4,7) ORDER BY id").all() as Row[],
        logAttachmentAudit: db.prepare("SELECT * FROM crm_department_log_attachment_audit_events ORDER BY id").all() as Row[] };
    })();
  } finally { db.close(); }
}
type Snapshot = ReturnType<typeof snapshot>;
type Receipt = { status: "PASS" | "FAIL"; directory: string; startedAt: string; finishedAt?: string; scope: string; backup: string;
  checks: { name: string; status: "PASS" | "FAIL"; detail?: string }[]; screenshots: string[];
  observations: { logins: number; logouts: number; pageErrors: number; blockedRequests: number; successfulWrites: number };
  plan: unknown; baseline?: Snapshot; final?: Snapshot };
async function json(page: Page, path: string, method = "GET", body?: unknown, csrf = true) {
  assert.ok(permittedRoleWriteRequest(origin + path, method));
  return page.evaluate(async ({ path, method, body, csrf }) => {
    let token: string | undefined;
    if (method !== "GET" && csrf) token = ((await (await fetch("/api/auth/csrf")).json()) as { csrfToken: string }).csrfToken;
    const response = await fetch(path, { method, credentials: "same-origin", redirect: "error",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { "X-CSRF-Token": token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { path, method, body, csrf });
}
async function mutate(page: Page, path: string, method: string, action: () => Promise<unknown>, receipt: Receipt, status = 200) {
  assert.ok(permittedRoleWriteRequest(origin + path, method));
  const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === method), action()]);
  assert.equal(response.status(), status); receipt.observations.successfulWrites++; await response.finished(); await settleCapturePage(page);
}
async function verifyFile(context: BrowserContext, id: string, bytes: Buffer, log = false) {
  assert.match(id, /^[a-f0-9-]{36}$/);
  for (const host of [origin, "http://127.0.0.1:3002"]) for (const suffix of ["", "/preview"]) {
    const path = `${host}${host === origin ? "/api" : "/api/v1"}/${log ? "log-attachments" : "attachments"}/${id}${suffix}`;
    const response = await context.request.get(path, { maxRedirects: 0 }); assert.equal(response.status(), 200); assert.deepEqual(await response.body(), bytes);
    if (suffix) assert.match(response.headers()["content-security-policy"] ?? "", /sandbox/);
    assert.match(response.headers()["cache-control"] ?? "", /private|no-store/);
    const head = await context.request.head(path, { maxRedirects: 0 }); assert.equal(head.status(), 200); assert.equal((await head.body()).length, 0);
  }
}
export async function runApprovedRoleWrites(): Promise<Receipt> {
  demoConfiguration(process.env);
  const fixture = access().fixture;
  const priorPath = join(privateDirectory(["evidence"]), partialReceipt, "receipt.json");
  const prior = existsSync(priorPath) ? readPrivate(priorPath) as Receipt : undefined;
  assert.equal(fixture.identities.operator.id, "1"); assert.equal(fixture.identities.contracting.id, "4"); assert.equal(fixture.identities.switchgear.id, "5");
  const directory = privateDirectory(["evidence", "approved-role-writes-" + randomUUID()], true);
  const result: Receipt = { status: "FAIL", directory, startedAt: new Date().toISOString(), backup: baselineBackup,
    scope: "Account Owner authorization 2026-10-13: task7 worker assignments/status/log/file; user5 task4 own file; user4 refusal. Existing accounts/grants/history preserved.",
    checks: [], screenshots: [], observations: { logins: 0, logouts: 0, pageErrors: 0, blockedRequests: 0, successfulWrites: 0 },
    plan: { assignmentActor: 1, workers: workerPlan, transitions: ["Assigned -> Process", "Process -> Completed", "Completed -> Process"], marker, resumedFrom: prior ? partialReceipt : null,
      files: Object.fromEntries(Object.entries(retainedFilePlan).map(([key, value]) => [key, { name: value.name, mediaType: value.mimeType, bytes: value.buffer.length, sha256: createHash("sha256").update(value.buffer).digest("hex") }])), retained: true, noAccountOrGrantChanges: true } };
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, signedIn = false, current = "Preflight";
  const check = async (name: string, action: () => Promise<void>) => {
    current = name; try { await action(); result.checks.push({ name, status: "PASS" }); }
    catch { result.checks.push({ name, status: "FAIL", detail: "Sanitized failure; retained evidence. Do not repeat completed mutations." }); throw new Error(name); }
  };
  const login = async (identity: { id: string; email: string; password: string }, grant?: string) => {
    context = await browser!.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(20_000);
    await context.route("**/*", route => { if (permittedRoleWriteRequest(route.request().url(), route.request().method())) return route.continue(); result.observations.blockedRequests++; return route.abort("blockedbyclient"); });
    await context.routeWebSocket("**/*", socket => { result.observations.blockedRequests++; socket.close(); });
    page = await context.newPage(); page.on("pageerror", () => { result.observations.pageErrors++; });
    await page.goto(origin + "/login"); await page.getByLabel("Email address", { exact: true }).fill(identity.email); await page.getByLabel("Password", { exact: true }).fill(identity.password);
    result.observations.logins++; await page.getByRole("button", { name: /^(Login|Sign in)$/ }).click(); await page.waitForURL(url => url.origin === origin && ["/account", "/dashboard"].includes(url.pathname)); signedIn = true;
    const me = await json(page, "/api/auth/me"); assert.equal(me.status, 200);
    const user = me.body.user as { localUserId: string; permissions: string[] }; assert.equal(user.localUserId, identity.id); if (grant) assert.ok(user.permissions.includes(grant));
  };
  const logout = async () => {
    assert.ok(page); await page.goto(origin + "/account"); await page.getByRole("button", { name: "User menu", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(origin + "/login"); result.observations.logouts++; signedIn = false;
    assert.equal((await json(page, "/api/auth/me")).status, 401); await context!.close(); context = undefined; page = undefined;
  };
  const captures = async (label: string) => {
    for (const width of [1440, 768, 390]) {
      await page!.setViewportSize({ width, height: width === 1440 ? 1000 : 900 }); await settleCapturePage(page!);
      await page!.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
      await settleCapturePage(page!);
      assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
      const filename = `${label}-${width}.png`; await page!.screenshot({ path: join(directory, filename), fullPage: true, animations: "disabled" }); privateAccess(join(directory, filename), false); result.screenshots.push(filename);
    }
    await page!.setViewportSize({ width: 1440, height: 1000 });
  };
  try {
    await check("Exact task7/task4 and verified backup preflight", async () => {
      assert.ok(existsSync(join(privateDirectory(["backups"]), baselineBackup)));
      const actual = snapshot();
      if (prior) {
        assert.equal(prior.status, "FAIL"); assert.ok(prior.final); assert.ok(prior.baseline);
        assert.equal(prior.checks.filter(row => row.status === "FAIL").length, 1);
        assert.equal(prior.checks.find(row => row.status === "FAIL")?.name, "Electrical task7 one inert task file and both-service download preview GET HEAD");
        assert.deepEqual(actual.tables, prior.final.tables); assert.equal(actual.ownerSessionHash, prior.final.ownerSessionHash);
        assert.equal(actual.taskVersions.find(row => row.id === 7)?.version, 22); assert.equal(actual.assignments.length, 5); assert.equal(actual.logs.length, 1); assert.equal(actual.files.length, 2);
        result.baseline = prior.baseline;
      } else result.baseline = actual;
      assert.equal(result.baseline.activeUsers, 15); assert.equal(result.baseline.ownerSessionCount, 1);
      assert.equal(result.baseline.assignments.length, 0); assert.equal(result.baseline.logs.length, 0);
      assert.equal(result.baseline.files.filter(row => row.task_id === 4).length, 0);
      assert.deepEqual(result.baseline.taskVersions, [{ id: 4, version: 1, status: "Proposal/Price Quote", jobStatus: null }, { id: 7, version: 12, status: "Closed Won", jobStatus: "Active" }]);
      writePrivateNew(join(directory, "approved-plan.json"), { ...result, baseline: result.baseline });
    });
    browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string>, args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"] });
    if (!prior) {
    await check("Manager1 normal login and source dashboard authority", () => login(fixture.identities.operator, "dashboard.view"));
    await check("Manager appends only five task7 department assignments through UI", async () => {
      await page!.goto(origin + "/jobs/7"); await settleCapturePage(page!);
      for (const worker of workerPlan) {
        assert.equal(fixture.identities.workers[worker.department].id, worker.id);
        await page!.getByLabel("Assignment department", { exact: true }).selectOption(worker.department);
        await page!.getByLabel("Assignment user", { exact: true }).selectOption(worker.id);
        await mutate(page!, "/api/jobs/7/assignments", "POST", () => page!.getByRole("button", { name: "Assign department", exact: true }).click(), result);
      }
      const assigned = await json(page!, "/api/jobs/7/assignments"); assert.equal(assigned.status, 200);
      assert.equal((assigned.body.assignments as Row[]).length, 5); await captures("task7-assignments");
    });
    await check("Manager normal logout preserves owner session", logout);
    }
    let logFileId = "", workerFileId = "", restrictiveFileId = "";
    for (const worker of workerPlan) {
      const path = `/api/departments/${worker.department}/jobs/7`;
      await check(`${worker.department} existing worker login and exact role`, () => login(fixture.identities.workers[worker.department], worker.grant));
      if (prior && worker.id === "6") {
        await check("Electrical retained log and task file exact bytes; no repeated mutation", async () => {
          const logs = await json(page!, path + "/logs?page=1&pageSize=25"); assert.equal(logs.status, 200); const rows = logs.body.items as Row[]; assert.equal(rows.length, 1);
          logFileId = String((rows[0]!.attachment as Row).id); await verifyFile(context!, logFileId, retainedFilePlan.log.buffer, true);
          const files = await json(page!, "/api/leads/7/attachments?page=1&pageSize=25"); assert.equal(files.status, 200);
          const own = (files.body.items as Row[]).find(row => row.name === retainedFilePlan.worker.name); assert.ok(own); workerFileId = String(own.id);
          await verifyFile(context!, workerFileId, retainedFilePlan.worker.buffer);
        });
        await check("Electrical resumed normal logout", logout); continue;
      }
      await check(`${worker.department} assigned queue, browser detail, CSRF and stale-version refusals`, async () => {
        const queue = await json(page!, `/api/departments/${worker.department}/jobs?status=Assigned&page=1&pageSize=25`); assert.equal(queue.status, 200); assert.ok((queue.body.items as Row[]).some(row => row.id === "7"));
        await page!.goto(origin + `/departments/${worker.department}/jobs/7`); await settleCapturePage(page!);
        await page!.getByRole("tab", { name: worker.department === "PM" ? "Project Manager" : worker.department, exact: true }).click();
        const detail = await json(page!, path); assert.equal(detail.status, 200);
        const noCsrf = await json(page!, path + "/status", "PATCH", { expectedVersion: detail.body.version, status: "Process" }, false); assert.equal(noCsrf.status, 403);
        const stale = await json(page!, path + "/status", "PATCH", { expectedVersion: 1, status: "Process" }); assert.equal(stale.status, 409);
        assert.equal((await json(page!, "/api/settings/users")).status, 403);
      });
      await check(`${worker.department} Assigned to Process through versioned UI`, async () => {
        await page!.getByRole("button", { name: "Update Status", exact: true }).click();
        await page!.getByLabel("Department status", { exact: true }).selectOption("Process");
        await mutate(page!, path + "/status", "PATCH", () => page!.getByRole("button", { name: "Save department status", exact: true }).click(), result);
      });
      await check(`${worker.department} one marked source-valid log${worker.id === "6" ? " with inert GIF" : ""}`, async () => {
        await page!.getByLabel(["Electrical", "Civil"].includes(worker.department) ? "Authority" : "Scope of work", { exact: true }).selectOption(worker.selection);
        await page!.getByLabel("Log status", { exact: true }).selectOption(worker.status);
        if (["Electrical", "Civil"].includes(worker.department)) await page!.getByLabel("Authority comments", { exact: true }).fill(marker + " synthetic comments");
        await page!.getByLabel("Work notes", { exact: true }).fill(marker + " department=" + worker.department);
        if (worker.id === "6") await page!.getByLabel("Work log attachment (optional)", { exact: true }).setInputFiles(retainedFilePlan.log);
        await mutate(page!, path + "/logs", "POST", () => page!.getByRole("button", { name: "Add work log", exact: true }).click(), result);
        const logs = await json(page!, path + "/logs?page=1&pageSize=25"); assert.equal(logs.status, 200); const values = logs.body.items as Row[]; assert.equal(values.length, 1);
        assert.equal(values[0]!.notes, marker + " department=" + worker.department);
        if (worker.id === "6") { logFileId = String((values[0]!.attachment as Row).id); await verifyFile(context!, logFileId, retainedFilePlan.log.buffer, true); }
      });
      await check(`${worker.department} Completed then Process reopen and persisted log`, async () => {
        for (const state of ["Completed", "Process"]) {
          await page!.getByRole("button", { name: "Update Status", exact: true }).click();
          await page!.getByLabel("Department status", { exact: true }).selectOption(state);
          await mutate(page!, path + "/status", "PATCH", () => page!.getByRole("button", { name: "Save department status", exact: true }).click(), result);
          if (state === "Completed") assert.equal(await page!.getByRole("button", { name: "Add work log", exact: true }).isDisabled(), true);
        }
        await page!.reload(); await settleCapturePage(page!);
        await page!.getByRole("tab", { name: worker.department === "PM" ? "Project Manager" : worker.department, exact: true }).click();
        assert.equal(await page!.getByLabel("Department status", { exact: true }).inputValue(), "Process");
        await page!.getByRole("region", { name: "Work log history", exact: true }).getByText(marker + " department=" + worker.department, { exact: true }).waitFor();
        await captures("worker-" + worker.department.toLowerCase());
      });
      if (worker.id === "6") await check("Electrical task7 one inert task file and both-service download preview GET HEAD", async () => {
        await page!.getByRole("tab", { name: "Details", exact: true }).click();
        await page!.getByLabel("Attachment file", { exact: true }).setInputFiles(retainedFilePlan.worker);
        await mutate(page!, "/api/leads/7/attachments", "POST", () => page!.getByRole("button", { name: "Upload attachment", exact: true }).click(), result);
        const files = await json(page!, "/api/leads/7/attachments?page=1&pageSize=25"); const item = (files.body.items as Row[]).find(row => row.name === retainedFilePlan.worker.name); assert.ok(item); workerFileId = String(item.id);
        await verifyFile(context!, workerFileId, retainedFilePlan.worker.buffer);
      });
      if (worker.id !== "6") await check(`${worker.department} foreign Electrical log bytes refused through both services`, async () => {
        for (const host of [origin, "http://127.0.0.1:3002"]) for (const suffix of ["", "/preview"]) await refusal(context!, host, `${host === origin ? "/api" : "/api/v1"}/log-attachments/${logFileId}${suffix}`);
      });
      await check(`${worker.department} normal logout`, logout);
    }
    await check("User5 current effective restrictive grants and normal login", async () => {
      await login(fixture.identities.switchgear, "leads.manage.agents"); const me = await json(page!, "/api/auth/me");
      const permissions = (me.body.user as { permissions: string[] }).permissions; assert.equal(permissions.some(value => ["dashboard.view", "users.write", "permissions.manage"].includes(value)), false);
    });
    await check("User5 task4 one approved inert own-file upload and exact-byte access", async () => {
      await page!.goto(origin + "/leads/4"); await settleCapturePage(page!);
      await page!.getByLabel("Attachment file", { exact: true }).setInputFiles(retainedFilePlan.restrictive);
      await mutate(page!, "/api/leads/4/attachments", "POST", () => page!.getByRole("button", { name: "Upload attachment", exact: true }).click(), result);
      const files = await json(page!, "/api/leads/4/attachments?page=1&pageSize=25"); assert.equal(files.status, 200); assert.equal((files.body.items as Row[]).length, 1);
      restrictiveFileId = String((files.body.items as Row[])[0]!.id); await verifyFile(context!, restrictiveFileId, retainedFilePlan.restrictive.buffer); await captures("user5-task4-own-file");
    });
    await check("User5 still refuses task7 worker file and settings", async () => {
      assert.equal((await json(page!, "/api/settings/users")).status, 403);
      for (const host of [origin, "http://127.0.0.1:3002"]) for (const suffix of ["", "/preview"]) await refusal(context!, host, `${host === origin ? "/api" : "/api/v1"}/attachments/${workerFileId}${suffix}`);
    });
    await check("User5 normal logout", logout);
    await check("User4 normal login and new user5/task4 foreign file refused", async () => {
      await login(fixture.identities.contracting, "leads.manage.agents");
      for (const host of [origin, "http://127.0.0.1:3002"]) for (const suffix of ["", "/preview"]) await refusal(context!, host, `${host === origin ? "/api" : "/api/v1"}/attachments/${restrictiveFileId}${suffix}`);
    });
    await check("User4 normal logout", logout);
    assert.equal(result.observations.pageErrors, 0); assert.equal(result.observations.blockedRequests, 0); assert.equal(result.observations.successfulWrites, prior ? 17 : 27);
    result.status = "PASS";
  } catch { if (!result.checks.some(c => c.name === current && c.status === "FAIL")) result.checks.push({ name: current, status: "FAIL", detail: "Sanitized browser failure; no rollback attempted." }); }
  finally {
    if (signedIn) try { await logout(); } catch { result.status = "FAIL"; result.checks.push({ name: "Test session logout", status: "FAIL" }); }
    await context?.close(); await browser?.close();
    try {
      result.final = snapshot(); const before = result.baseline!, after = result.final;
      assert.equal(after.ownerSessionHash, before.ownerSessionHash); assert.equal(after.activeUsers, before.activeUsers); assert.deepEqual(after.taskStableHashes, before.taskStableHashes);
      const appendOnly = new Set(["departments_assign", "crm_department_work_logs", "crm_department_audit_events", "task_attachment", "crm_attachment_audit_events", "crm_department_log_attachments", "crm_department_log_attachment_audit_events"]);
      for (const [table, saved] of Object.entries(before.tables)) {
        if (["crm_sessions", "crm_login_attempts"].includes(table)) continue;
        if (appendOnly.has(table) || table === "tasks") {
          for (const [id, hash] of Object.entries(saved.rows)) if (!(table === "tasks" && ["4", "7"].includes(id))) assert.equal(after.tables[table]!.rows[id], hash, table + " original row " + id);
        } else assert.equal(after.tables[table]!.digest, saved.digest, table);
      }
      if (result.status === "PASS") { assert.equal(after.assignments.length, 5); assert.equal(after.logs.length, 5); assert.equal(after.files.length, 3); assert.equal(after.logFiles.length, 1);
        assert.equal(after.departmentAudit.length - before.departmentAudit.length, 25); assert.equal(after.taskVersions.find(row => row.id === 4)?.version, 2); assert.equal(after.taskVersions.find(row => row.id === 7)?.version, 38); }
      result.checks.push({ name: "Original rows, accounts, grants, file bytes and owner session preserved; only planned task4/task7 deltas", status: "PASS" });
    } catch { result.status = "FAIL"; result.checks.push({ name: "Exact preservation and planned final state", status: "FAIL", detail: "Unexpected delta or incomplete planned state; retain all evidence." }); }
    result.finishedAt = new Date().toISOString(); writePrivateNew(join(directory, "receipt.json"), result);
  }
  return result;
}
const currentFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === currentFile) {
  if (process.argv.length !== 2) { console.error("No arguments or credentials accepted."); process.exitCode = 1; }
  else if (process.env.CRM_SQLITE_DEMO !== acknowledgement) {
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href, currentFile], { cwd: backendRoot, env: captureChildEnvironment(), windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise<number>(resolveExit => { child.once("error", () => resolveExit(1)); child.once("exit", code => resolveExit(code ?? 1)); });
  } else {
    try { const result = await runApprovedRoleWrites(); console.log(JSON.stringify({ status: result.status, receipt: join(result.directory, "receipt.json"), checks: result.checks.length,
      passed: result.checks.filter(c => c.status === "PASS").length, failed: result.checks.filter(c => c.status === "FAIL").length, observations: result.observations, screenshots: result.screenshots.length })); process.exitCode = result.status === "PASS" ? 0 : 1; }
    catch { console.error("Guarded acceptance refused before browser execution; no secrets logged."); process.exitCode = 1; }
  }
}
