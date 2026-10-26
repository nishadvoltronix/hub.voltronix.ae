import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, errors, type Browser, type BrowserContext, type Download, type Page } from "playwright";
import { unzipSync } from "fflate";
import { privateAccess } from "../scripts/mysql-auth/files.js";
import { allowedDemoBrowserRequest, safeBrowserFailure, type SafeBrowserFailure } from "./browser-acceptance.js";
import { demoConfiguration, privateDirectory, writePrivateNew } from "./storage.js";
import { UI_CAPTURE_VIEWPORTS } from "./ui-capture.js";

/** Only the caller supplies credentials, in memory. No private credential
 * reader, process launcher, database access, account provisioning or CLI exists. */
export interface CurrentUserBrowserOptions {
  origin: string;
  readOnly?: boolean;
  account: { email: string; password: string };
  fixture: { jobId: string; leadId: string; contractingTaskId: string; switchgearTaskId: string };
}
type CaseStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
interface Metric {
  screen: string; viewport: string; width: number; height: number; documentWidth: number;
  selectors: Record<string, null | { x: number; y: number; width: number; height: number; background: string;
    color: string; fontFamily: string; fontSize: string; padding: string; borderRadius: string }>;
}
export interface CurrentUserBrowserResult {
  status: "PASS" | "FAIL";
  mode: "read-only" | "synthetic-writes";
  loginAttempts: number;
  attemptedBusinessWrites: number;
  completedBusinessWrites: number;
  scope: string;
  startedAt: string;
  finishedAt?: string;
  directory: string;
  receipt: string;
  cases: { name: string; status: CaseStatus; reason?: string; failure?: SafeBrowserFailure }[];
  counts: Record<"pass" | "fail" | "blocked" | "notRun", number>;
  observations: { unexpectedConsoleErrors: number; pageErrors: number; unexpectedRequestFailures: number;
    unexpectedHttpErrors: number; expectedHttpRefusals: number; expectedConsoleRefusals: number;
    navigationAborts: number; blockedRequests: number };
  images: { screen: string; viewport: string; filename: string }[];
  artifacts: { kind: "pdf"; template: "contracting" | "switchgear"; filename: string; bytes: number }[];
  metrics: Metric[];
  created: { productId?: string; noteId?: string };
  departmentQueues: { department: string; visibleJobs: number }[];
  accountInvariant?: { totalUsers: number; activeUsers: number; currentUserId: string; unchanged: boolean };
}
const origin = "http://127.0.0.1:3001";
const idPattern = /^[1-9][0-9]{0,18}$/;
const caseNames = [
  "Anonymous protected API refuses access",
  "Authorized current user logs in normally",
  "Current identity and preserved account states",
  "Navigation and protected settings reads",
  "Dashboard pipeline lead notes and history reads",
  "Synthetic job remarks status and security refusals persist",
  "Synthetic private attachment round-trip and unsafe extension refusal",
  "Local product creation persists after reload",
  "Local lead note creation and edit persist after reload",
  "Authorized quotation PDFs and central Excel export",
  "Reports filters and current-user department reads",
  "Sidebar mobile drawer profile and keyboard department tabs",
  "Responsive screenshots and original-theme geometry",
  "Account states remain unchanged and logout revokes this session",
  "Created deals job cohorts and read-only assignment catalogue",
] as const;

export function validateCurrentUserBrowserOptions(options: CurrentUserBrowserOptions): void {
  assert.equal(options.origin, origin);
  assert.ok(options.readOnly === undefined || typeof options.readOnly === "boolean");
  for (const value of Object.values(options.fixture)) assert.match(value, idPattern);
  assert.ok(typeof options.account.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.account.email)
    && options.account.email.length <= 254);
  assert.ok(typeof options.account.password === "string" && Buffer.byteLength(options.account.password) > 0
    && Buffer.byteLength(options.account.password) <= 72 && !options.account.password.includes("\0"));
}

/** Narrower than the general fixture harness: settings and assignments are
 * always read-only; note edits are confined to this run's newly created note. */
export function allowedCurrentUserRequest(options: Pick<CurrentUserBrowserOptions, "origin" | "fixture" | "readOnly">,
  value: string, method: string, createdNoteId?: string): boolean {
  // The historical fixture harness predates the created-deals list. Extend
  // only this verifier's exact read route, including Next's RSC prefetch query.
  let createdDealsRead: boolean;
  try {
    const url = new URL(value);
    createdDealsRead = options.origin === origin && url.origin === origin && !url.username && !url.password
      && url.pathname === "/deals" && (method === "GET" || method === "HEAD");
  } catch { return false; }
  if (!createdDealsRead && !allowedDemoBrowserRequest(options.origin, value)) return false;
  const path = new URL(value).pathname;
  if (method === "GET" || method === "HEAD") return true;
  if (options.readOnly) return method === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(path);
  if (method === "POST") return ["/api/auth/login", "/api/auth/logout", "/api/items",
    `/api/leads/${options.fixture.leadId}/notes`, `/api/leads/${options.fixture.jobId}/attachments`].includes(path);
  if (method === "PATCH") return [`/api/jobs/${options.fixture.jobId}/remarks`, `/api/jobs/${options.fixture.jobId}/status`].includes(path)
    || !!createdNoteId && idPattern.test(createdNoteId) && path === `/api/leads/${options.fixture.leadId}/notes/${createdNoteId}`;
  return false;
}

