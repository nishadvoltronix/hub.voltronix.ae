import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, errors, type Browser, type BrowserContext, type Download, type Page } from "playwright";
import { unzipSync } from "fflate";
import { assertDemoVerificationScope, preflightDemoSessionPolicy, type DemoVerificationScope } from "./verification-scope.js";

/** Explicit temporary-demo acceptance. Credentials arrive only in memory.
 * This module reads session metadata only to enforce the selected policy. It never starts a service, records browser state,
 * writes downloads/screenshots/traces, or prints credentials/browser errors. */
export interface DemoBrowserAccount { email: string; password: string }
export interface BrowserAcceptanceOptions {
  origin: string;
  verification: DemoVerificationScope;
  accounts: {
    browserManager: DemoBrowserAccount;
    browserWorker: DemoBrowserAccount;
    browserDenied: DemoBrowserAccount;
    quoteOwner?: DemoBrowserAccount;
    additionalWorkers?: { department: string; account: DemoBrowserAccount }[];
  };
  fixture: {
    jobId: string; leadId: string; contractingTaskId: string; switchgearTaskId: string;
    workerId: string; workerName: string;
  };
}
export interface BrowserAcceptanceResult {
  status: "PASS" | "FAILED";
  checks: { name: string; status: "PASS" }[];
  failedCheck?: string;
  failure?: SafeBrowserFailure;
  observations: {
    unexpectedConsoleErrors: number; pageErrors: number; unexpectedRequestFailures: number;
    unexpectedHttpErrors: number; expectedHttpRefusals: number; expectedConsoleRefusals: number;
    navigationAborts: number; blockedExternalRequests: number; sessionPolicyRefusals: number;
  };
  incomplete: readonly string[];
}
export interface SafeBrowserFailure {
  step: string;
  kind: "assertion" | "timeout" | "operation";
  actual?: number | boolean;
  expected?: number | boolean;
}
class BrowserStepError extends Error {
  constructor(readonly failure: SafeBrowserFailure) { super("A named browser step failed."); }
}
/** Return only controlled step names, an allowlisted class and numeric assertion
 * or boolean values. Never retain Playwright messages, stacks, DOM, URLs or submitted data. */
export function safeBrowserFailure(error: unknown, step = "Case assertions"): SafeBrowserFailure {
  if (error instanceof BrowserStepError) return error.failure;
  const assertion = error instanceof assert.AssertionError;
  return { step, kind: assertion ? "assertion" : error instanceof errors.TimeoutError ? "timeout" : "operation",
    ...(assertion && (typeof error.actual === "boolean" || typeof error.actual === "number" && Number.isFinite(error.actual)) ? { actual: error.actual } : {}),
    ...(assertion && (typeof error.expected === "boolean" || typeof error.expected === "number" && Number.isFinite(error.expected)) ? { expected: error.expected } : {}) };
}
async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw new BrowserStepError(safeBrowserFailure(error, name)); }
}
async function uiMutation(page: Page, name: string, path: string, method: string, click: () => Promise<unknown>, status = 200) {
  return step(name, async () => {
    const [response] = await Promise.all([
      page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method), click(),
    ]);
    assert.equal(response.status(), status);
    await response.finished(); await settle(page);
    return response;
  });
}
const departments = ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"];
const incomplete = [
  "Lead note/stage, deal, product and quotation submissions remain disabled pending the separate integration phase.",
  "Discounted quotation edits and unresolved legacy business rules remain blocked.",
  "SQLite browser acceptance does not verify MySQL, Zoho, historical migration or production readiness.",
];

export function allowedDemoBrowserRequest(origin: string, value: string): boolean {
  if (origin !== "http://127.0.0.1:3001") return false;
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password
      && !/%(?:2f|5c|00)/i.test(url.pathname) && !url.pathname.includes("\\")
      && (url.pathname === "/" || url.pathname.startsWith("/_next/static/") || url.pathname === "/favicon.ico"
        || /^\/legacy\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:css|png|jpg|jpeg|svg|woff2?|ttf|eot)$/.test(url.pathname)
        || /^\/(?:login|account|dashboard|pipeline|items|jobs|quotations)$/.test(url.pathname)
        || /^\/(?:jobs|leads|quotations)\/[1-9][0-9]{0,18}(?:\/edit)?$/.test(url.pathname)
        || /^\/(?:items|quotations|deals)\/new$/.test(url.pathname)
        || /^\/departments\/(?:Electrical|Civil|PM|Switchgear|Maintenance)\/jobs(?:\/[1-9][0-9]{0,18})?$/.test(url.pathname)
        || /^\/settings\/(?:users(?:\/departments)?|permissions(?:\/assign)?|permission-groups)$/.test(url.pathname)
        || url.pathname === "/reports/employee-performance"
        || /^\/api\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(url.pathname));
  } catch { return false; }
}

