import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Download, type Page } from "playwright";
import { unzipSync } from "fflate";
import { configureDatabase, type SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.js";
import { startServer } from "../src/server.js";
import { seedDemo, type DemoIdentity } from "./fixture.js";
import { createSqliteDemoRuntime } from "./runtime.js";
import { applyLocalWorkflowExtension } from "./workflow-schema.js";
import { applyPercentageQuotationExtension } from "./percentage-schema.js";
import { safeBrowserFailure } from "./browser-acceptance.js";
import { auditResponsiveNavigation, captureResponsiveScreen, createResponsiveAudit, finishResponsiveAudit,
  RESPONSIVE_VIEWPORTS, type ResponsiveAuditReceipt } from "./responsive-audit.js";

/** Separate synthetic acceptance composition; never opens a database filename,
 * reads an access handoff, changes the active demo, or inherits environment
 * credentials. All accounts, grants and sessions exist only in :memory:.
 * The installed production frontend is used unchanged on separate ports. */
export const isolatedOrigin = "http://127.0.0.1:3101";
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(backendRoot, "../");
type Json = Record<string, unknown>;
const object = (value: unknown): Json => { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Json; };
export function allowedIsolatedBrowserRequest(value: string, method: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== isolatedOrigin || url.username || url.password || /%(?:2e|2f|5c|00)|\\/i.test(url.pathname)) return false;
    if (["GET", "HEAD"].includes(method)) return true;
    return ["POST", "PATCH", "PUT"].includes(method) && /^\/api\/[a-zA-Z0-9/_-]+$/.test(url.pathname) && !url.search;
  } catch { return false; }
}
export function isolatedChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive"])
    if (environment[key] !== undefined) result[key] = environment[key];
  return { ...result, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", CRM_MYSQL_NETWORK_DISABLED: "1",
    APP_ORIGIN: isolatedOrigin, CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3102" };
}
async function freePorts() {
  for (const port of [3101, 3102]) await new Promise<void>((done, fail) => {
    const listener = createServer(); listener.once("error", () => fail(new Error("Isolated acceptance port occupied; no listener was stopped.")));
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => listener.close(error => error ? fail(new Error("Port check failed.")) : done()));
  });
}
const bootstrap = `
const { startServer } = require(process.argv[1]);
let ready = false, stopping = false;
function stop() { stopping = true; if (ready) process.emit('SIGTERM', 'SIGTERM'); }
process.on('message', value => { if (value === 'isolated-stop') stop(); }); process.once('disconnect', stop);
startServer({ dir: process.argv[2], hostname: '127.0.0.1', port: 3101, isDev: false, allowRetry: false,
  keepAliveTimeout: 1000 }).then(() => { ready = true; if (stopping || !process.connected) return stop();
  process.send('isolated-ready'); }).catch(() => process.exit(1));
`;
async function stopOwned(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.send("isolated-stop", () => {}); else child.kill("SIGTERM");
  for (let count = 0; count < 70 && child.exitCode === null && child.signalCode === null; count++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (let count = 0; count < 30 && child.exitCode === null && child.signalCode === null; count++) await delay(100);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "Owned frontend shutdown not confirmed.");
}
async function downloadBytes(download: Download) {
  assert.equal(await download.failure(), null); const stream = await download.createReadStream(); assert.ok(stream);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of stream) { const bytes = Buffer.from(chunk as Uint8Array); length += bytes.length;
    assert.ok(length <= 20 * 1024 * 1024); chunks.push(bytes); }
  return Buffer.concat(chunks);
}
async function bounded<T>(operation: Promise<T>, milliseconds = 20_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Bounded isolated browser operation timed out.")), milliseconds); })]); }
  finally { if (timeout) clearTimeout(timeout); }
}
export function parseIsolatedBrowserArguments(args: readonly string[]): { responsiveAudit: boolean } {
  if (args[0] !== "--synthetic-in-memory-only" || args.length > 2 || (args.length === 2 && args[1] !== "--responsive-audit")) {
    throw new Error("Explicit --synthetic-in-memory-only is required; optional --responsive-audit writes synthetic screenshots only.");
  }
  return { responsiveAudit: args.length === 2 };
}
export async function runIsolatedBrowser(options: { responsiveAudit?: boolean } = {}) {
  const result = { status: "FAIL", scope: "Synthetic in-memory SQLite, actual Next.js/Express UI on isolated 3101/3102; preserved demo never opened",
    checks: [] as { name: string; status: "PASS" }[], failedCheck: undefined as string | undefined,
    failure: undefined as ReturnType<typeof safeBrowserFailure> | undefined,
    observations: { pageErrors: 0, blockedRequests: 0, unexpectedHttpErrors: 0, unexpectedConsoleErrors: 0,
      unexpectedRequestFailures: 0, navigationAborts: 0, expectedRefusals: 0, uiMutations: 0, browserApiAssertions: 0 },
    syntheticDatabase: { foreignKeys: false, integrity: false, remainingSessions: -1 }, servicesStopped: false,
    responsiveAudit: undefined as { status: string; directory: string; samples: number; issues: number; navigationChecks: number } | undefined };
  let current = "Isolated startup", currentStep = "Startup checks", browser: Browser | undefined, child: ChildProcess | undefined;
  let runtime: ReturnType<typeof createSqliteDemoRuntime> | undefined, server: Awaited<ReturnType<typeof startServer>> | undefined;
  let ownedDatabase: SqliteDatabase | undefined;
  let responsiveAudit: ResponsiveAuditReceipt | undefined;
  const expected = new Map<string, Set<number>>();
  const expect = (path: string, status: number) => expected.set(path, new Set([...(expected.get(path) ?? []), status]));
  const healthy = () => { for (const name of ["pageErrors", "blockedRequests", "unexpectedHttpErrors", "unexpectedConsoleErrors", "unexpectedRequestFailures"] as const)
    assert.equal(result.observations[name], 0, "Unexpected browser event count."); };
  const check = async (name: string, work: () => Promise<void>) => { current = name;
    process.stdout.write(JSON.stringify({ check: name, status: "RUNNING" }) + "\n"); await bounded(work(), 90_000); healthy();
    result.checks.push({ name, status: "PASS" }); process.stdout.write(JSON.stringify({ check: name, status: "PASS" }) + "\n"); };
  try {
    assert.ok(!["DEBUG", "PWDEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS"].some(key => process.env[key]));
    assert.ok(!process.execArgv.some(value => value.startsWith("--inspect")));
    assert.ok(existsSync(chromium.executablePath()), "Installed browser required; no downloads attempted.");
    // Next loads these itself; do not let an unrelated frontend env file select
    // inherited credentials or nonlocal integrations in this isolated runner.
    assert.ok(![".env", ".env.local", ".env.production", ".env.production.local"].some(name => existsSync(join(frontendRoot, name))),
      "Isolated verification requires no actual frontend environment files.");
    assert.ok(existsSync(join(frontendRoot, ".next/BUILD_ID")), "Existing production frontend build required."); await freePorts();
    const Database = createRequire(join(frontendRoot, "package.json"))("better-sqlite3") as new (name: string) => SqliteDatabase;
    const db = new Database(":memory:"); ownedDatabase = db; configureDatabase(db); assert.equal(migrateDatabase(db), 10);
    const fixture = await seedDemo(db);
    applyLocalWorkflowExtension(db, { company: "VOLTRONIX CONTRACTING LLC", salesperson: "SYNTHETIC browser verification" });
    applyPercentageQuotationExtension(db); runtime = createSqliteDemoRuntime(db);
    server = await startServer({ environment: "test", host: "127.0.0.1", port: 3102, appOrigin: isolatedOrigin },
      { auth: runtime.auth, crmServices: runtime.services }, runtime.close);
    child = spawn(process.execPath, ["--input-type=commonjs", "-e", bootstrap,
      join(frontendRoot, "node_modules/next/dist/server/lib/start-server.js"), frontendRoot],
    { cwd: frontendRoot, windowsHide: true, env: isolatedChildEnvironment(process.env), stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let ready = false, failed = false; child.on("message", message => { if (message === "isolated-ready") ready = true; }); child.on("error", () => { failed = true; });
    for (let attempt = 0; attempt < 100 && !ready; attempt++) { assert.equal(failed, false); assert.equal(child.exitCode, null); await delay(300); }
    assert.equal(ready, true);
    const health = await fetch(isolatedOrigin + "/api/health/live", { redirect: "error", signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200); assert.equal(object(await health.json()).status, "running");
    const environment = isolatedChildEnvironment(process.env);
    browser = await chromium.launch({ headless: true, env: environment as Record<string, string>,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync", "--no-first-run",
        "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
    const context = async (): Promise<BrowserContext> => {
      const value = await browser!.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
      value.setDefaultTimeout(15_000); value.setDefaultNavigationTimeout(25_000);
      await value.route("**/*", route => { if (allowedIsolatedBrowserRequest(route.request().url(), route.request().method())) return route.continue();
        result.observations.blockedRequests++; return route.abort("blockedbyclient"); });
      await value.routeWebSocket("**/*", socket => { result.observations.blockedRequests++; socket.close(); });
      value.on("page", page => { page.on("pageerror", () => result.observations.pageErrors++); page.on("console", message => {
        if (message.type() !== "error") return;
        try { const path = new URL(message.location().url).pathname;
          if (expected.has(path) && /^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|415|429|503)\b/.test(message.text())) return;
        } catch { /* Never retain browser-controlled content. */ } result.observations.unexpectedConsoleErrors++;
      }); });
      value.on("response", response => { if (response.status() < 400) return;
        if (expected.get(new URL(response.url()).pathname)?.has(response.status())) result.observations.expectedRefusals++;
        else result.observations.unexpectedHttpErrors++; });
      value.on("requestfailed", request => { if (request.failure()?.errorText === "net::ERR_ABORTED" && allowedIsolatedBrowserRequest(request.url(), request.method())) result.observations.navigationAborts++;
        else result.observations.unexpectedRequestFailures++; }); return value;
    };
    const settle = (page: Page) => page.waitForLoadState("networkidle");
    const visit = async (page: Page, path: string) => { currentStep = "Page load"; assert.equal((await page.goto(isolatedOrigin + path, { waitUntil: "domcontentloaded" }))?.status(), 200); await settle(page); };
    const button = (page: Page, name: string) => { currentStep = "Button interaction"; return page.getByRole("button", { name, exact: true }); };
    const field = (page: Page, name: string) => { currentStep = "Input: " + name; return page.getByLabel(name, { exact: true }); };
    const select = (page: Page, name: string) => { currentStep = "Selection: " + name; return page.getByRole("combobox", { name, exact: true }); };
    const mutate = async (page: Page, path: string, method: string, work: () => Promise<unknown>, status = 200) => {
      const [response] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method), work()]);
      assert.equal(response.status(), status); result.observations.uiMutations++;
      // Login/logout immediately navigate: Chromium can retain a response-body
      // promise after that navigation discarded it. The UI redirect plus fresh
      // authenticated reads verify these outcomes; never await discarded bytes.
      currentStep = "Mutation response status";
      const redirects = path.startsWith("/api/auth/") || method === "PATCH" && /^\/api\/settings\/users\/[0-9]+$/.test(path);
      const body = response.status() < 400 && !redirects ? object(await bounded(response.json())) : {};
      await settle(page); return body;
    };
    const api = async (page: Page, path: string, method = "GET", body?: unknown, csrf = true) => {
      result.observations.browserApiAssertions++;
      return page.evaluate(async input => {
        const headers: Record<string, string> = {};
        if (input.body !== undefined) headers["Content-Type"] = "application/json";
        if (input.method !== "GET" && input.csrf) { const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin" });
          headers["X-CSRF-Token"] = (await challenge.json() as { csrfToken: string }).csrfToken; }
        const response = await fetch(input.path, { method: input.method, credentials: "same-origin", headers, redirect: "error",
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
        const value = await response.json(); return { status: response.status, body: value as Record<string, unknown> };
      }, { path, method, body, csrf });
    };
    const login = async (page: Page, account: Pick<DemoIdentity, "email" | "password">) => {
      await visit(page, "/login"); await field(page, "Email address").fill(account.email); await field(page, "Password").fill(account.password);
      await mutate(page, "/api/auth/login", "POST", () => page.getByRole("button", { name: /^(Login|Sign in)$/ }).click());
      await page.waitForURL(url => ["/account", "/dashboard"].includes(url.pathname)); await settle(page);
      const me = await api(page, "/api/auth/me"); assert.equal(me.status, 200); assert.equal(object(me.body.user).email, account.email);
    };
    const logout = async (page: Page) => { if (!await button(page, "Sign out").isVisible()) await button(page, "User menu").click();
      await mutate(page, "/api/auth/logout", "POST", () => button(page, "Sign out").click()); await page.waitForURL(isolatedOrigin + "/login"); };
    const managerContext = await context(), manager = await managerContext.newPage();
    const marker = "SYNTHETIC isolated browser " + randomUUID(); let taskId = "", productId = "", noteId = "", attachmentId = "";
    await check("UI login, session reload, dashboard and protected navigation", async () => {
      await login(manager, fixture.identities.browser); await manager.reload(); await settle(manager); await visit(manager, "/account");
      await manager.getByRole("heading", { name: "Your account", exact: true }).waitFor();
      for (const path of ["/dashboard", "/pipeline", "/items", "/jobs", "/quotations", "/reports/employee-performance",
        "/settings/users", "/settings/permissions", "/settings/permission-groups", "/settings/permissions/assign"])
        { await visit(manager, path); assert.equal(await manager.locator('.crm-content-body [role="alert"]').count(), 0); }
      const caps = await api(manager, "/api/capabilities"); assert.equal(caps.status, 200); assert.equal(caps.body.localWorkflow, true);
    });
    await check("UI create product, search and database readback", async () => {
      await visit(manager, "/items/new"); await field(manager, "Item Name").fill(marker); await field(manager, "Description (Optional)").fill("Disposable synthetic product");
      productId = String((await mutate(manager, "/api/items", "POST", () => button(manager, "Save Item").click())).productId);
      await visit(manager, "/items"); await field(manager, "Search Items").fill(marker); await field(manager, "Search Items").press("Enter"); await settle(manager);
      await manager.getByRole("cell", { name: marker, exact: true }).waitFor(); assert.equal((await api(manager, `/api/items/${productId}`)).body.name, marker);
    });
    await check("UI create local deal with no external identity", async () => {
      await visit(manager, "/deals/new");
      for (const [label, value] of [["First name", "Synthetic"], ["Last name", "Browser"], ["Company name", marker],
        ["Customer email", "synthetic-browser@example.invalid"], ["Mobile", "0000000000"], ["Phone", "0000000000"], ["Description", marker]])
        await field(manager, label!).fill(value!);
      await manager.getByRole("combobox", { name: "Company department", exact: true }).selectOption("VOLTRONIX CONTRACTING LLC");
      taskId = String((await mutate(manager, "/api/deals", "POST", () => button(manager, "Save Deal").click())).taskId);
      const lead = await api(manager, `/api/leads/${taskId}`); assert.equal(lead.body.persistence, "local-demo"); assert.equal(lead.body.externalId, null);
      await visit(manager, `/leads/${taskId}`);
    });
    await check("UI create and edit lead note with reload persistence", async () => {
      await button(manager, "Add Note").click(); await field(manager, "New note title").fill(marker); await field(manager, "New note content").fill("Synthetic initial note");
      noteId = String((await mutate(manager, `/api/leads/${taskId}/notes`, "POST", () => button(manager, "Add lead note").click())).noteId);
      await visit(manager, `/leads/${taskId}`); await button(manager, `Edit note: ${marker}`).click(); await field(manager, "Edit note content").fill("Synthetic edited note");
      await mutate(manager, `/api/leads/${taskId}/notes/${noteId}`, "PATCH", () => button(manager, "Save lead note").click());
      await visit(manager, `/leads/${taskId}`); await manager.getByText("Synthetic edited note", { exact: true }).waitFor();
    });
    const stage = async (value: string) => {
      await visit(manager, `/leads/${taskId}`); await button(manager, "Update Status").click(); await select(manager, "Next lead stage").selectOption(value);
      if (value === "Closed Won") await field(manager, "Service charge (AED)").fill("162.00");
      await mutate(manager, `/api/leads/${taskId}/stage`, "PATCH", () => button(manager, "Save lead stage").click());
      assert.equal((await api(manager, `/api/leads/${taskId}`)).body.status, value);
    };
    await check("UI permitted lead stage transition persists", () => stage("Site Visit"));
    await check("UI quotation percentage line/header discounts, preview and create", async () => {
      await visit(manager, `/quotations/new?taskId=${taskId}`); await manager.getByLabel("Subject", { exact: false }).fill(marker);
      await button(manager, "Item 1 product").click(); await manager.getByRole("combobox", { name: "Item 1 product search", exact: true }).fill(marker);
      await manager.getByRole("option", { name: `${marker} (${productId})`, exact: true }).click();
      await field(manager, "Item 1 quantity").fill("2"); await field(manager, "Item 1 price").fill("100");
      await field(manager, "Item 1 discount percent").fill("10"); await field(manager, "Discount (%)").fill("10");
      await field(manager, "Kind Attention").fill("Synthetic customer"); assert.equal(await field(manager, "Grand Total").inputValue(), "170.10");
      await mutate(manager, "/api/quotations", "POST", () => button(manager, "Save Proposal").click());
      const quote = (await api(manager, `/api/quotations/${taskId}`)).body;
      assert.equal(quote.calculationPolicy, "percentage-only-v2"); assert.equal(object(quote.totals).grandTotal, "170.10");
    });
    await check("UI percentage quotation edit, versioned save and readback", async () => {
      await visit(manager, `/quotations/${taskId}/edit`); await field(manager, "Item 1 discount (%)").fill("5");
      await mutate(manager, `/api/quotations/${taskId}`, "PATCH", () => button(manager, "Save quotation").click());
      assert.equal(object((await api(manager, `/api/quotations/${taskId}`)).body.quotation).discountType, "percentage");
      await visit(manager, `/quotations/${taskId}`);
    });
    await check("UI protected PDF downloads for both templates and new percentage quote", async () => {
      for (const id of [fixture.contractingTaskId, fixture.switchgearTaskId, taskId]) {
        await visit(manager, `/quotations/${id}`); const pending = manager.waitForEvent("download");
        await manager.getByRole("link", { name: "Download quotation PDF", exact: true }).click();
        const bytes = await downloadBytes(await pending); assert.equal(bytes.subarray(0, 5).toString(), "%PDF-"); assert.ok(bytes.length > 1000); bytes.fill(0);
      }
    });
    await check("UI closed-won conversion, job remarks and status persistence", async () => {
      await stage("Closed Won"); await visit(manager, `/jobs/${taskId}`); await field(manager, "Administrator remarks").fill(marker);
      await mutate(manager, `/api/jobs/${taskId}/remarks`, "PATCH", () => button(manager, "Save remarks").click());
      await select(manager, "Job status").selectOption("Hold"); await mutate(manager, `/api/jobs/${taskId}/status`, "PATCH", () => button(manager, "Save job status").click());
      await visit(manager, `/jobs/${taskId}`); assert.equal(await field(manager, "Administrator remarks").inputValue(), marker); assert.equal(await field(manager, "Job status").inputValue(), "Hold");
    });
    const filename = "synthetic-browser-attachment.txt", bytes = Buffer.from("Synthetic isolated browser attachment only.\n");
    await check("UI attachment upload, exact protected download and invalid-file rejection", async () => {
      await visit(manager, `/jobs/${fixture.jobId}`); await field(manager, "Attachment file").setInputFiles({ name: filename, mimeType: "text/plain", buffer: bytes });
      attachmentId = String((await mutate(manager, `/api/leads/${fixture.jobId}/attachments`, "POST", () => button(manager, "Upload attachment").click())).id);
      const pending = manager.waitForEvent("download"); await manager.getByRole("link", { name: filename, exact: true }).click(); assert.ok((await downloadBytes(await pending)).equals(bytes));
      await field(manager, "Attachment file").setInputFiles({ name: "synthetic-blocked.php", mimeType: "text/plain", buffer: bytes });
      expect(`/api/leads/${fixture.jobId}/attachments`, 415);
      await mutate(manager, `/api/leads/${fixture.jobId}/attachments`, "POST", () => button(manager, "Upload attachment").click(), 415);
      await manager.locator('[role="alert"]').filter({ hasText: /not|supported|allowed|file/i }).first().waitFor();
    });
    const workerContext = await context(), worker = await workerContext.newPage();
    await check("UI department login, work log attachment and status persistence", async () => {
      await login(worker, fixture.identities.workers.Electrical); await visit(worker, `/departments/Electrical/jobs/${fixture.jobId}`);
      await worker.getByRole("tab", { name: "Electrical", exact: true }).click(); await select(worker, "Authority").selectOption("DESIGN");
      await select(worker, "Log status").selectOption("DRAWING PREPARATION"); await field(worker, "Work notes").fill(marker);
      const gif = Buffer.from("47494638376101000100800000000000ffffff2c00000000010001000002024401003b", "hex");
      await field(worker, "Work log attachment (optional)").setInputFiles({ name: "synthetic-work.gif", mimeType: "image/gif", buffer: gif });
      await mutate(worker, `/api/departments/Electrical/jobs/${fixture.jobId}/logs`, "POST", () => button(worker, "Add work log").click());
      const pending = worker.waitForEvent("download"); await worker.getByRole("link", { name: "Download synthetic-work.gif", exact: true }).first().click(); assert.ok((await downloadBytes(await pending)).equals(gif));
      await button(worker, "Update Status").click(); await select(worker, "Department status").selectOption("Process");
      await mutate(worker, `/api/departments/Electrical/jobs/${fixture.jobId}/status`, "PATCH", () => button(worker, "Save department status").click());
      await visit(worker, `/departments/Electrical/jobs/${fixture.jobId}`); await worker.getByRole("tab", { name: "Electrical", exact: true }).click();
      await worker.getByRole("region", { name: "Work log history", exact: true }).getByText(marker, { exact: true }).waitFor();
    });
    await check("UI reassignment revokes existing worker attachment access", async () => {
      await visit(worker, `/departments/Electrical/jobs/${fixture.jobId}`); const before = worker.waitForEvent("download");
      await worker.getByRole("link", { name: filename, exact: true }).click(); assert.ok((await downloadBytes(await before)).equals(bytes));
      await visit(manager, `/jobs/${fixture.jobId}`);
      await mutate(manager, `/api/jobs/${fixture.jobId}/unassign`, "POST", () => button(manager, "Unassign Electrical").click());
      const path = `/api/attachments/${attachmentId}`; expect(path, 404); expect(path, 403);
      const status = await worker.evaluate(async path => (await fetch(path, { credentials: "same-origin", redirect: "error" })).status, path);
      result.observations.browserApiAssertions++; assert.ok([403, 404].includes(status));
      await select(manager, "Assignment department").selectOption("Electrical"); await select(manager, "Assignment user").selectOption(fixture.identities.workers.Electrical.id);
      await mutate(manager, `/api/jobs/${fixture.jobId}/assignments`, "POST", () => button(manager, "Assign department").click());
    });
    await check("UI department queues, recorded dates and employee report/XLSX exports", async () => {
      await visit(worker, "/departments/Electrical/jobs"); const pending = worker.waitForEvent("download");
      await worker.getByRole("columnheader", { name: "Date Assigned", exact: true }).waitFor();
      await worker.getByRole("columnheader", { name: "Job Date", exact: true }).waitFor();
      await worker.getByRole("link", { name: "Export assigned jobs (XLSX)", exact: true }).click();
      assert.ok(unzipSync(await downloadBytes(await pending))["xl/workbook.xml"]);
      await visit(manager, "/reports/employee-performance"); await manager.getByRole("region", { name: "Report summary", exact: true }).waitFor();
      await visit(manager, "/jobs"); const central = manager.waitForEvent("download"); await manager.getByRole("link", { name: "Export jobs (XLSX)", exact: true }).click();
      assert.ok(unzipSync(await downloadBytes(await central))["xl/worksheets/sheet1.xml"]);
      for (const department of ["Civil", "PM", "Switchgear", "Maintenance"] as const) {
        const ctx = await context(), page = await ctx.newPage(); await login(page, fixture.identities.workers[department]);
        await visit(page, `/departments/${department}/jobs`); await visit(page, `/departments/${department}/jobs/${fixture.jobId}`);
        await page.getByRole("tab", { name: department === "PM" ? "Project Manager" : department, exact: true }).click(); await logout(page); await ctx.close();
      }
    });
    await check("UI synthetic user settings create/edit and grant/revoke authorization", async () => {
      const account = { email: `synthetic-${randomUUID()}@example.invalid`, password: randomBytes(32).toString("base64url") };
      await visit(manager, "/settings/users"); const editor = manager.getByRole("region", { name: "User editor", exact: true });
      await editor.locator("#user-name").fill("Synthetic isolated user"); await editor.getByLabel("Email address", { exact: true }).fill(account.email);
      await editor.getByLabel("Password", { exact: true }).fill(account.password);
      const created = await mutate(manager, "/api/settings/users", "POST", () => editor.getByRole("button", { name: "Create user", exact: true }).click(), 201);
      const id = String(created.id ?? object(created.user).id);
      await field(manager, "Search users").fill(account.email); await manager.getByRole("region", { name: "User list", exact: true }).getByRole("button", { name: "Search", exact: true }).click(); await settle(manager);
      await manager.getByRole("row").filter({ hasText: account.email }).getByRole("button", { name: "Edit", exact: true }).click();
      await editor.locator("#user-name").fill("Synthetic edited user");
      await mutate(manager, `/api/settings/users/${id}`, "PATCH", () => editor.getByRole("button", { name: "Save user", exact: true }).click());
      const ctx = await context(), page = await ctx.newPage(); await login(page, account);
      expect("/api/dashboard", 403); assert.equal((await api(page, "/api/dashboard")).status, 403);
      await visit(manager, `/settings/permissions/assign?userId=${id}`); await select(manager, "Admin user").selectOption(id); await button(manager, "Load").click(); await settle(manager);
      await field(manager, "Find permissions").fill("dashboard.view"); await button(manager, "Search").click(); await settle(manager);
      const permissionId = String((db.prepare("SELECT id FROM permissions WHERE key='dashboard.view'").get() as { id: number }).id);
      const grant = manager.locator(`input[type="checkbox"][name="permissions[]"][value="${permissionId}"]`); await grant.check();
      await mutate(manager, `/api/settings/users/${id}/permissions`, "PUT", () => button(manager, "Save").click());
      assert.equal((await api(page, "/api/dashboard")).status, 200); await grant.uncheck();
      await mutate(manager, `/api/settings/users/${id}/permissions`, "PUT", () => button(manager, "Save").click());
      assert.equal((await api(page, "/api/dashboard")).status, 403); await logout(page); await ctx.close();
    });
    await check("Browser API CSRF, stale versions and unauthorized PDF refuse writes/access", async () => {
      const path = `/api/jobs/${taskId}/remarks`, before = (await api(manager, `/api/jobs/${taskId}`)).body;
      expect(path, 403); assert.equal((await api(manager, path, "PATCH", { expectedVersion: before.version, remarks: "Refused" }, false)).status, 403);
      expect(path, 409); assert.equal((await api(manager, path, "PATCH", { expectedVersion: Number(before.version) - 1, remarks: "Refused" })).status, 409);
      assert.equal((await api(manager, `/api/jobs/${taskId}`)).body.remarks, marker);
      const ctx = await context(), page = await ctx.newPage(); await login(page, fixture.identities.denied);
      const pdf = `/api/quotations/${taskId}/pdf`; expect(pdf, 403); expect(pdf, 404);
      const status = await page.evaluate(async path => (await fetch(path, { credentials: "same-origin", redirect: "error" })).status, pdf);
      result.observations.browserApiAssertions++; assert.ok([403, 404].includes(status)); await logout(page); await ctx.close();
    });
    if (options.responsiveAudit) {
      const audit = createResponsiveAudit(); responsiveAudit = audit;
      process.stdout.write(JSON.stringify({ responsiveArtifacts: audit.directory, scope: audit.scope }) + "\n");
      const managerScreens: { name: string; path: string; labels?: string[]; expandPipeline?: boolean }[] = [
        { name: "dashboard", path: "/dashboard" }, { name: "pipeline", path: "/pipeline" },
        { name: "pipeline-filters", path: "/pipeline", expandPipeline: true, labels: ["Find an agent", "Assigned agent"] },
        { name: "deals", path: "/deals" }, { name: "deal-create", path: "/deals/new", labels: ["First name", "Company name", "Description"] },
        { name: "items", path: "/items" }, { name: "item-create", path: "/items/new", labels: ["Item Name", "Description (Optional)"] },
        { name: "quotations", path: "/quotations" }, { name: "quotation-detail", path: `/quotations/${taskId}` },
        { name: "quotation-edit", path: `/quotations/${taskId}/edit`, labels: ["Quotation subject", "Item 1 discount (%)"] },
        { name: "quotation-create", path: "/quotations/new" },
        { name: "jobs", path: "/jobs" }, { name: "job-detail", path: `/jobs/${fixture.jobId}`, labels: ["Administrator remarks", "Job status"] },
        { name: "lead-detail", path: `/leads/${taskId}` }, { name: "employee-report", path: "/reports/employee-performance" },
        { name: "users", path: "/settings/users", labels: ["Search users"] }, { name: "permissions", path: "/settings/permissions" },
        { name: "permission-groups", path: "/settings/permission-groups" }, { name: "assign-permissions", path: "/settings/permissions/assign" },
        { name: "assign-departments", path: "/settings/users/departments" },
      ];
      for (const viewport of RESPONSIVE_VIEWPORTS) await check(`UI responsive audit ${viewport.name} ${viewport.width}x${viewport.height}`, async () => {
        currentStep = "Responsive manager navigation"; await visit(manager, "/dashboard");
        await auditResponsiveNavigation(manager, "manager", viewport, audit);
        for (const screen of managerScreens) {
          currentStep = `Responsive manager ${screen.name}`; await visit(manager, screen.path);
          if (screen.expandPipeline) {
            await manager.locator(".pipeline-filter-options > summary").click();
            await manager.locator(".pipeline-filter-options details > summary").click();
          }
          await captureResponsiveScreen(manager, "manager", screen.name, viewport, audit, screen.labels);
        }
        currentStep = "Responsive worker navigation"; await visit(worker, "/departments/Electrical/jobs");
        await auditResponsiveNavigation(worker, "worker", viewport, audit);
        await visit(worker, "/departments/Electrical/jobs");
        await captureResponsiveScreen(worker, "worker", "assigned-jobs", viewport, audit);
        await visit(worker, `/departments/Electrical/jobs/${fixture.jobId}`);
        await worker.getByRole("tab", { name: "Electrical", exact: true }).click();
        await captureResponsiveScreen(worker, "worker", "job-and-work-log", viewport, audit, ["Authority", "Log status", "Work notes"]);
      });
      await manager.setViewportSize({ width: 1440, height: 1000 });
      await worker.setViewportSize({ width: 1440, height: 1000 });
    }
    await check("UI responsive navigation and logout invalidates own synthetic sessions", async () => {
      await visit(manager, "/dashboard"); await button(manager, "Collapse navigation").click(); await button(manager, "Expand navigation").click();
      await manager.setViewportSize({ width: 390, height: 844 }); await button(manager, "Open navigation").click();
      await manager.getByRole("navigation", { name: "CRM navigation" }).getByRole("link", { name: "Dashboard", exact: true }).click();
      assert.equal(await button(manager, "Open navigation").getAttribute("aria-expanded"), "false");
      for (const path of ["/dashboard", "/pipeline", "/items", `/quotations/${taskId}`, "/jobs"]) { await visit(manager, path);
        assert.ok(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); }
      await manager.setViewportSize({ width: 1440, height: 1000 }); await logout(worker); await logout(manager);
      await visit(manager, "/account"); await manager.waitForURL(isolatedOrigin + "/login"); expect("/api/auth/me", 401);
      assert.equal((await api(manager, "/api/auth/me")).status, 401);
    });
    result.syntheticDatabase.foreignKeys = (db.pragma("foreign_key_check") as unknown[]).length === 0;
    result.syntheticDatabase.integrity = db.pragma("integrity_check", { simple: true }) === "ok";
    result.syntheticDatabase.remainingSessions = (db.prepare("SELECT COUNT(*) count FROM crm_sessions").get() as { count: number }).count;
    assert.equal(result.syntheticDatabase.foreignKeys, true); assert.equal(result.syntheticDatabase.integrity, true); assert.equal(result.syntheticDatabase.remainingSessions, 0);
    healthy();
    if (responsiveAudit) {
      current = "Responsive layout geometry"; currentStep = "Responsive layout measurements";
      assert.equal(responsiveAudit.samples.filter(sample => sample.issues.length > 0).length, 0, "Responsive audit found layout issues; inspect synthetic screenshots and receipt.");
    }
    result.status = "PASS";
  } catch (error) { result.failedCheck = current; result.failure = safeBrowserFailure(error, currentStep); }
  finally {
    if (responsiveAudit) {
      try { finishResponsiveAudit(responsiveAudit, result.status === "PASS"); }
      catch { result.status = "FAIL"; result.failedCheck ??= "Synthetic responsive artifact receipt"; }
      result.responsiveAudit = { status: responsiveAudit.status, directory: responsiveAudit.directory, samples: responsiveAudit.samples.length,
        issues: responsiveAudit.samples.reduce((count, sample) => count + sample.issues.length, 0), navigationChecks: responsiveAudit.navigation.length };
    }
    // Cleanup attempts are independent: a failed browser close must not skip
    // shutdown of the owned frontend/API or leak a partially seeded memory DB.
    const cleanup = await Promise.allSettled([
      (async () => { await browser?.close(); })(), stopOwned(child),
      (async () => { if (server) await server.stop(); else if (runtime) await runtime.close(); else ownedDatabase?.close(); })(),
    ]);
    result.servicesStopped = cleanup.every(value => value.status === "fulfilled");
    if (!result.servicesStopped) { result.status = "FAIL"; result.failedCheck ??= "Owned isolated service cleanup"; }
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options: ReturnType<typeof parseIsolatedBrowserArguments> | undefined;
  try { options = parseIsolatedBrowserArguments(process.argv.slice(2)); }
  catch { process.stderr.write("Explicit --synthetic-in-memory-only and optional --responsive-audit are the only accepted arguments; no application state was opened.\n"); process.exitCode = 1; }
  if (options) { const result = await runIsolatedBrowser(options); process.stdout.write(JSON.stringify(result) + "\n"); if (result.status !== "PASS") process.exitCode = 1; }
}