/** Playwright action timeouts do not bound evaluate(), response bodies or close(). */
export async function boundedBrowserOperation<T>(work: Promise<T>, milliseconds = 20_000): Promise<T> {
  assert.ok(Number.isInteger(milliseconds) && milliseconds > 0 && milliseconds <= 60_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new errors.TimeoutError("Bounded browser operation timed out.")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 20_000 });
  await boundedBrowserOperation(page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === "running" && typeof end === "number" && Number.isFinite(end) && end <= 5_000;
    }).map(animation => animation.finished.catch(() => undefined)));
  }), 10_000);
}
async function api(page: Page, path: string, method = "GET", body?: unknown, csrf = true) {
  assert.match(path, /^\/api\/[A-Za-z0-9/_?=&.%+-]+$/);
  return boundedBrowserOperation(page.evaluate(async input => {
    const signal = AbortSignal.timeout(15_000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (input.method !== "GET" && input.csrf) {
      const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin", signal });
      const value = await challenge.json() as { csrfToken: string }; headers["X-CSRF-Token"] = value.csrfToken;
    }
    const response = await fetch(input.path, { method: input.method, credentials: "same-origin", headers, signal,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { path, method, body, csrf }));
}
async function downloadBytes(download: Download): Promise<Buffer> {
  assert.equal(await boundedBrowserOperation(download.failure()), null);
  const stream = await boundedBrowserOperation(download.createReadStream()); assert.ok(stream);
  const chunks: Buffer[] = []; let length = 0;
  try {
    return await boundedBrowserOperation((async () => {
      for await (const chunk of stream) { const bytes = Buffer.from(chunk as Uint8Array); length += bytes.length;
        assert.ok(length <= 20 * 1024 * 1024); chunks.push(bytes); }
      return Buffer.concat(chunks);
    })());
  } finally { stream.destroy(); }
}
async function capture(page: Page, result: CurrentUserBrowserResult, screen: string, progress?: (stage: string) => void): Promise<void> {
  for (const viewport of UI_CAPTURE_VIEWPORTS) {
    progress?.(`Capture ${screen} at ${viewport.name}`);
    await page.setViewportSize(viewport); await settle(page);
    const metric = await boundedBrowserOperation(page.evaluate(() => {
      const selectors: Metric["selectors"] = {};
      for (const selector of [".pc-sidebar", ".pc-header", ".pc-container", ".pc-content", ".auth-sidecontent .card"]) {
        const element = document.querySelector(selector);
        if (!element) { selectors[selector] = null; continue; }
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        selectors[selector] = { x: box.x, y: box.y, width: box.width, height: box.height, background: style.backgroundColor,
          color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, padding: style.padding, borderRadius: style.borderRadius };
      }
      return { documentWidth: document.documentElement.scrollWidth, selectors };
    }));
    result.metrics.push({ screen, viewport: viewport.name, width: viewport.width, height: viewport.height, ...metric });
    const filename = `${viewport.name}-${screen}.png`;
    const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const bytes = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide", maskColor: "#d5d9df",
      mask: [page.locator('input[type="email"],input[type="password"],input[name="email"]'),
        page.getByText(emailPattern),
        page.locator("select").filter({ has: page.locator("option").filter({ hasText: emailPattern }) })] });
    assert.ok(bytes.length <= 20 * 1024 * 1024);
    const path = join(result.directory, filename), descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); bytes.fill(0); }
    privateAccess(path, false);
    result.images.push({ screen, viewport: viewport.name, filename });
    if (metric.documentWidth > viewport.width + 1) {
      const offenders = await boundedBrowserOperation(page.evaluate(() => [...document.querySelectorAll("body *")]
        .filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.right > innerWidth + 1 || box.x < -1); })
        .slice(0, 80).map(element => {
          const box = element.getBoundingClientRect();
          return { tagName: element.tagName, className: typeof element.className === "string" ? element.className.slice(0, 240) : "",
            rect: { x: box.x, width: box.width, right: box.right }, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
        })));
      writePrivateNew(join(result.directory, `${viewport.name}-${screen}-overflow.json`), {
        screen, viewport: viewport.name, width: viewport.width, documentWidth: metric.documentWidth, offenders,
      });
    }
    assert.ok(metric.documentWidth <= viewport.width + 1);
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await settle(page);
}

