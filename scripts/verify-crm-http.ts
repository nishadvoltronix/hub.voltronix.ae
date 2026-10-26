import { assertSqliteReferenceBuild } from "./sqlite-reference-http-guard";
assertSqliteReferenceBuild();
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hashSync } from "bcryptjs";
import { chromium } from "playwright";
import { parseDatabaseConfig } from "../tests/sqlite-reference/config/database";
import { localDirectory, openDatabase, type SqliteDatabase } from "../tests/sqlite-reference/db/connection";
import { migrateDatabase } from "../tests/sqlite-reference/db/migrations";
import type { DashboardResult } from "../tests/sqlite-reference/dashboard/types";
import type { LeadDetail, LeadNote, LeadPage, LeadStatusEvent, PipelineAgent, PipelineResult } from "../tests/sqlite-reference/leads/contracts";
import type { JobPage, JobRecord } from "../tests/sqlite-reference/jobs/contracts";

let currentCheck = "isolated CRM fixture setup";

async function main() {
  const root = realpathSync(process.cwd());
  const testRoot = localDirectory(root, [".local-data", "test"], true);
  const directory = mkdtempSync(join(testRoot, "crm-"));
  const databasePath = relative(root, join(directory, "crm.sqlite"));
  let database: SqliteDatabase | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const password = randomBytes(24).toString("base64url"), storedHash = hashSync(password, 4);
  const htmlFixture = "<script>globalThis.__crmXss=1</script>";

  try {
    database = openDatabase(parseDatabaseConfig({ DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath }, root), { create: true });
    migrateDatabase(database);
    // Explicit synthetic records live only in this unique disposable test file.
    for (const [id, name] of [[1, "CRM broad fixture"], [2, "CRM agent fixture"], [3, "CRM department fixture"],
      [4, "CRM denied fixture"], [5, "CRM unlinked fixture"], [6, "CRM leads-only fixture"], [7, "CRM dashboard-only fixture"]] as const) {
      database.prepare("INSERT INTO users(id,user_id,username,email,password,role) VALUES(?,?,?,?,?,'admin')")
        .run(id, id === 5 ? null : `crm-owner-${id}`, name, `crm-${id}@example.test`, storedHash);
    }
    function grant(id: number, key: string) {
      database!.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
      database!.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
    }
    for (const key of ["dashboard.view", "leads.view"]) grant(1, key);
    for (const key of ["leads.manage.agents", "leads.view", "sales_dashboard.view"]) grant(2, key);
    for (const key of ["electrical.manage", "electric_dashboard.view"]) grant(3, key);
    for (const key of ["leads.manage.agents", "sales_dashboard.view"]) grant(5, key);
    grant(6, "leads.view"); grant(7, "dashboard.view");
    const task = database.prepare(`INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status,account_name,
      service_charge,qual_deal_number,site_deal_number,quote_deal_number,job_deal_number,lost_deal_number,created_at)
      VALUES(?,?,?,?,?,? ,?,'QUAL-FIXTURE','SITE-FIXTURE','QUOTE-FIXTURE','JOB-FIXTURE','LOST-FIXTURE','2000-01-01 00:00:00')`);
    task.run(1, "crm-deal-1", "crm-owner-2", "CRM qualification fixture", "Pending", "Synthetic 100%_ account", "100.001");
    task.run(2, "crm-deal-2", "crm-owner-2", "CRM site fixture", "Site Visit", "Synthetic site account", "200");
    task.run(3, "crm-deal-3", "crm-owner-1", "CRM proposal fixture", "Proposal/Price Quote", "Synthetic proposal account", "300");
    task.run(4, "crm-deal-4", "crm-owner-2", "CRM first won fixture", "Close to Won", "Synthetic won account", "100.50");
    task.run(5, "crm-deal-5", "crm-owner-1", "CRM second won fixture", "Closed Won", "Synthetic completed account", "500");
    task.run(6, "crm-deal-6", "crm-owner-1", "CRM lost fixture", "Omitted", "Synthetic lost account", "600");
    task.run(7, "crm-deal-7", null, "CRM unmatched fixture", "Proposal Omitted", "Synthetic unknown account", null);
    database.prepare(`UPDATE tasks SET customer_name='Synthetic contact',customer_email='synthetic-contact@example.test',
      customer_contact='Synthetic phone',address='Synthetic address',complaint_info=?,notes='Synthetic stored task note',
      assign_notes='Synthetic assignment note',quote_number='synthetic-quote-id' WHERE id=1`).run(htmlFixture);
    database.prepare("INSERT INTO departments_assign(task_id,user_id,department,status,assigned_date) VALUES(4,3,'Electrical','Assigned','2000-01-01 00:00:00'),(5,3,'Civil','Completed','2000-01-01 00:00:00')").run();
    database.prepare("INSERT INTO accounts(task_id,received_amount) VALUES(4,'20.25')").run();
    database.prepare(`INSERT INTO job_notes(deal_id,note_title,note_content,created_at) VALUES
      ('crm-deal-1','Synthetic first note','Synthetic first content','2000-01-01 00:00:00'),
      ('crm-deal-1','Synthetic second note',?,'2000-01-02 00:00:00'),
      ('crm-deal-3','Synthetic foreign note','Foreign fixture content','2000-01-03 00:00:00')`).run(htmlFixture);
    database.prepare(`INSERT INTO tasks_status_log(Task_ID,User_ID,Status,Task_Log_Create_Date) VALUES
      (1,2,'Qualification','2000-01-01 00:00:00'),(1,2,'Site Visit','2000-01-02 00:00:00'),
      (3,1,'Proposal','2000-01-03 00:00:00')`).run();

    const listener = createServer();
    listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const address = listener.address(); assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: root, windowsHide: true, stdio: "ignore",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath, APP_ORIGIN: base },
    });
    exited = once(child, "exit");
    function client() {
      const cookies = new Map<string, string>();
      let csrfToken = "";
      async function request(path: string, options: RequestInit = {}) {
        const headers = new Headers(options.headers);
        headers.set("Cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
        const response = await fetch(base + path, { ...options, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";")[0]!, equals = pair.indexOf("=");
          cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
        }
        return response;
      }
      async function login(id: number) {
        const challenge = await request("/api/auth/csrf"); assert.equal(challenge.status, 200);
        csrfToken = (await challenge.json() as { csrfToken: string }).csrfToken;
        const response = await request("/api/auth/login", { method: "POST", headers: {
          Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrfToken,
        }, body: JSON.stringify({ email: `crm-${id}@example.test`, password }) });
        assert.equal(response.status, 200, "Synthetic CRM login did not succeed.");
        csrfToken = (await response.json() as { csrfToken: string }).csrfToken;
      }
      function mutate(path: string, body: unknown, headers: Record<string, string> = {}) {
        return request(path, { method: "PATCH", headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrfToken, ...headers }, body: JSON.stringify(body) });
      }
      return { request, login, mutate };
    }
    async function json<T>(response: Response, expected = 200): Promise<T> {
      assert.equal(response.status, expected, "Unexpected CRM response status.");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("vary") ?? "", /cookie/i);
      const text = await response.text();
      assert(!text.includes(password) && !text.includes(storedHash), "A CRM response exposed synthetic credentials.");
      return JSON.parse(text) as T;
    }

    currentCheck = "CRM production server startup";
    const deadline = Date.now() + 20_000; let online = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Owned CRM server exited before startup.");
      try { online = (await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ }
      if (online) break;
      await delay(150);
    }
    assert(online, "Production CRM server did not start.");
    const anonymous = client(), broad = client(), agent = client(), department = client(), denied = client(), unlinked = client(), leadOnly = client(), dashboardOnly = client();
    currentCheck = "anonymous and independently permissioned CRM routes";
    for (const path of ["/api/dashboard", "/api/pipeline", "/api/pipeline/agents", "/api/leads/1", "/api/leads/1/notes", "/api/leads/1/history", "/api/jobs", "/api/jobs/4"]) {
      assert.equal((await anonymous.request(path)).status, 401);
    }
    for (const path of ["/dashboard", "/pipeline", "/leads/1", "/jobs", "/jobs/4"]) {
      const response = await anonymous.request(path);
      assert.equal(response.status, 307); assert.equal(response.headers.get("location"), "/login");
    }
    for (const [caller, id] of [[broad, 1], [agent, 2], [department, 3], [denied, 4], [unlinked, 5], [leadOnly, 6], [dashboardOnly, 7]] as const) await caller.login(id);
    assert.equal((await denied.request("/api/dashboard")).status, 403);
    assert.equal((await denied.request("/api/pipeline")).status, 403);
    assert.equal((await denied.request("/api/leads/1")).status, 404);
    for (const path of ["/dashboard", "/pipeline", "/leads/1", "/jobs", "/jobs/4"]) assert.equal((await denied.request(path)).status, 404);
    assert.equal((await leadOnly.request("/dashboard")).status, 404);
    assert.equal((await dashboardOnly.request("/pipeline")).status, 404);
    assert.equal((await leadOnly.request("/api/dashboard")).status, 403);
    assert.equal((await dashboardOnly.request("/api/pipeline")).status, 403);
    assert.equal((await dashboardOnly.request("/api/leads/1")).status, 404);
    assert.equal((await department.request("/api/pipeline")).status, 403);
    assert.equal((await department.request("/api/leads/4")).status, 200);
    assert.equal((await department.request("/api/leads/5")).status, 404);

    currentCheck = "dashboard actual counts, exact money, employee pagination and section isolation";
    const dashboard = await json<DashboardResult>(await broad.request("/api/dashboard?employeePageSize=2"));
    assert.equal(dashboard.timeZone, "Asia/Dubai"); assert(dashboard.global);
    assert.equal(dashboard.global.wonJobs, 2); assert.equal(dashboard.global.pendingAssignmentJobs, 0);
    assert.equal(dashboard.global.completedJobs, 1);
    assert.deepEqual(dashboard.global.accounts, { pendingJobs: 1, totalPending: "80.25", unknownServiceChargeJobs: 0 });
    assert.equal(dashboard.global.leadsToday, 0); assert.equal(dashboard.global.leadsThisMonth, 0);
    assert.equal(dashboard.global.employees.total, 7); assert.equal(dashboard.global.employees.items.length, 2);
    assert.equal(dashboard.global.pipeline.find((stage) => stage.key === "won")?.percentage, "28.57");
    assert.equal(dashboard.sales, undefined); assert.deepEqual(dashboard.departments, []);
    const nextEmployees = await json<DashboardResult>(await broad.request("/api/dashboard?employeePageSize=2&employeePage=2"));
    assert(!nextEmployees.global!.employees.items.some((item) => dashboard.global!.employees.items.some((first) => first.id === item.id)));
    const employeeSearch = await json<DashboardResult>(await broad.request("/api/dashboard?employeeSearch=department"));
    assert.deepEqual(employeeSearch.global!.employees.items.map(({ id, electrical, civil, pm }) => ({ id, electrical, civil, pm })), [{ id: "3", electrical: 1, civil: 1, pm: 0 }]);
    const ownSales = await json<DashboardResult>(await agent.request("/api/dashboard"));
    assert.equal(ownSales.global, undefined); assert.deepEqual(ownSales.departments, []); assert.equal(ownSales.sales!.total, 3);
    const ownDepartment = await json<DashboardResult>(await department.request("/api/dashboard"));
    assert.equal(ownDepartment.global, undefined); assert.equal(ownDepartment.sales, undefined);
    assert.equal(ownDepartment.departments.length, 1); assert.equal(ownDepartment.departments[0]!.department, "Electrical");
    assert.equal(ownDepartment.departments[0]!.total, 1);
    assert.equal((await json<DashboardResult>(await unlinked.request("/api/dashboard"))).sales!.total, 0);
    assert.equal((await agent.request("/api/dashboard?employeeSearch=fixture")).status, 403);

    currentCheck = "pipeline scopes, stage counts, literal search and pagination";
    const pipeline = await json<PipelineResult>(await broad.request("/api/pipeline?pageSize=2"));
    assert.equal(pipeline.total, 7); assert.equal(pipeline.items.length, 2);
    assert.deepEqual(pipeline.counts, { qualification: 1, siteVisit: 1, proposal: 1, won: 2, lost: 1, other: 1 });
    assert.deepEqual(pipeline.items.map(({ id }) => id), ["7", "6"]);
    const secondPage = await json<PipelineResult>(await broad.request("/api/pipeline?pageSize=2&page=2"));
    assert.deepEqual(secondPage.items.map(({ id }) => id), ["5", "4"]);
    assert.equal((await json<PipelineResult>(await broad.request("/api/pipeline?stage=won"))).total, 2);
    assert.equal((await json<PipelineResult>(await broad.request("/api/pipeline?stage=other"))).items[0]!.status, "Proposal Omitted");
    assert.equal((await json<PipelineResult>(await broad.request("/api/pipeline?query=" + encodeURIComponent("100%_")))).total, 1);
    assert.equal((await json<PipelineResult>(await broad.request("/api/pipeline?query=" + encodeURIComponent("' OR 1=1 --")))).total, 0);
    const ownPipeline = await json<PipelineResult>(await agent.request("/api/pipeline"));
    assert.equal(ownPipeline.scope, "own"); assert.equal(ownPipeline.total, 3);
    assert.equal((await json<PipelineResult>(await agent.request("/api/pipeline?agentId=crm-owner-1"))).total, 0);
    assert.equal((await json<PipelineResult>(await unlinked.request("/api/pipeline"))).total, 0);
    assert.equal((await json<PipelineResult>(await broad.request("/api/pipeline?agentId=unassigned"))).total, 1);
    assert.equal((await json<PipelineResult>(await broad.request("/api/pipeline?scope=own"))).total, 3);
    const agents = await json<LeadPage<PipelineAgent>>(await agent.request("/api/pipeline/agents"));
    assert.deepEqual(agents.items, [{ externalId: "crm-owner-2", name: "CRM agent fixture" }]);

    currentCheck = "lead metadata, persisted note/history pages and parent isolation";
    const lead = await json<LeadDetail>(await agent.request("/api/leads/1"));
    assert.equal(lead.id, "1"); assert.equal(lead.serviceCharge, "100.001"); assert.equal(lead.description, htmlFixture);
    assert.equal(lead.customerName, "Synthetic contact"); assert.equal(lead.quoteId, "synthetic-quote-id");
    const notes = await json<LeadPage<LeadNote>>(await agent.request("/api/leads/1/notes?pageSize=1"));
    assert.equal(notes.total, 2); assert.equal(notes.items[0]!.title, "Synthetic second note");
    assert.equal((await json<LeadPage<LeadNote>>(await agent.request("/api/leads/1/notes?pageSize=1&page=2"))).items[0]!.title, "Synthetic first note");
    const history = await json<LeadPage<LeadStatusEvent>>(await agent.request("/api/leads/1/history?pageSize=1"));
    assert.equal(history.total, 2); assert.equal(history.items[0]!.status, "Site Visit"); assert.equal(history.items[0]!.actorId, "2");
    for (const suffix of ["", "/notes", "/history"]) assert.equal((await agent.request("/api/leads/3" + suffix)).status, 404);
    assert.equal((await broad.request("/api/leads/9223372036854775808")).status, 404);

    currentCheck = "CRM strict query validation, cross-origin boundaries and unsupported mutations";
    for (const path of ["/api/pipeline?query=a&query=b", "/api/pipeline?actorId=1", "/api/pipeline?page=01",
      "/api/pipeline?page=0", "/api/pipeline?pageSize=101", "/api/pipeline?stage=unknown",
      "/api/pipeline/agents?scope=all", "/api/pipeline/agents?page=1&page=2", "/api/leads/1?unknown=1",
      "/api/leads/1/notes?pageSize=0", "/api/leads/1/history?page=1&page=2",
      "/api/dashboard?employeePage=-1", "/api/dashboard?employeePageSize=101", "/api/dashboard?unknown=1",
      "/api/dashboard?employeeSearch=a&employeeSearch=b"]) {
      currentCheck = "CRM strict query validation: " + path;
      assert.equal((await broad.request(path)).status, 400, "Malformed CRM query was accepted.");
    }
    currentCheck = "CRM cross-origin boundaries and unsupported mutations";
    for (const path of ["/api/dashboard", "/api/pipeline", "/api/pipeline/agents", "/api/leads/1", "/api/leads/1/notes", "/api/leads/1/history"]) {
      assert.equal((await broad.request(path, { headers: { Origin: "https://attacker.test" } })).status, 403);
      assert.equal((await broad.request(path, { headers: { "Sec-Fetch-Site": "same-site" } })).status, 403);
      // Notes now has a protected POST contract. This read-only caller lacks the write grant.
      assert.equal((await broad.request(path, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}" })).status,
        path === "/api/leads/1/notes" ? 403 : 405);
    }
    for (const method of ["PATCH", "PUT", "DELETE"]) assert.equal((await broad.request("/api/leads/1", { method })).status, 405);

    currentCheck = "local job listing, stage boundary, status/remarks writes and version conflicts";
    const jobs = await json<JobPage>(await broad.request("/api/jobs?pageSize=1"));
    assert.equal(jobs.total, 2); assert.equal(jobs.items.length, 1);
    assert.equal((await json<JobPage>(await broad.request("/api/jobs?jobStatus=Active"))).total, 2);
    assert.equal((await json<JobPage>(await broad.request("/api/jobs?query=first"))).total, 1);
    assert.equal((await json<JobPage>(await broad.request("/api/jobs?query=" + encodeURIComponent("' OR 1=1 --")))).total, 0);
    for (const caller of [agent, department, denied, leadOnly]) {
      assert.equal((await caller.request("/api/jobs")).status, 403);
      assert.equal((await caller.request("/api/jobs/4")).status, 403);
      assert.equal((await caller.mutate("/api/jobs/4/status", { expectedVersion: 1, jobStatus: "Hold" })).status, 403);
      assert.equal((await caller.mutate("/api/jobs/4/remarks", { expectedVersion: 1, remarks: "Forbidden" })).status, 403);
    }
    assert.equal((await broad.request("/api/jobs/1")).status, 404);
    assert.equal((await broad.mutate("/api/jobs/1/status", { expectedVersion: 1, jobStatus: "Hold" })).status, 404);
    for (const path of ["/api/jobs?extra=1", "/api/jobs?page=1&page=2", "/api/jobs?jobStatus=invalid", "/api/jobs?pageSize=101", "/api/jobs/4?extra=1"]) {
      assert.equal((await broad.request(path)).status, 400);
    }
    let job = await json<JobRecord>(await broad.request("/api/jobs/4"));
    const originalSalesStatus = job.salesStatus;
    assert.equal((await broad.request("/api/jobs/4/status", { method: "PATCH", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: job.version, jobStatus: "Hold" }) })).status, 403);
    assert.equal((await broad.mutate("/api/jobs/4/status", { expectedVersion: job.version, jobStatus: "Hold" }, { Origin: "https://attacker.test" })).status, 403);
    assert.equal((await broad.mutate("/api/jobs/4/status", { expectedVersion: job.version, jobStatus: "Hold" }, { "X-CSRF-Token": randomBytes(32).toString("base64url") })).status, 403);
    assert.equal((await broad.mutate("/api/jobs/4/status", { expectedVersion: job.version, jobStatus: "Invalid" })).status, 400);
    assert.equal((await broad.mutate("/api/jobs/4/status", { expectedVersion: job.version, jobStatus: "Hold", actorId: "2" })).status, 400);
    assert.equal((await broad.mutate("/api/jobs/4/remarks", { expectedVersion: job.version, remarks: "x".repeat(4001) })).status, 400);
    assert.equal((await broad.mutate("/api/jobs/4/remarks", { expectedVersion: job.version, remarks: "bad\0value" })).status, 400);
    assert.equal((await broad.mutate("/api/jobs/4/remarks", { expectedVersion: job.version, remarks: "x".repeat(9000) })).status, 413);
    const staleVersion = job.version;
    for (const jobStatus of ["Hold", "Closed", "Active"]) {
      const previousVersion = job.version;
      job = await json<JobRecord>(await broad.mutate("/api/jobs/4/status", { expectedVersion: job.version, jobStatus }));
      assert.equal(job.jobStatus, jobStatus); assert.equal(job.version, previousVersion + 1);
      assert.equal(job.holdByExternalId, "crm-owner-1"); assert.equal(job.salesStatus, originalSalesStatus);
    }
    assert.equal((await broad.mutate("/api/jobs/4/status", { expectedVersion: staleVersion, jobStatus: "Hold" })).status, 409);
    job = await json<JobRecord>(await broad.mutate("/api/jobs/4/remarks", { expectedVersion: job.version, remarks: htmlFixture }));
    assert.equal(job.remarks, htmlFixture);
    job = await json<JobRecord>(await broad.mutate("/api/jobs/4/remarks", { expectedVersion: job.version, remarks: "" }));
    assert.equal(job.remarks, "");
    const concurrent = await Promise.all(["Hold", "Closed"].map((jobStatus) => broad.mutate("/api/jobs/4/status", { expectedVersion: job.version, jobStatus })));
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);
    const audit = database.prepare("SELECT CAST(actor_user_id AS TEXT) AS actorId,CAST(task_id AS TEXT) AS taskId,action,changed_fields FROM crm_job_audit_events ORDER BY id").all() as { actorId: string; taskId: string; action: string; changed_fields: string }[];
    assert.equal(audit.length, 6); assert(audit.every((event) => event.actorId === "1" && event.taskId === "4"));
    assert.equal(JSON.stringify(audit).includes(htmlFixture), false);
    assert.deepEqual(JSON.parse(audit[0]!.changed_fields), ["Job_Status", "hold_by"]);
    for (const path of ["/api/jobs", "/api/jobs/4"]) assert.equal((await broad.request(path, { headers: { Origin: "https://attacker.test" } })).status, 403);
    assert.equal((await broad.request("/api/jobs/4", { method: "DELETE" })).status, 405);
    assert.equal((await broad.request("/api/jobs/4/status", { method: "GET" })).status, 405);

    currentCheck = "CRM live revocation, reassignment and safe monetary error responses";
    database.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=6").run();
    assert.equal((await leadOnly.request("/api/pipeline")).status, 403);
    database.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=7").run();
    assert.equal((await dashboardOnly.request("/api/dashboard")).status, 403);
    assert.equal((await dashboardOnly.request("/api/jobs")).status, 403);
    assert.equal((await dashboardOnly.mutate("/api/jobs/4/remarks", { expectedVersion: 1, remarks: "Forbidden" })).status, 403);
    database.prepare("INSERT INTO departments_assign(task_id,user_id,department,status) VALUES(4,4,'Electrical','Assigned')").run();
    assert.equal((await department.request("/api/leads/4")).status, 404);
    assert.equal((await json<DashboardResult>(await department.request("/api/dashboard"))).departments[0]!.total, 0);
    database.prepare("UPDATE tasks SET assigned_to='crm-owner-1' WHERE id=2").run();
    assert.equal((await agent.request("/api/leads/2")).status, 404);
    assert.equal((await json<PipelineResult>(await agent.request("/api/pipeline"))).total, 2);
    database.prepare("UPDATE tasks SET assigned_to='crm-owner-2' WHERE id=2").run();
    database.prepare("UPDATE tasks SET service_charge='not-an-amount' WHERE id=4").run();
    const safeError = await json<{ error: string }>(await broad.request("/api/dashboard"), 503);
    assert.equal(safeError.error, "Dashboard data is temporarily unavailable. Some records may require review.");
    database.prepare("UPDATE tasks SET service_charge=NULL WHERE id=4").run();
    assert.deepEqual((await json<DashboardResult>(await broad.request("/api/dashboard"))).global!.accounts,
      { pendingJobs: 0, totalPending: null, unknownServiceChargeJobs: 1 });
    database.prepare("UPDATE tasks SET service_charge='100.50' WHERE id=4").run();
    assert.equal((database.prepare("SELECT COUNT(*) AS n FROM crm_audit_events").get() as { n: number }).n, 0);

    currentCheck = "Chromium dashboard, pipeline search/filter, lead detail and mobile workflow";
    browser = await chromium.launch({ headless: true, timeout: 20_000 });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(10_000);
    const runtimeErrors: string[] = [];
    page.on("pageerror", () => runtimeErrors.push("pageerror"));
    page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push("consoleerror"); });
    await page.goto(base + "/dashboard"); await page.waitForURL(base + "/login");
    await page.getByLabel("Email").fill("crm-1@example.test"); await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.origin === base && ["/account", "/dashboard"].includes(url.pathname));
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    await page.getByRole("region", { name: "Accounts summary", exact: true }).getByText("80.25", { exact: true }).waitFor();
    const visualDirectory = mkdtempSync(join(localDirectory(root, [".local-data", "reports"], true), "crm-visual-"));
    const desktopScreenshot = join(visualDirectory, "synthetic-dashboard-desktop.png");
    const mobileScreenshot = join(visualDirectory, "synthetic-job-mobile.png");
    await page.screenshot({ path: desktopScreenshot, fullPage: true });
    const employees = page.getByRole("region", { name: "Employee workload", exact: true });
    await employees.getByLabel("Search employees").fill("department"); await employees.getByRole("button", { name: "Search", exact: true }).click();
    await employees.getByText("CRM department fixture", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Lead pipeline", exact: true }).click();
    await page.getByRole("heading", { name: "Lead pipeline", exact: true }).waitFor();
    await page.getByText("7 leads match the current filters. Cards show the current page.", { exact: true }).waitFor();
    await page.getByLabel("Search leads", { exact: true }).fill("qualification");
    await page.locator(".search-form").getByRole("button", { name: "Search", exact: true }).click();
    await page.getByText("1 leads match the current filters. Cards show the current page.", { exact: true }).waitFor();
    await page.getByRole("link", { name: "CRM qualification fixture", exact: true }).click();
    await page.getByRole("heading", { name: "CRM qualification fixture", exact: true }).waitFor();
    await page.getByRole("region", { name: "Customer details", exact: true }).getByText("Synthetic contact", { exact: true }).waitFor();
    await page.getByRole("region", { name: "Lead notes", exact: true }).getByRole("heading", { name: "Synthetic second note", exact: true }).waitFor();
    await page.getByRole("region", { name: "Status history", exact: true }).getByRole("cell", { name: "Site Visit", exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Description and remarks", exact: true }).getByText(htmlFixture, { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => Reflect.has(globalThis, "__crmXss")), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Lead detail overflows mobile viewport.");
    await page.getByRole("link", { name: "Lead pipeline", exact: true }).click();
    await page.getByRole("link", { name: "CRM qualification fixture", exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Pipeline overflows mobile viewport.");
    await page.getByText("Filter by agent", { exact: true }).click();
    await page.getByLabel("Assigned agent", { exact: true }).selectOption("crm-owner-2");
    await page.getByText("3 leads match the current filters. Cards show the current page.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Closed won (1)", exact: true }).click();
    await page.getByText("1 leads match the current filters. Cards show the current page.", { exact: true }).waitFor();
    await page.getByRole("link", { name: "CRM first won fixture", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "CRM second won fixture", exact: true }).count(), 0);
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await page.getByRole("region", { name: "Accounts summary", exact: true }).getByText("80.25", { exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Dashboard overflows mobile viewport.");
    currentCheck = "Chromium persisted local job status and administrator remarks editing";
    await page.getByRole("link", { name: "Jobs", exact: true }).click();
    currentCheck = "Chromium source job status filter";
    await page.getByRole("link", { name: "CRM first won fixture", exact: true }).waitFor();
    await page.getByLabel("Job status filter", { exact: true }).selectOption("Active");
    await page.getByRole("link", { name: "CRM first won fixture", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "CRM second won fixture", exact: true }).waitFor();
    await page.getByLabel("Job status filter", { exact: true }).selectOption("all");
    await page.getByRole("link", { name: "CRM first won fixture", exact: true }).waitFor();
    currentCheck = "Chromium job search form";
    await page.getByLabel("Search jobs", { exact: true }).fill("first");
    await page.getByRole("region", { name: "Job search", exact: true }).getByRole("button", { name: "Search", exact: true }).click();
    currentCheck = "Chromium opening selected job";
    await page.getByRole("link", { name: "CRM first won fixture", exact: true }).click();
    await page.getByRole("heading", { name: "CRM first won fixture", exact: true }).waitFor();
    currentCheck = "Chromium preparing job status and remarks drafts";
    await page.getByLabel("Administrator remarks", { exact: true }).fill("Synthetic browser administrator remark");
    currentCheck = "Chromium selecting Active job status draft";
    await page.getByLabel("Job status", { exact: true }).selectOption("Active");
    currentCheck = "Chromium saving job status";
    await Promise.all([page.waitForResponse((response) => response.url() === base + "/api/jobs/4/status" && response.request().method() === "PATCH" && response.status() === 200),
      page.getByRole("button", { name: "Save job status", exact: true }).click()]);
    assert.equal((await json<JobRecord>(await broad.request("/api/jobs/4"))).jobStatus, "Active");
    assert.equal(await page.getByLabel("Administrator remarks", { exact: true }).inputValue(), "Synthetic browser administrator remark", "Saving status discarded unsaved remarks.");
    currentCheck = "Chromium saving administrator remarks";
    await Promise.all([page.waitForResponse((response) => response.url() === base + "/api/jobs/4/remarks" && response.request().method() === "PATCH" && response.status() === 200),
      page.getByRole("button", { name: "Save remarks", exact: true }).click()]);
    assert.equal((await json<JobRecord>(await broad.request("/api/jobs/4"))).remarks, "Synthetic browser administrator remark");
    currentCheck = "Chromium reload after persisted administrator remarks";
    await page.reload();
    assert.equal(await page.getByLabel("Administrator remarks", { exact: true }).inputValue(), "Synthetic browser administrator remark");
    await page.getByLabel("Job status", { exact: true }).selectOption("Closed");
    await page.getByLabel("Administrator remarks", { exact: true }).fill("");
    currentCheck = "Chromium clearing remarks while preserving status draft";
    await Promise.all([page.waitForResponse((response) => response.url() === base + "/api/jobs/4/remarks" && response.request().method() === "PATCH" && response.status() === 200),
      page.getByRole("button", { name: "Save remarks", exact: true }).click()]);
    assert.equal((await json<JobRecord>(await broad.request("/api/jobs/4"))).remarks, "");
    assert.equal(await page.getByLabel("Job status", { exact: true }).inputValue(), "Closed", "Saving remarks discarded an unsaved status selection.");
    currentCheck = "Chromium saving preserved status draft";
    await Promise.all([page.waitForResponse((response) => response.url() === base + "/api/jobs/4/status" && response.request().method() === "PATCH" && response.status() === 200),
      page.getByRole("button", { name: "Save job status", exact: true }).click()]);
    assert.equal((await json<JobRecord>(await broad.request("/api/jobs/4"))).jobStatus, "Closed");
    currentCheck = "Chromium mobile job viewport and screenshot";
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Job detail overflows mobile viewport.");
    await page.screenshot({ path: mobileScreenshot, fullPage: true });
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(base + "/login");
    currentCheck = "Chromium agent-only dashboard and enforced personal pipeline scope";
    await page.getByLabel("Email").fill("crm-2@example.test"); await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.origin === base && ["/account", "/dashboard"].includes(url.pathname));
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await page.getByRole("region", { name: "Your sales leads", exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Job overview", exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Jobs", exact: true }).count(), 0);
    await page.getByRole("link", { name: "Lead pipeline", exact: true }).click();
    await page.getByText("3 leads match the current filters. Cards show the current page.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "Only my assigned leads", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("checkbox", { name: "Only my assigned leads", exact: true }).isChecked(), true);
    assert.equal(await page.getByRole("link", { name: "CRM second won fixture", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(base + "/login");
    assert.deepEqual(runtimeErrors, []);
    console.log("PASS: CRM HTTP dashboard counts, exact amounts, scopes, pipeline search/paging, detail/notes/history, revocation, query/origin/method guards and safe errors.");
    console.log("PASS: Chromium dashboard, employee search, pipeline search/stage/agent filters, persisted lead notes/history, escaped content, mobile layouts and sign-out; no browser runtime errors.");
    console.log("PASS: Local job status and administrator remarks HTTP/browser writes, audit records, optimistic conflicts, concurrent requests, CSRF, permission boundaries and persistence after reload.");
    console.log(`Synthetic fixture screenshots only: ${desktopScreenshot}; ${mobileScreenshot}`);
  } finally {
    await browser?.close().catch(() => { /* Always complete cleanup of owned resources. */ });
    if (child?.exitCode === null) child.kill();
    if (exited) await exited;
    database?.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), resolve(testRoot)); assert.equal(target, resolve(directory));
    rmSync(target, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`CRM HTTP/browser verification failed during ${currentCheck}. No real CRM data was used.`);
  if (error instanceof assert.AssertionError && typeof error.actual === "number" && typeof error.expected === "number") {
    console.error(`Numeric assertion: expected ${error.expected}, received ${error.actual}.`);
  }
  process.exitCode = 1;
});