export function validateBrowserOptions(options: BrowserAcceptanceOptions): void {
  assertDemoVerificationScope(options.verification);
  assert.equal(options.origin, "http://127.0.0.1:3001", "Only the explicit loopback demo is accepted.");
  for (const value of [options.fixture.jobId, options.fixture.leadId, options.fixture.contractingTaskId,
    options.fixture.switchgearTaskId, options.fixture.workerId]) assert.match(value, /^[1-9][0-9]{0,18}$/);
  assert.ok(options.fixture.workerName.length > 0 && options.fixture.workerName.length <= 120);
  const accounts = [options.accounts.browserManager, options.accounts.browserWorker, options.accounts.browserDenied,
    ...(options.accounts.quoteOwner ? [options.accounts.quoteOwner] : []),
    ...(options.accounts.additionalWorkers ?? []).map(value => value.account)];
  for (const account of accounts) {
    assert.ok(typeof account.email === "string" && /^[^\s@]+@[^\s@]+\.(?:invalid|test)$/.test(account.email));
    assert.ok(typeof account.password === "string" && Buffer.byteLength(account.password, "utf8") >= 12
      && Buffer.byteLength(account.password, "utf8") <= 72 && !account.password.includes("\0"));
  }
  assert.equal(new Set([options.accounts.browserManager.email, options.accounts.browserWorker.email,
    options.accounts.browserDenied.email]).size, 3, "Separate browser identities are required.");
  for (const worker of options.accounts.additionalWorkers ?? []) assert.ok(departments.includes(worker.department));
}