export async function runCurrentUserAcceptance(options: CurrentUserBrowserOptions): Promise<CurrentUserBrowserResult> {
  validateCurrentUserBrowserOptions(options);
  demoConfiguration(process.env);
  const directory = privateDirectory(["evidence", `current-user-${randomUUID()}`], true);
  const result: CurrentUserBrowserResult = { status: "FAIL", mode: options.readOnly ? "read-only" : "synthetic-writes",
    loginAttempts: 0, attemptedBusinessWrites: 0, completedBusinessWrites: 0,
    scope: "Current authorized user15 only; existing accounts and grants remain unchanged. Passing supported cases do not close explicitly blocked role or integration cases.",
    startedAt: new Date().toISOString(), directory, receipt: join(directory, "receipt.json"), cases: [],
    counts: { pass: 0, fail: 0, blocked: 0, notRun: 0 }, images: [], artifacts: [], metrics: [], created: {}, departmentQueues: [], observations: {
      unexpectedConsoleErrors: 0, pageErrors: 0, unexpectedRequestFailures: 0, unexpectedHttpErrors: 0,
      expectedHttpRefusals: 0, expectedConsoleRefusals: 0, navigationAborts: 0, blockedRequests: 0 } };
  let browser: Browser | undefined, context: BrowserContext | undefined, ownedPage: Page | undefined;
  let ownSessionMayExist = false, current: string = "Configuration and installed Chromium";
  let namedStep = "Case assertions", initialUsers = "", initialPermissions = "";
  let progressSequence = 0;
  const progress = (stage: string) => {
    namedStep = stage;
    writePrivateNew(join(directory, `progress-${String(++progressSequence).padStart(4, "0")}.json`), {
      at: new Date().toISOString(), stage, mode: result.mode, casesCompleted: result.cases.length,
      screenshots: result.images.length, loginAttempts: result.loginAttempts,
      attemptedBusinessWrites: result.attemptedBusinessWrites, completedBusinessWrites: result.completedBusinessWrites,
    });
  };
  const expected = new Map<string, number>();
  const healthy = () => {
    for (const key of ["unexpectedConsoleErrors", "pageErrors", "unexpectedRequestFailures", "unexpectedHttpErrors", "blockedRequests"] as const)
      assert.equal(result.observations[key], 0);
  };
  const check = async (name: typeof caseNames[number], work: () => Promise<void | string>) => {
    progress(`Begin ${name}`);
    if (options.readOnly && [caseNames[5], caseNames[6], caseNames[7], caseNames[8]].some(value => value === name)) {
      result.cases.push({ name, status: "NOT_RUN", reason: "Read-only acceptance preserves all existing business records and attachments; no remarks/status, upload, product or note write is authorized in this mode." });
      return;
    }
    current = name; namedStep = "Case assertions"; const blocked = await work(); healthy();
    result.cases.push({ name, status: blocked ? "BLOCKED" : "PASS", ...(blocked ? { reason: blocked } : {}) });
    progress(`Finished ${name}`);
  };
  try {
    assert.ok(existsSync(chromium.executablePath()));
    const environment: Record<string, string> = {};
    for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE", "PATH"])
      if (process.env[name] !== undefined) environment[name] = process.env[name]!;
    browser = await chromium.launch({ headless: true, env: environment, timeout: 30_000,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync", "--no-first-run",
        "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(25_000);
    await context.route("**/*", route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path === "/api/auth/login") result.loginAttempts++;
      if (!["GET", "HEAD"].includes(request.method()) && !["/api/auth/login", "/api/auth/logout"].includes(path)) result.attemptedBusinessWrites++;
      if (allowedCurrentUserRequest(options, route.request().url(), route.request().method(), result.created.noteId)) return route.continue();
      result.observations.blockedRequests++; return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", socket => { result.observations.blockedRequests++; socket.close(); });
    context.on("response", response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 200 && response.status() < 300 && !["GET", "HEAD"].includes(response.request().method())
        && !["/api/auth/login", "/api/auth/logout"].includes(path)) result.completedBusinessWrites++;
      if (response.request().method() === "POST" && response.status() === 200) {
        if (path === "/api/auth/login") ownSessionMayExist = true;
        if (path === "/api/auth/logout") ownSessionMayExist = false;
      }
      if (response.status() < 400) return;
      if (expected.get(path) === response.status()) result.observations.expectedHttpRefusals++;
      else result.observations.unexpectedHttpErrors++;
    });
    context.on("requestfailed", request => {
      if (request.failure()?.errorText === "net::ERR_ABORTED"
        && allowedCurrentUserRequest(options, request.url(), request.method(), result.created.noteId)) result.observations.navigationAborts++;
      else result.observations.unexpectedRequestFailures++;
    });
    const page = await context.newPage();
    ownedPage = page;
    page.on("pageerror", () => { result.observations.pageErrors++; });
    page.on("console", message => {
      if (message.type() !== "error") return;
      let allowed = false;
      try { const status = expected.get(new URL(message.location().url).pathname);
        allowed = status !== undefined && message.text().startsWith(`Failed to load resource: the server responded with a status of ${status}`); } catch { /* No raw diagnostic is retained. */ }
      if (allowed) result.observations.expectedConsoleRefusals++; else result.observations.unexpectedConsoleErrors++;
    });
    const visit = async (path: string) => {
      namedStep = "Positive page HTTP response";
      assert.equal((await page.goto(options.origin + path, { waitUntil: "domcontentloaded" }))?.status(), 200);
      await settle(page);
      namedStep = "Positive page data finished loading";
      await page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')]
        .some(element => element.getClientRects().length > 0 && /^Loading\b/.test(element.textContent?.trim() ?? "")), undefined, { timeout: 20_000 });
      namedStep = "Positive page application alerts";
      assert.equal(await page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ }).count(), 0);
    };
    const refused = async (path: string, status: number, work: () => Promise<void>) => {
      expected.set(path, status);
      try { await work(); await settle(page); } finally { expected.delete(path); }
    };
    const mutation = async (path: string, method: string, action: () => Promise<unknown>, status = 200) => {
      const [response] = await Promise.all([page.waitForResponse(reply => new URL(reply.url()).pathname === path && reply.request().method() === method), action()]);
      assert.equal(response.status(), status);
      // Auth immediately navigates: Chromium can retain an unresolved body-
      // completion promise after the successful response. The caller verifies
      // the resulting page and current identity / anonymous refusal instead.
      if (path !== "/api/auth/login" && path !== "/api/auth/logout") await boundedBrowserOperation(response.finished());
      await settle(page); return response;
    };
    const marker = `SYNTHETIC CURRENT USER ${randomUUID()}`, suffix = randomUUID().slice(0, 8);
    progress("Open empty login and capture reference widths");
    await visit("/login"); await capture(page, result, "login", progress);
    await check(caseNames[0], async () => {
      await refused("/api/dashboard", 401, async () => { assert.equal((await api(page, "/api/dashboard")).status, 401); });
      await page.goto(options.origin + "/account", { waitUntil: "domcontentloaded" }); await page.waitForURL(options.origin + "/login");
    });
    await check(caseNames[1], async () => {
      if (options.readOnly) result.cases.push({ name: "Invalid-credential login attempt", status: "NOT_RUN",
        reason: "Read-only mode attempts only the authorized normal login; deliberate failed logins and throttle mutations are omitted." });
      else {
        await page.getByLabel("Email address", { exact: true }).fill(options.account.email);
        await page.getByLabel("Password", { exact: true }).fill(`invalid-${randomUUID()}`);
        await refused("/api/auth/login", 401, async () => {
          await mutation("/api/auth/login", "POST", () => page.getByRole("button", { name: /^(Login|Sign in)$/ }).click(), 401);
          await page.getByRole("alert").filter({ hasText: "Unable to sign in" }).waitFor();
        });
        result.cases.push({ name: "Invalid-credential login attempt", status: "PASS" });
      }
      await visit("/login");
      await page.getByLabel("Email address", { exact: true }).fill(options.account.email);
      await page.getByLabel("Password", { exact: true }).fill(options.account.password);
      namedStep = "Valid login response and redirect";
      await mutation("/api/auth/login", "POST", () => page.getByRole("button", { name: /^(Login|Sign in)$/ }).click());
      await page.waitForURL(url => url.origin === options.origin && ["/account", "/dashboard"].includes(url.pathname)); await settle(page);
    });
    await check(caseNames[2], async () => {
      const reply = await api(page, "/api/auth/me"); assert.equal(reply.status, 200);
      const user = reply.body.user as { localUserId: string; permissions: string[] };
      assert.equal(user.localUserId, "15"); assert.equal(user.permissions.includes("leads.manage.agents"), false);
      initialPermissions = JSON.stringify([...user.permissions].sort());
      const users = await api(page, "/api/settings/users?page=1&pageSize=100"); assert.equal(users.status, 200);
      const items = users.body.items as { id: string; status: string }[];
      assert.equal(users.body.total, 15); assert.equal(items.length, 15);
      assert.equal(items.filter(value => value.status === "active").length, 1);
      assert.equal(items.find(value => value.status === "active")?.id, "15");
      initialUsers = JSON.stringify(items);
      result.accountInvariant = { totalUsers: 15, activeUsers: 1, currentUserId: "15", unchanged: false };
      for (const [path, id] of [["jobs", options.fixture.jobId], ["leads", options.fixture.leadId]]) {
        const record = await api(page, `/api/${path}/${id}`); assert.equal(record.status, 200);
        assert.equal(typeof record.body.dealName === "string" && record.body.dealName.startsWith("SYNTHETIC DEMO "), true);
      }
    });
    await check(caseNames[3], async () => {
      const nav = page.getByRole("navigation", { name: "CRM navigation" }), collapsed = nav.getByRole("button", { expanded: false });
      const count = await collapsed.count(); for (let index = 0; index < count; index++) await collapsed.first().click();
      for (const name of ["Dashboard", "Jobs", "Lead pipeline", "Products", "Quotations", "Employee report", "Users", "Assign departments"])
        await nav.getByRole("link", { name, exact: true }).waitFor();
      for (const path of ["/settings/users", "/settings/permissions", "/settings/permission-groups", "/settings/permissions/assign", "/settings/users/departments"])
        await visit(path);
      const assign = page.getByRole("button", { name: /^Assign department for / }).first();
      await assign.click(); await page.getByRole("dialog", { name: "Assign Department", exact: true }).waitFor();
      await page.getByRole("button", { name: "Close", exact: true }).click();
    });
    await check(caseNames[14], async () => {
      namedStep = "Created-deal list and search reads";
      await visit("/deals"); await page.getByRole("region", { name: "Created deals", exact: true }).waitFor();
      assert.equal((await api(page, "/api/deals?page=1&pageSize=25")).status, 200);
      await page.getByRole("searchbox", { name: "Search created deals", exact: true }).fill("SYNTHETIC DEMO");
      await page.getByRole("searchbox", { name: "Search created deals", exact: true }).press("Enter"); await settle(page);
      namedStep = "Created-deal search table is ready with eight columns";
      await page.getByRole("columnheader", { name: "Date Created", exact: true }).waitFor();
      assert.equal(await page.getByRole("columnheader").count(), 8);
      namedStep = "Six source-defined job groups and matching export links";
      for (const [cohort, label] of [["all", "All Jobs"], ["pending", "Pending Assigning"], ["process", "Under Process"],
        ["completed", "Completed"], ["hold", "Hold"], ["closed", "Closed"]]) {
        await visit(`/jobs?cohort=${cohort}`);
        assert.equal(await page.getByLabel("Job group", { exact: true }).inputValue(), cohort);
        await page.getByRole("heading", { name: label, exact: true }).last().waitFor();
        const href = await page.getByRole("link", { name: "Export jobs (XLSX)", exact: true }).getAttribute("href");
        assert.ok(href);
        assert.equal(new URL(href, options.origin).searchParams.get("cohort") ?? "all", cohort);
        const reply = await api(page, `/api/jobs?cohort=${cohort}&page=1&pageSize=25`);
        assert.equal(reply.status, 200); assert.equal(Array.isArray(reply.body.items), true);
      }
      namedStep = "Job-list assignment dialog opens and closes without mutation";
      const job = await api(page, `/api/jobs/${options.fixture.jobId}`); assert.equal(job.status, 200);
      await visit("/jobs");
      await page.getByRole("searchbox", { name: "Search jobs", exact: true }).fill(String(job.body.dealName));
      await page.getByRole("searchbox", { name: "Search jobs", exact: true }).press("Enter"); await settle(page);
      const opener = page.getByRole("button", { name: `Assign departments for ${String(job.body.dealName)}`, exact: true });
      await opener.click(); const dialog = page.getByRole("dialog", { name: "Assign Departments", exact: true });
      await dialog.waitFor(); await settle(page);
      assert.equal(await dialog.getByRole("alert").count(), 0);
      for (const label of ["Electrical user", "Civil user", "Project Manager user", "Switchgear user", "Maintenance user"])
        assert.equal(await dialog.getByRole("combobox", { name: label, exact: true }).isVisible(), true);
      assert.equal(await dialog.getByRole("button", { name: "Save Assignments", exact: true }).isDisabled(), true);
      await capture(page, result, "job-assignment-dialog", progress); await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" }); assert.equal(await opener.evaluate(element => element === document.activeElement), true);
      namedStep = "Complete grouped permission catalogue read and filter";
      await visit("/settings/permissions/assign?userId=15");
      const catalogue = page.getByRole("group", { name: "Available permissions", exact: true }); await catalogue.waitFor();
      const permissions = await api(page, "/api/settings/permissions?page=1&pageSize=100"); assert.equal(permissions.status, 200);
      assert.equal(await catalogue.getByRole("checkbox").count(), permissions.body.total);
      const checkedBefore = await catalogue.locator('input[type="checkbox"]:checked').count();
      await page.getByRole("searchbox", { name: "Find permissions", exact: true }).fill("NO MATCH " + suffix);
      await page.getByRole("searchbox", { name: "Find permissions", exact: true }).press("Enter"); await settle(page);
      await catalogue.getByText("No permissions match your search.", { exact: true }).waitFor();
      assert.equal(await catalogue.getByRole("checkbox").count(), 0);
      await page.getByRole("searchbox", { name: "Find permissions", exact: true }).fill("");
      await page.getByRole("searchbox", { name: "Find permissions", exact: true }).press("Enter"); await settle(page);
      if (typeof permissions.body.total === "number" && permissions.body.total > 0) await catalogue.getByRole("checkbox").first().waitFor();
      assert.equal(await catalogue.getByRole("checkbox").count(), permissions.body.total);
      assert.equal(await catalogue.locator('input[type="checkbox"]:checked').count(), checkedBefore);
    });
    await check(caseNames[4], async () => {
      await visit("/dashboard"); assert.equal((await api(page, "/api/dashboard")).status, 200);
      await visit("/pipeline"); await page.getByRole("searchbox", { name: "Search leads", exact: true }).fill("SYNTHETIC DEMO");
      await page.getByRole("button", { name: "Search leads", exact: true }).click(); await settle(page);
      await visit(`/leads/${options.fixture.leadId}`);
      for (const part of ["notes", "history"]) {
        const reply = await api(page, `/api/leads/${options.fixture.leadId}/${part}`);
        assert.equal(reply.status, 200); assert.equal(Array.isArray(reply.body.items), true);
      }
    });
    await check(caseNames[5], async () => {
      const path = `/api/jobs/${options.fixture.jobId}`, before = await api(page, path); assert.equal(before.status, 200);
      const previous = typeof before.body.remarks === "string" ? before.body.remarks : "";
      const remarks = [previous, marker].filter(Boolean).join("\n"); assert.ok(remarks.length <= 4000);
      await refused(path + "/remarks", 403, async () => { assert.equal((await api(page, path + "/remarks", "PATCH", { expectedVersion: before.body.version, remarks }, false)).status, 403); });
      await refused(path + "/remarks", 400, async () => { assert.equal((await api(page, path + "/remarks", "PATCH", { expectedVersion: before.body.version, remarks, unexpected: true })).status, 400); });
      await visit(`/jobs/${options.fixture.jobId}`);
      await page.getByLabel("Administrator remarks", { exact: true }).fill(remarks);
      await mutation(path + "/remarks", "PATCH", () => page.getByRole("button", { name: "Save remarks", exact: true }).click());
      await visit(`/jobs/${options.fixture.jobId}`);
      assert.equal((await page.getByLabel("Administrator remarks", { exact: true }).inputValue()) === remarks, true);
      await refused(path + "/remarks", 409, async () => { assert.equal((await api(page, path + "/remarks", "PATCH", { expectedVersion: before.body.version, remarks })).status, 409); });
      const original = String(before.body.jobStatus); assert.ok(["Active", "Hold", "Closed"].includes(original));
      for (const state of [original === "Hold" ? "Active" : "Hold", original]) {
        await page.getByLabel("Job status", { exact: true }).selectOption(state);
        await mutation(path + "/status", "PATCH", () => page.getByRole("button", { name: "Save job status", exact: true }).click());
        await visit(`/jobs/${options.fixture.jobId}`); assert.equal(await page.getByLabel("Job status", { exact: true }).inputValue(), state);
      }
    });
    await check(caseNames[6], async () => {
      const path = `/api/leads/${options.fixture.jobId}/attachments`, fileName = `synthetic-current-user-${suffix}.txt`, bytes = Buffer.from(marker);
      await page.getByLabel("Attachment file", { exact: true }).setInputFiles({ name: fileName, mimeType: "text/plain", buffer: bytes });
      await mutation(path, "POST", () => page.getByRole("button", { name: "Upload attachment", exact: true }).click());
      await visit(`/jobs/${options.fixture.jobId}`);
      const received = page.waitForEvent("download"); await page.getByRole("link", { name: fileName, exact: true }).click();
      assert.equal((await downloadBytes(await received)).equals(bytes), true);
      await refused(path, 415, async () => {
        await page.getByLabel("Attachment file", { exact: true }).setInputFiles({ name: "synthetic-current-user.php", mimeType: "text/plain", buffer: bytes });
        await mutation(path, "POST", () => page.getByRole("button", { name: "Upload attachment", exact: true }).click(), 415);
      });
    });
    await check(caseNames[7], async () => {
      await visit("/items/new"); const caps = await api(page, "/api/capabilities"); assert.equal(caps.status, 200);
      assert.equal(caps.body.integrationAvailable, false);
      if (caps.body.persistence !== "local-demo" || caps.body.productCreate !== true) return "Local product capability is not available to the current user.";
      await page.getByLabel("Item Name", { exact: true }).fill(marker);
      await page.getByLabel("Description (Optional)", { exact: true }).fill("Synthetic current-user browser verification; local only.");
      const reply = await mutation("/api/items", "POST", () => page.getByRole("button", { name: "Save Item", exact: true }).click());
      const saved = await reply.json() as { productId: string; persistence: string };
      assert.equal(saved.persistence, "local-demo"); result.created.productId = saved.productId;
      await visit("/items"); await page.getByLabel("Search Items", { exact: true }).fill(marker);
      await page.getByRole("button", { name: "Search", exact: true }).click(); await settle(page);
      await page.getByRole("cell", { name: marker, exact: true }).waitFor();
    });
    await check(caseNames[8], async () => {
      const path = `/api/leads/${options.fixture.leadId}`; await visit(`/leads/${options.fixture.leadId}`);
      const global = await api(page, "/api/capabilities"), caps = await api(page, path + "/capabilities");
      assert.equal(global.status, 200); assert.equal(caps.status, 200);
      assert.equal(global.body.integrationAvailable, false); assert.equal(caps.body.integrationAvailable, false);
      const stage = page.getByRole("button", { name: "Update Status", exact: true });
      if (await stage.count()) assert.equal(await stage.isDisabled(), true);
      if (global.body.persistence !== "local-demo" || global.body.leadNotes !== true || caps.body.canWriteNotes !== true || caps.body.blockedOperationId)
        return "Current user lacks an available local note capability for this synthetic lead; ownership/grants were not changed.";
      await page.getByRole("button", { name: "Add Note", exact: true }).click();
      await page.getByLabel("New note title", { exact: true }).fill(marker);
      await page.getByLabel("New note content", { exact: true }).fill("Synthetic current-user note, original content.");
      const reply = await mutation(path + "/notes", "POST", () => page.getByRole("button", { name: "Add lead note", exact: true }).click());
      const saved = await reply.json() as { noteId: string; persistence: string }; assert.equal(saved.persistence, "local-demo");
      assert.match(saved.noteId, idPattern); result.created.noteId = saved.noteId;
      await visit(`/leads/${options.fixture.leadId}`);
      await page.getByRole("button", { name: `Edit note: ${marker}`, exact: true }).click();
      await page.getByLabel("Edit note content", { exact: true }).fill(marker + " edited content");
      await mutation(path + "/notes/" + saved.noteId, "PATCH", () => page.getByRole("button", { name: "Save lead note", exact: true }).click());
      await visit(`/leads/${options.fixture.leadId}`);
      await page.getByRole("region", { name: "Lead notes", exact: true }).getByText(marker + " edited content", { exact: true }).waitFor();
    });
    await check(caseNames[9], async () => {
      for (const [index, id] of [options.fixture.contractingTaskId, options.fixture.switchgearTaskId].entries()) {
        const caps = await api(page, `/api/quotations/${id}/capabilities`); assert.equal(caps.status, 200);
        assert.equal(caps.body.integrationAvailable, false);
        await visit(`/quotations/${id}`); const received = page.waitForEvent("download");
        await page.getByRole("link", { name: "Download quotation PDF", exact: true }).click();
        const bytes = await downloadBytes(await received); assert.equal(bytes.subarray(0, 5).toString(), "%PDF-"); assert.ok(bytes.length > 1000);
        const template = index === 0 ? "contracting" : "switchgear", filename = `${template}-quotation.pdf`;
        const file = join(directory, filename), descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
        finally { closeSync(descriptor); bytes.fill(0); }
        privateAccess(file, false);
        result.artifacts.push({ kind: "pdf", template, filename, bytes: bytes.length });
      }
      await visit("/jobs"); const received = page.waitForEvent("download");
      await page.getByRole("link", { name: "Export jobs (XLSX)", exact: true }).click();
      const files = unzipSync(await downloadBytes(await received)); assert.ok(files["xl/workbook.xml"] && files["xl/worksheets/sheet1.xml"]);
      assert.equal(Object.keys(files).some(name => /vbaProject|externalLinks/i.test(name)), false);
    });
    await check(caseNames[10], async () => {
      await visit("/reports/employee-performance"); await page.getByRole("button", { name: "Apply dates", exact: true }).click(); await settle(page);
      const report = await api(page, "/api/reports/employee-performance"); assert.equal(report.status, 200); assert.equal(report.body.timeZone, "Asia/Dubai");
      for (const department of ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"]) {
        await visit(`/departments/${department}/jobs`);
        const queue = await api(page, `/api/departments/${department}/jobs?pageSize=100`); assert.equal(queue.status, 200);
        assert.equal(typeof queue.body.total, "number"); result.departmentQueues.push({ department, visibleJobs: queue.body.total as number });
        await page.getByLabel("Department status filter", { exact: true }).selectOption("Process"); await settle(page);
        await page.getByLabel("Department status filter", { exact: true }).selectOption("all"); await settle(page);
        if (department === "Electrical") {
          const received = page.waitForEvent("download"); await page.getByRole("link", { name: "Export assigned jobs (XLSX)", exact: true }).click();
          assert.ok(unzipSync(await downloadBytes(await received))["xl/worksheets/sheet1.xml"]);
        }
      }
    });
    await check(caseNames[11], async () => {
      await visit("/dashboard");
      await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
      await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 }); await settle(page);
      await page.getByRole("button", { name: "Open navigation", exact: true }).click(); await settle(page);
      assert.ok((await page.locator(".pc-sidebar").boundingBox())!.x >= -1);
      await page.keyboard.press("Escape"); await settle(page);
      assert.equal(await page.getByRole("button", { name: "Open navigation", exact: true }).getAttribute("aria-expanded"), "false");
      await page.getByRole("button", { name: "User menu", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).waitFor(); await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1440, height: 1000 }); await visit(`/jobs/${options.fixture.jobId}`);
      await page.getByRole("tab", { name: "Electrical", exact: true }).click();
      await page.getByRole("tab", { name: "Electrical", exact: true }).press("ArrowRight");
      await page.getByRole("heading", { name: "Civil Details", exact: true }).waitFor();
    });
    await check(caseNames[12], async () => {
      for (const [screen, path] of [["dashboard", "/dashboard"], ["jobs", "/jobs"], ["pipeline", "/pipeline"], ["users", "/settings/users"],
        ["department-assignment", "/settings/users/departments"], ["quotation-form", "/quotations/new"], ["reports", "/reports/employee-performance"],
        ["products", "/items"], ["quotations", "/quotations"], ["permissions", "/settings/permissions"],
        ["created-deals", "/deals"], ["permission-assignment", "/settings/permissions/assign?userId=15"],
        ["account", "/account"], ["groups", "/settings/permission-groups"], ["product-create", "/items/new"], ["deal-create", "/deals/new"],
        ["department-electrical", "/departments/Electrical/jobs"], ["department-civil", "/departments/Civil/jobs"],
        ["department-pm", "/departments/PM/jobs"], ["department-switchgear", "/departments/Switchgear/jobs"],
        ["department-maintenance", "/departments/Maintenance/jobs"],
        ["job-detail", `/jobs/${options.fixture.jobId}`], ["lead-detail", `/leads/${options.fixture.leadId}`], ["quotation-detail", `/quotations/${options.fixture.contractingTaskId}`]]) {
        namedStep = "Screenshot page"; await visit(path!); namedStep = "Responsive screenshot and geometry"; await capture(page, result, screen!, progress);
      }
      assert.equal(result.images.length, 26 * UI_CAPTURE_VIEWPORTS.length);
    });
    await check(caseNames[13], async () => {
      const users = await api(page, "/api/settings/users?page=1&pageSize=100"), me = await api(page, "/api/auth/me");
      assert.equal(users.status, 200); assert.equal(me.status, 200);
      assert.equal(JSON.stringify(users.body.items) === initialUsers, true);
      assert.equal(JSON.stringify([...(me.body.user as { permissions: string[] }).permissions].sort()) === initialPermissions, true);
      result.accountInvariant!.unchanged = true;
      await page.getByRole("button", { name: "User menu", exact: true }).click();
      await mutation("/api/auth/logout", "POST", () => page.getByRole("button", { name: "Sign out", exact: true }).click());
      await page.waitForURL(options.origin + "/login");
      await refused("/api/dashboard", 401, async () => { assert.equal((await api(page, "/api/dashboard")).status, 401); });
    });
    result.cases.push({ name: "Department worker assignment work-log and ownership variants", status: result.departmentQueues.every(queue => queue.visibleJobs === 0) ? "BLOCKED" : "NOT_RUN",
      reason: result.departmentQueues.every(queue => queue.visibleJobs === 0)
        ? "Current user's five department queues contain no assigned jobs. Inactive workers are not reactivated and assignments are not changed; role variants have disposable offline coverage only."
        : "Current-user department reads were checked. Assignment/work-log mutations were not attempted; inactive worker role variants remain outside this run." },
    { name: "Quotation edits lead-stage deal writes and remote integration", status: "BLOCKED",
      reason: "Current-user ownership and unresolved integration/business gates are preserved. No remote writes, quotation edits or stage/deal mutations were attempted." },
    { name: "Users grants roles and department-assignment mutations", status: "NOT_RUN",
      reason: "Only protected settings reads and modal open/close were exercised; all15 identities and14 inactive account states are preserved." });
    healthy();
    if (options.readOnly) {
      assert.equal(result.loginAttempts, 1);
      assert.equal(result.attemptedBusinessWrites, 0); assert.equal(result.completedBusinessWrites, 0);
    }
    result.status = "PASS";
  } catch (error) { result.cases.push({ name: current, status: "FAIL", failure: safeBrowserFailure(error, namedStep) }); }
  finally {
    try { progress("Begin own-session and owned-browser cleanup"); }
    catch { result.status = "FAIL"; result.cases.push({ name: "Cleanup progress retention", status: "FAIL" }); }
    if (ownSessionMayExist && ownedPage) {
      try {
        assert.equal((await api(ownedPage, "/api/auth/logout", "POST")).status, 200);
        ownSessionMayExist = false;
        result.cases.push({ name: "Own failed-run session revoked", status: "PASS" });
      } catch (error) {
        result.status = "FAIL";
        result.cases.push({ name: "Own failed-run session revocation", status: "FAIL",
          failure: safeBrowserFailure(error, "Revoke only this browser's session") });
      }
    }
    for (const [name, resource] of [["Owned context cleanup", context], ["Owned browser cleanup", browser]] as const) {
      try { if (resource) await boundedBrowserOperation(resource.close(), 10_000); }
      catch { result.status = "FAIL"; result.cases.push({ name, status: "FAIL" }); }
    }
    for (const name of caseNames) if (!result.cases.some(value => value.name === name)) result.cases.push({ name, status: "NOT_RUN", reason: "Stopped after an earlier failure." });
    result.counts = { pass: result.cases.filter(value => value.status === "PASS").length, fail: result.cases.filter(value => value.status === "FAIL").length,
      blocked: result.cases.filter(value => value.status === "BLOCKED").length, notRun: result.cases.filter(value => value.status === "NOT_RUN").length };
    result.finishedAt = new Date().toISOString(); writePrivateNew(result.receipt, result);
  }
  return result;
}