async function bytesFromDownload(download: Download): Promise<Buffer> {
  assert.equal(await download.failure(), null);
  const stream = await download.createReadStream(); assert.ok(stream);
  const chunks: Buffer[] = []; let length = 0;
  for await (const part of stream) {
    const bytes = Buffer.from(part as Uint8Array); length += bytes.length;
    assert.ok(length <= 20 * 1024 * 1024, "Private download exceeded its bound."); chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
async function settle(page: Page) { await page.waitForLoadState("networkidle"); }
async function visit(page: Page, origin: string, path: string, heading?: string) {
  await step("Page HTTP response", async () => {
    const reply = await page.goto(origin + path, { waitUntil: "domcontentloaded" });
    assert.equal(reply?.status(), 200, "A positive page did not load.");
  });
  await step("Page heading", () => page.getByRole("heading", heading ? { name: heading, exact: true, level: 1 } : { level: 1 }).first().waitFor());
  await step("Page requests settled", () => settle(page));
  await step("Page application alerts", async () => {
    // Next's accessibility route announcer is itself role=alert, including on
    // an error-free login page. Exclude that exact framework element only.
    assert.equal(await page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ }).count(), 0,
      "A positive page displayed an application error.");
  });
}
async function login(page: Page, origin: string, account: DemoBrowserAccount) {
  await visit(page, origin, "/login");
  await step("Login email field", () => page.getByLabel("Email address", { exact: true }).fill(account.email));
  await step("Login password field", () => page.getByLabel("Password", { exact: true }).fill(account.password));
  await step("Login submit", () => page.getByRole("button", { name: /^(Login|Sign in)$/ }).click());
  await step("Login account redirect", () => page.waitForURL(url => url.origin === origin && ["/account", "/dashboard"].includes(url.pathname)));
  await step("Login account heading", () => page.getByRole("heading", { name: "Your account", exact: true }).waitFor());
  await step("Login requests settled", () => settle(page));
}
async function logout(page: Page, origin: string) {
  const profile = page.getByRole("button", { name: "User menu", exact: true });
  if (await profile.count() && !await page.getByRole("button", { name: "Sign out", exact: true }).isVisible()) await profile.click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(origin + "/login"); await settle(page);
  await page.goto(origin + "/account", { waitUntil: "domcontentloaded" });
  await page.waitForURL(origin + "/login"); await settle(page);
}
async function api(page: Page, path: string, method = "GET", body?: unknown, csrf = true) {
  assert.match(path, /^\/api\/[A-Za-z0-9/_?=&.%+-]+$/);
  return page.evaluate(async input => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (input.method !== "GET" && input.csrf) {
      const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin" });
      const value = await challenge.json() as { csrfToken: string }; headers["X-CSRF-Token"] = value.csrfToken;
    }
    const response = await fetch(input.path, { method: input.method, credentials: "same-origin", headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { path, method, body, csrf });
}

/** Requires already-running explicitly selected SQLite API and Next bridge.
 * Stop at the first failed check; only this function's browser is closed. */
export async function runBrowserAcceptance(options: BrowserAcceptanceOptions): Promise<BrowserAcceptanceResult> {
  const result: BrowserAcceptanceResult = { status: "FAILED", checks: [], observations: {
    unexpectedConsoleErrors: 0, pageErrors: 0, unexpectedRequestFailures: 0, unexpectedHttpErrors: 0,
    expectedHttpRefusals: 0, expectedConsoleRefusals: 0, navigationAborts: 0, blockedExternalRequests: 0, sessionPolicyRefusals: 0,
  }, incomplete };
  let current = "Browser configuration and installed executable", browser: Browser | undefined;
  const expected = new Map<string, Set<number>>();
  const expectHttp = (path: string, status: number) => {
    const values = expected.get(path) ?? new Set<number>(); values.add(status); expected.set(path, values);
  };
  const healthy = () => {
    assert.equal(result.observations.unexpectedConsoleErrors, 0, "Unexpected browser console errors.");
    assert.equal(result.observations.pageErrors, 0, "Browser exceptions.");
    assert.equal(result.observations.unexpectedRequestFailures, 0, "Unexpected failed browser requests.");
    assert.equal(result.observations.unexpectedHttpErrors, 0, "Unexpected HTTP/API errors.");
    assert.equal(result.observations.blockedExternalRequests, 0, "Application attempted external network access.");
    assert.equal(result.observations.sessionPolicyRefusals, 0, "Session preservation policy refused authentication.");
  };
  const check = async (name: string, work: () => Promise<void>) => {
    current = name; await work(); healthy(); result.checks.push({ name, status: "PASS" });
  };
  const context = async (): Promise<BrowserContext> => {
    assert.ok(browser);
    const value = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    value.setDefaultTimeout(20_000); value.setDefaultNavigationTimeout(25_000);
    await value.route("**/*", route => {
      if (new URL(route.request().url()).pathname === "/api/auth/login" && route.request().method() === "POST") {
        try { preflightDemoSessionPolicy(options.verification.sessionPolicy); }
        catch { result.observations.sessionPolicyRefusals++; return route.abort("blockedbyclient"); }
      }
      if (allowedDemoBrowserRequest(options.origin, route.request().url())) return route.continue();
      result.observations.blockedExternalRequests++; return route.abort("blockedbyclient");
    });
    await value.routeWebSocket("**/*", socket => { result.observations.blockedExternalRequests++; socket.close(); });
    value.on("page", page => {
      page.on("console", message => {
        if (message.type() !== "error") return;
        let permitted = false;
        try {
          const path = new URL(message.location().url).pathname;
          permitted = expected.has(path) && /^Failed to load resource: the server responded with a status of (400|401|403|404|409|413|415|429|503)\b/.test(message.text());
        } catch { /* Count without printing browser-controlled content. */ }
        if (permitted) result.observations.expectedConsoleRefusals++; else result.observations.unexpectedConsoleErrors++;
      });
      page.on("pageerror", () => { result.observations.pageErrors++; });
    });
    value.on("requestfailed", request => {
      // Navigation/render/download cancellation is counted separately;
      // every requested positive navigation/download is also asserted below.
      if (request.failure()?.errorText === "net::ERR_ABORTED" && allowedDemoBrowserRequest(options.origin, request.url())) result.observations.navigationAborts++;
      else result.observations.unexpectedRequestFailures++;
    });
    value.on("response", response => {
      if (response.status() < 400) return;
      const path = new URL(response.url()).pathname;
      if (expected.get(path)?.has(response.status())) result.observations.expectedHttpRefusals++;
      else result.observations.unexpectedHttpErrors++;
    });
    return value;
  };
  try {
    assertDemoVerificationScope(options.verification);
    preflightDemoSessionPolicy(options.verification.sessionPolicy);
    validateBrowserOptions(options);
    assert.ok(!["DEBUG", "PWDEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS"].some(name => process.env[name]));
    assert.ok(!process.execArgv.some(value => value.startsWith("--inspect")));
    assert.ok(existsSync(chromium.executablePath()), "Chromium is not installed; no download is attempted.");
    const environment: Record<string, string> = {};
    for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE", "HOME", "PATH"]) {
      const value = process.env[name]; if (value !== undefined) environment[name] = value;
    }
    browser = await chromium.launch({ headless: true, env: environment, timeout: 30_000,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync",
        "--no-first-run", "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
    const managerContext = await context(), manager = await managerContext.newPage();
    const marker = `SYNTHETIC BROWSER ${randomUUID()}`, suffix = randomBytes(6).toString("hex");
    await check("Browser manager login and permission-filtered CRM navigation", async () => {
      await login(manager, options.origin, options.accounts.browserManager);
      const navigation = manager.getByRole("navigation", { name: "CRM navigation" });
      await step("Expand original navigation groups", async () => {
        const collapsed = navigation.getByRole("button", { expanded: false });
        const count = await collapsed.count();
        for (let index = 0; index < count; index++) await collapsed.first().click();
        assert.equal(await collapsed.count(), 0);
      });
      for (const name of ["Dashboard", "Jobs", "Lead pipeline", "Products", "Quotations", "Employee report", "Users"]) {
        await navigation.getByRole("link", { name, exact: true }).waitFor();
      }
      await navigation.getByRole("link", { name: "Dashboard", exact: true }).click();
      await manager.getByRole("heading", { name: "Dashboard", exact: true }).waitFor(); await settle(manager);
    });
    await check("Dashboard pipeline lead notes/history and all management page reads", async () => {
      for (const [path, heading] of [["/pipeline", "Lead pipeline"], ["/jobs", "Jobs"], ["/items", "Items"],
        ["/quotations", "Quotations"], ["/settings/users", "Users"], ["/settings/permission-groups", "Permission groups"],
        ["/settings/permissions", "Permissions"], ["/settings/permissions/assign", "Assign Permissions"]]) {
        await visit(manager, options.origin, path!, heading!);
      }
      await visit(manager, options.origin, `/leads/${options.fixture.leadId}`);
      for (const part of ["notes", "history"]) {
        const response = await api(manager, `/api/leads/${options.fixture.leadId}/${part}`);
        assert.equal(response.status, 200); assert.ok(Array.isArray(response.body.items) && response.body.items.length > 0);
      }
    });
    await check("Job remarks and whole-job status persist across full page reload", async () => {
      await visit(manager, options.origin, `/jobs/${options.fixture.jobId}`);
      await manager.getByLabel("Administrator remarks", { exact: true }).fill(marker);
      const save = async (action: "remarks" | "status") => {
        const label = action === "remarks" ? "Save remarks" : "Save job status";
        await step(action === "remarks" ? "Job remarks save response" : "Job status save response", async () => {
          const saved = manager.waitForResponse(response => new URL(response.url()).pathname === `/api/jobs/${options.fixture.jobId}/${action}`
            && response.request().method() === "PATCH");
          await manager.getByRole("button", { name: label, exact: true }).click();
          assert.equal((await saved).status(), 200);
          await manager.getByRole("status").filter({ hasText: "Job saved." }).waitFor();
          await manager.waitForFunction(name => Array.from(document.querySelectorAll("button"))
            .some(button => button.textContent === name && !button.disabled), label);
          await settle(manager);
        });
      };
      await save("remarks");
      await visit(manager, options.origin, `/jobs/${options.fixture.jobId}`);
      await step("Job remarks persisted after reload", async () => {
        assert.equal(await manager.getByLabel("Administrator remarks", { exact: true }).inputValue(), marker);
      });
      for (const state of ["Hold", "Active"]) {
        await manager.getByLabel("Job status", { exact: true }).selectOption(state);
        await save("status");
        await visit(manager, options.origin, `/jobs/${options.fixture.jobId}`);
        await step(state === "Hold" ? "Job Hold status persisted after reload" : "Job Active status persisted after reload", async () => {
          assert.equal(await manager.getByLabel("Job status", { exact: true }).inputValue(), state);
        });
      }
    });
    await check("Department unassignment and reassignment through job UI", async () => {
      const assign = async () => {
        await manager.getByLabel("Assignment department", { exact: true }).selectOption("Electrical");
        await manager.getByLabel("Assignment user", { exact: true }).selectOption(options.fixture.workerId);
        await uiMutation(manager, "Electrical assignment response", `/api/jobs/${options.fixture.jobId}/assignments`, "POST",
          () => manager.getByRole("button", { name: "Assign department", exact: true }).click());
        await manager.getByRole("button", { name: "Unassign Electrical", exact: true }).waitFor();
      };
      // A prior retained partial run may have completed only unassignment.
      // Establish the same synthetic assignment through the real UI first.
      if (!await manager.getByRole("button", { name: "Unassign Electrical", exact: true }).count()) await assign();
      await uiMutation(manager, "Electrical unassignment response", `/api/jobs/${options.fixture.jobId}/unassign`, "POST",
        () => manager.getByRole("button", { name: "Unassign Electrical", exact: true }).click());
      await manager.getByRole("status").filter({ hasText: "Assignment saved." }).waitFor();
      await manager.getByRole("button", { name: "Unassign Electrical", exact: true }).waitFor({ state: "detached" });
      await assign();
      const response = await api(manager, `/api/jobs/${options.fixture.jobId}/assignments`);
      assert.equal(response.status, 200);
      const assignments = response.body.assignments as { department: string; userId: string | null }[];
      await step("Electrical assignment persisted", async () => {
        assert.ok(assignments.some(value => value.department === "Electrical" && value.userId === options.fixture.workerId));
      });
    });
    await check("Task attachment private bytes and invalid extension refusal", async () => {
      await visit(manager, options.origin, `/jobs/${options.fixture.jobId}`);
      const fileName = `synthetic-browser-${suffix}.txt`, bytes = Buffer.from(marker);
      await manager.getByLabel("Attachment file", { exact: true }).setInputFiles({ name: fileName, mimeType: "text/plain", buffer: bytes });
      await uiMutation(manager, "Task attachment upload response", `/api/leads/${options.fixture.jobId}/attachments`, "POST",
        () => manager.getByRole("button", { name: "Upload attachment", exact: true }).click());
      await manager.getByRole("status").filter({ hasText: "Attachment saved." }).waitFor(); await settle(manager);
      const download = manager.waitForEvent("download"); await manager.getByRole("link", { name: fileName, exact: true }).click();
      assert.deepEqual(await bytesFromDownload(await download), bytes);
      expectHttp(`/api/leads/${options.fixture.jobId}/attachments`, 415);
      await manager.getByLabel("Attachment file", { exact: true }).setInputFiles({ name: "synthetic-blocked.php", mimeType: "text/plain", buffer: bytes });
      const refusal = manager.waitForResponse(value => new URL(value.url()).pathname === `/api/leads/${options.fixture.jobId}/attachments` && value.request().method() === "POST");
      await manager.getByRole("button", { name: "Upload attachment", exact: true }).click(); assert.equal((await refusal).status(), 415);
      await manager.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ }).waitFor(); await settle(manager);
    });
    await check("Both company quotation PDFs download as authorized private files", async () => {
      for (const id of [options.fixture.contractingTaskId, options.fixture.switchgearTaskId]) {
        await visit(manager, options.origin, `/quotations/${id}`);
        const download = manager.waitForEvent("download");
        await manager.getByRole("link", { name: "Download quotation PDF", exact: true }).click();
        const bytes = await bytesFromDownload(await download);
        assert.equal(bytes.subarray(0, 8).toString(), "%PDF-1.7"); assert.ok(bytes.length > 1000);
      }
    });
    await check("Employee report and real central XLSX download", async () => {
      await visit(manager, options.origin, "/reports/employee-performance", "Employee performance");
      await manager.getByRole("region", { name: "Report summary", exact: true }).waitFor();
      const report = await api(manager, "/api/reports/employee-performance"); assert.equal(report.status, 200);
      assert.equal(report.body.timeZone, "Asia/Dubai");
      await visit(manager, options.origin, "/jobs", "Jobs");
      const download = manager.waitForEvent("download"); await manager.getByRole("link", { name: "Export jobs (XLSX)", exact: true }).click();
      const workbook = unzipSync(await bytesFromDownload(await download));
      assert.ok(workbook["xl/workbook.xml"] && workbook["xl/worksheets/sheet1.xml"]);
      assert.ok(!Object.keys(workbook).some(name => /vbaProject|externalLinks/i.test(name)));
    });
    const createdAccount = { email: `browser-created-${suffix}@example.invalid`, password: randomBytes(24).toString("base64url") };
    let createdId = "";
    await check("User create edit department assignment and native form validation", async () => {
      await visit(manager, options.origin, "/settings/users", "Users");
      const editor = manager.getByRole("region", { name: "User editor", exact: true });
      await editor.getByLabel("Name", { exact: true }).fill(`Synthetic browser account ${suffix}`);
      await editor.getByLabel("Email address", { exact: true }).fill(createdAccount.email);
      await step("Native short-password validation", async () => {
        const passwordField = editor.getByLabel("Password", { exact: true });
        await passwordField.fill(""); await passwordField.pressSequentially("short");
        await editor.getByRole("button", { name: "Create user", exact: true }).click();
        // Pass a function, not a string containing an unevaluated arrow function.
        // Real keystrokes also exercise the native minimum-length constraint.
        assert.equal(await passwordField.evaluate(element => (element as HTMLInputElement).checkValidity()), false);
        assert.equal(await passwordField.evaluate(element => (element as HTMLInputElement).validationMessage.length > 0), true);
      });
      await editor.getByLabel("Password", { exact: true }).fill(createdAccount.password);
      const createdResponse = await uiMutation(manager, "Synthetic user create response", "/api/settings/users", "POST",
        () => editor.getByRole("button", { name: "Create user", exact: true }).click(), 201);
      createdId = String((await createdResponse.json() as { id: string }).id);
      await manager.getByRole("status").filter({ hasText: "User created." }).waitFor(); await settle(manager);
      await manager.getByLabel("Search users", { exact: true }).fill(createdAccount.email);
      await manager.getByRole("region", { name: "User list", exact: true }).getByRole("button", { name: "Search", exact: true }).click(); await settle(manager);
      const row = manager.getByRole("row").filter({ hasText: createdAccount.email });
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      await editor.getByLabel("Name", { exact: true }).fill(`Synthetic edited account ${suffix}`);
      await uiMutation(manager, "Synthetic user edit response", `/api/settings/users/${createdId}`, "PATCH",
        () => editor.getByRole("button", { name: "Save user", exact: true }).click());
      await manager.getByRole("status").filter({ hasText: "User updated." }).waitFor(); await settle(manager);
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      await manager.getByLabel("Department", { exact: true }).selectOption("Electrical");
      await uiMutation(manager, "Synthetic user department response", `/api/settings/users/${createdId}/department`, "PUT",
        () => manager.getByRole("button", { name: "Assign department", exact: true }).click());
      await manager.getByRole("status").filter({ hasText: "Department assigned." }).waitFor(); await settle(manager);
      const users = await api(manager, "/api/settings/users?query=" + encodeURIComponent(createdAccount.email));
      assert.equal(users.status, 200);
      const found = (users.body.items as { id: string; email: string; departmentRole: string }[]).find(value => value.email === createdAccount.email);
      await step("Created synthetic user persists", async () => { assert.equal(!!found, true); });
      assert.ok(found);
      await step("Synthetic user department persists", async () => { assert.equal(found.departmentRole === "Electrical", true); });
      createdId = found.id;
    });
    await check("Permission grants take effect and revocation removes authenticated access", async () => {
      const createdContext = await context(), created = await createdContext.newPage();
      try {
        await login(created, options.origin, createdAccount);
        assert.equal(await created.getByRole("navigation", { name: "CRM navigation" }).getByRole("link", { name: "Dashboard", exact: true }).count(), 0);
        await visit(manager, options.origin, `/settings/permissions/assign?userId=${createdId}`, "Assign Permissions");
        const catalogue = await api(manager, "/api/settings/permissions?query=dashboard.view&pageSize=100");
        assert.equal(catalogue.status, 200);
        const dashboardPermissions = (catalogue.body.items as { id: string; key: string }[]).filter(permission => permission.key === "dashboard.view");
        assert.equal(dashboardPermissions.length, 1);
        const permissionId = dashboardPermissions[0]!.id;
        assert.match(permissionId, /^[1-9][0-9]{0,18}$/);
        await manager.getByLabel("Find permissions", { exact: true }).fill("dashboard.view");
        await manager.getByRole("button", { name: "Search", exact: true }).click(); await settle(manager);
        const grant = manager.locator(`input[type="checkbox"][name="permissions[]"][value="${permissionId}"]`); await grant.check();
        await uiMutation(manager, "Synthetic permission grant response", `/api/settings/users/${createdId}/permissions`, "PUT",
          () => manager.getByRole("button", { name: "Save", exact: true }).click());
        await manager.getByRole("status").filter({ hasText: "Permissions saved." }).waitFor(); await settle(manager);
        await created.reload({ waitUntil: "domcontentloaded" }); await settle(created);
        await created.getByRole("link", { name: "Dashboard", exact: true }).waitFor();
        assert.equal((await api(created, "/api/dashboard")).status, 200);
        await grant.uncheck();
        await uiMutation(manager, "Synthetic permission revoke response", `/api/settings/users/${createdId}/permissions`, "PUT",
          () => manager.getByRole("button", { name: "Save", exact: true }).click());
        expectHttp("/api/dashboard", 403); assert.equal((await api(created, "/api/dashboard")).status, 403);
        await created.reload({ waitUntil: "domcontentloaded" }); await settle(created);
        assert.equal(await created.getByRole("link", { name: "Dashboard", exact: true }).count(), 0);
        await logout(created, options.origin);
      } finally { await createdContext.close(); }
      await visit(manager, options.origin, "/settings/users", "Users");
      await manager.getByLabel("Search users", { exact: true }).fill(createdAccount.email);
      await manager.getByRole("region", { name: "User list", exact: true }).getByRole("button", { name: "Search", exact: true }).click(); await settle(manager);
      await uiMutation(manager, "Synthetic user deactivate response", `/api/settings/users/${createdId}/status`, "POST",
        () => Promise.all([
          manager.waitForEvent("dialog").then(async dialog => {
            assert.equal(dialog.type(), "confirm"); assert.equal(dialog.message(), "Change user status?");
            await dialog.accept();
          }),
          manager.getByRole("row").filter({ hasText: createdAccount.email }).getByRole("button", { name: "Deactivate", exact: true }).click(),
        ]));
      await manager.getByRole("status").filter({ hasText: "User deactivated." }).waitFor(); await settle(manager);
    });
    await check("Permission catalogue create and edit through protected settings UI", async () => {
      for (const [path, noun, key] of [["permission-groups", "group", `browser_${suffix}`], ["permissions", "permission", `browser.${suffix}`]]) {
        await visit(manager, options.origin, `/settings/${path}`);
        const editor = manager.getByRole("region", { name: "Definition editor", exact: true });
        await editor.getByLabel("Key", { exact: true }).fill(key!);
        await editor.getByLabel("Label", { exact: true }).fill(`Synthetic definition ${suffix}`);
        if (noun === "permission") {
          await editor.getByLabel("Permission group", { exact: true }).selectOption({ label: `Synthetic edited definition ${suffix}` });
        }
        const created = await uiMutation(manager, noun === "group" ? "Permission group create response" : "Permission definition create response",
          `/api/settings/${path}`, "POST", () => editor.getByRole("button", { name: `Create ${noun}`, exact: true }).click(), 201);
        const id = String((await created.json() as { id: string }).id);
        await manager.getByLabel(noun === "group" ? "Search groups" : "Search permissions", { exact: true }).fill(key!);
        await manager.getByRole("region", { name: "Definition list", exact: true }).getByRole("button", { name: "Search", exact: true }).click();
        await settle(manager);
        const row = manager.getByRole("row").filter({ hasText: key! }); await row.getByRole("button", { name: "Edit", exact: true }).click();
        await editor.getByLabel("Label", { exact: true }).fill(`Synthetic edited definition ${suffix}`);
        await uiMutation(manager, noun === "group" ? "Permission group edit response" : "Permission definition edit response",
          `/api/settings/${path}/${id}`, "PATCH", () => editor.getByRole("button", { name: `Save ${noun}`, exact: true }).click());
        await step(noun === "group" ? "Permission group edited label" : "Permission definition edited label", async () => {
          // The permission label and its selected group label intentionally
          // share the synthetic marker; assert the Label column specifically.
          await row.getByRole("cell").nth(1).filter({ hasText: new RegExp(`^Synthetic edited definition ${suffix}$`) }).waitFor();
        });
      }
    });
    await check("API validation CSRF stale-version and disabled integration responses", async () => {
      const jobPath = `/api/jobs/${options.fixture.jobId}`, remarksPath = jobPath + "/remarks";
      const initial = await api(manager, jobPath); assert.equal(initial.status, 200);
      expectHttp(remarksPath, 403); assert.equal((await api(manager, remarksPath, "PATCH", { expectedVersion: initial.body.version, remarks: marker }, false)).status, 403);
      expectHttp(remarksPath, 400); assert.equal((await api(manager, remarksPath, "PATCH", { expectedVersion: initial.body.version, remarks: marker, invented: true })).status, 400);
      const changed = await api(manager, remarksPath, "PATCH", { expectedVersion: initial.body.version, remarks: marker }); assert.equal(changed.status, 200);
      expectHttp(remarksPath, 409); assert.equal((await api(manager, remarksPath, "PATCH", { expectedVersion: initial.body.version, remarks: marker })).status, 409);
      const caps = await api(manager, `/api/leads/${options.fixture.leadId}/capabilities`); assert.equal(caps.status, 200); assert.equal(caps.body.integrationAvailable, false);
      expectHttp("/api/items", 503);
      assert.equal((await api(manager, "/api/items", "POST", { operationId: randomUUID(), name: "Synthetic blocked product", description: "No external request" })).status, 503);
      await settle(manager);
    });
    const workerContext = await context(), worker = await workerContext.newPage();
    await check("Assigned department queue work-log bytes and status persistence", async () => {
      await login(worker, options.origin, options.accounts.browserWorker);
      await visit(worker, options.origin, "/departments/Electrical/jobs", "Electrical jobs");
      await visit(worker, options.origin, `/departments/Electrical/jobs/${options.fixture.jobId}`);
      await worker.getByRole("tab", { name: "Electrical", exact: true }).click();
      await worker.getByLabel("Authority", { exact: true }).selectOption("DESIGN");
      await worker.getByLabel("Log status", { exact: true }).selectOption("DRAWING PREPARATION");
      await worker.getByLabel("Work notes", { exact: true }).fill(marker);
      const gif = Buffer.from("47494638376101000100800000000000ffffff2c00000000010001000002024401003b", "hex");
      const name = `synthetic-log-${suffix}.gif`;
      await worker.getByLabel("Work log attachment (optional)", { exact: true }).setInputFiles({ name, mimeType: "image/gif", buffer: gif });
      await uiMutation(worker, "Department work log upload response", `/api/departments/Electrical/jobs/${options.fixture.jobId}/logs`, "POST",
        () => worker.getByRole("button", { name: "Add work log", exact: true }).click());
      await worker.getByRole("status").filter({ hasText: "Work log added." }).waitFor(); await settle(worker);
      const download = worker.waitForEvent("download"); await worker.getByRole("link", { name, exact: true }).click();
      assert.deepEqual(await bytesFromDownload(await download), gif);
      await worker.getByRole("button", { name: "Update Status", exact: true }).click();
      await worker.getByLabel("Department status", { exact: true }).selectOption("Process");
      await uiMutation(worker, "Department status save response", `/api/departments/Electrical/jobs/${options.fixture.jobId}/status`, "PATCH",
        () => worker.getByRole("button", { name: "Save department status", exact: true }).click());
      await worker.getByRole("status").filter({ hasText: "Department status saved." }).waitFor(); await settle(worker);
      await worker.reload({ waitUntil: "domcontentloaded" }); await settle(worker);
      await worker.getByRole("tab", { name: "Electrical", exact: true }).click();
      assert.equal(await worker.getByLabel("Department status", { exact: true }).inputValue(), "Process");
      await worker.getByRole("region", { name: "Work log history", exact: true }).getByText(marker, { exact: true }).waitFor();
    });
    await check("Department XLSX export and remaining department role navigation", async () => {
      await visit(worker, options.origin, "/departments/Electrical/jobs", "Electrical jobs");
      const download = worker.waitForEvent("download"); await worker.getByRole("link", { name: "Export assigned jobs (XLSX)", exact: true }).click();
      assert.ok(unzipSync(await bytesFromDownload(await download))["xl/worksheets/sheet1.xml"]);
      for (const selected of options.accounts.additionalWorkers ?? []) {
        if (selected.department === "Electrical") continue;
        const otherContext = await context(), other = await otherContext.newPage();
        try {
          await login(other, options.origin, selected.account);
          await visit(other, options.origin, `/departments/${selected.department}/jobs`, `${selected.department} jobs`);
          await visit(other, options.origin, `/departments/${selected.department}/jobs/${options.fixture.jobId}`);
          await logout(other, options.origin);
        } finally { await otherContext.close(); }
      }
    });
    await check("Commercial and lead controls honestly show unavailable remote mutations", async () => {
      await visit(manager, options.origin, `/leads/${options.fixture.leadId}`);
      for (const name of ["Update Status", "Add Note"]) {
        const button = manager.getByRole("button", { name, exact: true }); if (await button.count()) assert.equal(await button.isDisabled(), true);
      }
      await visit(manager, options.origin, "/items/new", "Create Item");
      assert.equal(await manager.getByRole("button", { name: "Save Item", exact: true }).isDisabled(), true);
      await visit(manager, options.origin, "/deals/new", "Create deal");
      assert.equal(await manager.getByRole("button", { name: "Create deal", exact: true }).isDisabled(), true);
      await visit(manager, options.origin, "/quotations/new", "Create quotation");
      if (options.accounts.quoteOwner) {
        const ownerContext = await context(), owner = await ownerContext.newPage();
        try {
          await login(owner, options.origin, options.accounts.quoteOwner);
          await visit(owner, options.origin, `/quotations/${options.fixture.contractingTaskId}/edit`, "Edit quotation");
          assert.equal(await owner.getByRole("button", { name: "Save quotation", exact: true }).isDisabled(), true);
          await owner.getByRole("button", { name: "Calculate preview totals", exact: true }).click();
          await owner.getByRole("status").filter({ hasText: "Preview only. Subtotal:" }).waitFor();
          const quote = await api(owner, `/api/quotations/${options.fixture.contractingTaskId}`); assert.equal(quote.status, 200);
          const totals = quote.body.totals as { grandTotal: string };
          await owner.getByText(new RegExp(`grand total: ${totals.grandTotal.replace(".", "\\.")} AED`)).waitFor();
          await logout(owner, options.origin);
        } finally { await ownerContext.close(); }
      }
    });
    await check("Original sidebar desktop collapse mobile drawer profile and keyboard department tabs", async () => {
      await manager.setViewportSize({ width: 1440, height: 1000 });
      await visit(manager, options.origin, "/dashboard", "Dashboard");
      await step("Original sidebar and header geometry", async () => {
        assert.equal(Math.round((await manager.locator(".pc-sidebar").boundingBox())!.width), 264);
        assert.equal(Math.round((await manager.locator(".pc-header").boundingBox())!.height), 74);
      });
      await manager.getByRole("button", { name: "Collapse navigation", exact: true }).click();
      await manager.getByRole("button", { name: "Expand navigation", exact: true }).click();
      await manager.setViewportSize({ width: 390, height: 844 });
      await manager.getByRole("button", { name: "Open navigation", exact: true }).click();
      await step("Mobile drawer opened", async () => {
        await manager.waitForFunction(() => (document.querySelector(".pc-sidebar")?.getBoundingClientRect().x ?? -264) >= -1);
        assert.equal(await manager.getByRole("button", { name: "Open navigation", exact: true, includeHidden: true }).getAttribute("aria-expanded"), "true");
        assert.ok((await manager.locator(".pc-sidebar").boundingBox())!.x >= -1);
      });
      await manager.keyboard.press("Escape");
      assert.equal(await manager.getByRole("button", { name: "Open navigation", exact: true }).getAttribute("aria-expanded"), "false");
      await manager.getByRole("button", { name: "Open navigation", exact: true }).click();
      await manager.getByRole("navigation", { name: "CRM navigation" }).getByRole("link", { name: "Dashboard", exact: true }).click();
      assert.equal(await manager.getByRole("button", { name: "Open navigation", exact: true }).getAttribute("aria-expanded"), "false");
      await manager.getByRole("button", { name: "User menu", exact: true }).click();
      await manager.getByRole("button", { name: "Sign out", exact: true }).waitFor();
      await manager.keyboard.press("Escape");
      assert.equal(await manager.getByRole("button", { name: "User menu", exact: true }).getAttribute("aria-expanded"), "false");
      await manager.setViewportSize({ width: 1280, height: 900 });
      await visit(manager, options.origin, `/jobs/${options.fixture.jobId}`);
      await manager.getByRole("tab", { name: "Electrical", exact: true }).click();
      await manager.getByRole("heading", { name: "Electrical Details", exact: true }).waitFor();
      await manager.getByRole("tab", { name: "Electrical", exact: true }).press("ArrowRight");
      await manager.getByRole("heading", { name: "Civil Details", exact: true }).waitFor();
      await manager.getByRole("tab", { name: "Civil", exact: true }).press("Home");
      await manager.getByRole("button", { name: "Save remarks", exact: true }).waitFor();
      await settle(manager);
    });
    await check("Responsive CRM pages at 360 and 1280 pixels without document overflow", async () => {
      const paths = ["/account", "/dashboard", "/pipeline", `/leads/${options.fixture.leadId}`, "/jobs", `/jobs/${options.fixture.jobId}`,
        "/items", "/quotations", `/quotations/${options.fixture.contractingTaskId}`, "/reports/employee-performance", "/settings/users", "/settings/permissions"];
      for (const width of [360, 1280]) {
        await manager.setViewportSize({ width, height: 900 });
        for (const path of paths) {
          await visit(manager, options.origin, path);
          await step(`Responsive ${width}px ${path.replace(/\/[1-9][0-9]*/g, "/:id")}`, async () => {
            assert.equal(await manager.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true,
              "A CRM page overflows the viewport.");
          });
        }
        await worker.setViewportSize({ width, height: 900 });
        for (const path of ["/departments/Electrical/jobs", `/departments/Electrical/jobs/${options.fixture.jobId}`]) {
          await visit(worker, options.origin, path);
          await step(`Responsive ${width}px ${path.replace(/\/[1-9][0-9]*/g, "/:id")}`, async () => {
            assert.equal(await worker.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), true,
              "A department page overflows the viewport.");
          });
        }
      }
    });
    await check("Denied identity and logout cannot access protected CRM pages or API", async () => {
      const deniedContext = await context(), denied = await deniedContext.newPage();
      try {
        await login(denied, options.origin, options.accounts.browserDenied);
        assert.equal(await denied.getByRole("link", { name: "Jobs", exact: true }).count(), 0);
        expectHttp("/api/jobs", 403); assert.equal((await api(denied, "/api/jobs")).status, 403);
        expectHttp("/jobs", 404);
        const response = await denied.goto(options.origin + "/jobs", { waitUntil: "domcontentloaded" }); assert.equal(response?.status(), 404); await settle(denied);
        await visit(denied, options.origin, "/account", "Your account"); await logout(denied, options.origin);
        expectHttp("/api/auth/me", 401); assert.equal((await api(denied, "/api/auth/me")).status, 401); await settle(denied);
      } finally { await deniedContext.close(); }
      await visit(manager, options.origin, "/account", "Your account"); await logout(manager, options.origin);
      await visit(worker, options.origin, "/account", "Your account"); await logout(worker, options.origin);
      await workerContext.close(); await managerContext.close();
    });
    healthy(); result.status = "PASS";
  } catch (error) { result.failedCheck = current; result.failure = safeBrowserFailure(error); }
  finally {
    if (browser) {
      try { await browser.close(); }
      catch { result.status = "FAILED"; result.failedCheck ??= "Owned browser shutdown"; }
    }
  }
  return result;
}
