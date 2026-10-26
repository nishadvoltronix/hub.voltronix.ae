import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { safeBrowserFailure, type SafeBrowserFailure } from "./browser-acceptance.js";
import { acknowledgement, backendRoot, demoConfiguration, privateDirectory, writePrivateNew } from "./storage.js";
import { captureChildEnvironment, captureUiScreen, settleCapturePage, UI_CAPTURE_VIEWPORTS,
  type CaptureImage, type CaptureMetrics } from "./ui-capture.js";

const frontend = "http://127.0.0.1:3001";
const departments = ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"] as const;
const syntheticFileId = "11111111-1111-4111-8111-111111111111";
export const ANONYMOUS_PROTECTED_FILES = [`/api/attachments/${syntheticFileId}`, `/api/attachments/${syntheticFileId}/preview`,
  `/api/log-attachments/${syntheticFileId}`, `/api/log-attachments/${syntheticFileId}/preview`, "/api/quotations/1/pdf"] as const;
export const ANONYMOUS_SCOPE_LIMITS = ["Authenticated workflows are outside this anonymous verifier's scope; credential availability is not inspected.",
  "No login, password reset, account reactivation, grant update, session reuse or alternate identity is attempted."] as const;
export const ANONYMOUS_PROTECTED_PAGES = ["/", "/account", "/dashboard", "/jobs", "/jobs/1", "/leads/1", "/pipeline",
  "/deals", "/deals/new", "/items", "/items/new", "/quotations", "/quotations/new", "/quotations/1", "/quotations/1/edit",
  "/reports/employee-performance", "/settings/users",
  "/settings/users/departments", "/settings/permissions", "/settings/permission-groups",
  "/settings/permissions/assign", ...departments.flatMap(department => [`/departments/${department}/jobs`, `/departments/${department}/jobs/1`])] as const;
export const ANONYMOUS_PROTECTED_APIS = ["/api/auth/me", "/api/dashboard", "/api/capabilities", "/api/jobs", "/api/pipeline",
  "/api/deals", "/api/items", "/api/quotations", "/api/reports/employee-performance", "/api/settings/users",
  "/api/settings/permissions", ...departments.flatMap(department => [`/api/departments/${department}/jobs`,
    `/api/departments/${department}/jobs/1/logs`]), ...ANONYMOUS_PROTECTED_FILES] as const;

/** No credential parameters, login attempts, API writes, database access, saved
 * cookies or reused sessions. The caller separately verifies database integrity. */
export interface AnonymousBrowserResult {
  status: "PASS" | "FAIL";
  scope: string;
  startedAt: string;
  finishedAt?: string;
  directory: string;
  receipt: string;
  checks: { name: string; status: "PASS" | "FAIL"; statusCode?: number; failure?: SafeBrowserFailure }[];
  images: CaptureImage[];
  metrics: CaptureMetrics[];
  observations: { pageErrors: number; unexpectedConsoleErrors: number; expectedUnauthorizedConsole: number;
    unexpectedHttpErrors: number; expectedUnauthorizedHttp: number; failedRequests: number;
    navigationAborts: number; blockedRequests: number };
  blocked: string[];
  loginAttempts: 0;
  applicationWrites: 0;
  sessionReused: false;
}

export function allowedAnonymousRequest(value: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  try {
    const url = new URL(value);
    if (url.origin !== frontend || url.username || url.password || /%(?:2e|2f|5c|00)|\\/i.test(url.pathname)
      || url.pathname.split("/").some(segment => segment.startsWith("."))) return false;
    return url.pathname === "/login" || (ANONYMOUS_PROTECTED_PAGES as readonly string[]).includes(url.pathname)
      || (ANONYMOUS_PROTECTED_APIS as readonly string[]).includes(url.pathname)
      || /^\/_next\/static\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf)$/.test(url.pathname)
      || /^\/legacy\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:css|png|jpg|jpeg|svg|woff2?|ttf|eot)$/.test(url.pathname)
      || url.pathname === "/favicon.ico";
  } catch { return false; }
}

export async function runAnonymousAcceptance(options: { origin?: string } = {}): Promise<AnonymousBrowserResult> {
  assert.equal(Object.keys(options).every(key => key === "origin"), true);
  assert.equal(options.origin ?? frontend, frontend);
  demoConfiguration(process.env);
  const directory = privateDirectory(["evidence", `anonymous-current-${randomUUID()}`], true);
  const result: AnonymousBrowserResult = { status: "FAIL", scope: "Anonymous current-build rendering and protected-read refusals only; database preservation is checked separately by the caller.",
    startedAt: new Date().toISOString(), directory, receipt: join(directory, "receipt.json"), checks: [], images: [], metrics: [],
    observations: { pageErrors: 0, unexpectedConsoleErrors: 0, expectedUnauthorizedConsole: 0, unexpectedHttpErrors: 0,
      expectedUnauthorizedHttp: 0, failedRequests: 0, navigationAborts: 0, blockedRequests: 0 },
    blocked: [...ANONYMOUS_SCOPE_LIMITS],
    loginAttempts: 0, applicationWrites: 0, sessionReused: false };
  let browser: Browser | undefined, context: BrowserContext | undefined, stage = "Installed Chromium and guarded anonymous context";
  let expectedUnauthorized: string | undefined;
  const healthy = () => {
    for (const key of ["pageErrors", "unexpectedConsoleErrors", "unexpectedHttpErrors", "failedRequests", "blockedRequests"] as const)
      assert.equal(result.observations[key], 0);
  };
  try {
    assert.ok(existsSync(chromium.executablePath()));
    browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string>, timeout: 30_000,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync",
        "--no-first-run", "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false,
      viewport: { width: UI_CAPTURE_VIEWPORTS[0].width, height: UI_CAPTURE_VIEWPORTS[0].height } });
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(25_000);
    await context.route("**/*", route => {
      if (allowedAnonymousRequest(route.request().url(), route.request().method())) return route.continue();
      result.observations.blockedRequests++; return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", socket => { result.observations.blockedRequests++; socket.close(); });
    context.on("response", response => {
      if (response.status() < 400) return;
      if (response.status() === 401 && new URL(response.url()).pathname === expectedUnauthorized)
        result.observations.expectedUnauthorizedHttp++;
      else result.observations.unexpectedHttpErrors++;
    });
    context.on("requestfailed", request => {
      if (request.failure()?.errorText === "net::ERR_ABORTED" && allowedAnonymousRequest(request.url(), request.method()))
        result.observations.navigationAborts++;
      else result.observations.failedRequests++;
    });
    const page = await context.newPage();
    page.on("pageerror", () => { result.observations.pageErrors++; });
    page.on("console", message => {
      if (message.type() !== "error") return;
      let expected = false;
      try { expected = expectedUnauthorized !== undefined && new URL(message.location().url).pathname === expectedUnauthorized
        && message.text().startsWith("Failed to load resource: the server responded with a status of 401"); } catch { /* No raw console text retained. */ }
      if (expected) result.observations.expectedUnauthorizedConsole++; else result.observations.unexpectedConsoleErrors++;
    });
    stage = "Empty public login and matching responsive screenshots";
    assert.equal((await page.goto(frontend + "/login", { waitUntil: "domcontentloaded" }))?.status(), 200);
    await settleCapturePage(page);
    assert.equal(await page.getByRole("button", { name: /^(Login|Sign in)$/ }).count(), 1);
    for (const label of ["Email address", "Password"]) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), "");
    assert.equal(await page.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ }).count(), 0);
    await captureUiScreen(page, result, "login", true, async viewport => {
      stage = "Visible enabled empty login form at " + viewport.name;
      for (const label of ["Email address", "Password"]) {
        const input = page.getByLabel(label, { exact: true });
        assert.equal(await input.count(), 1); assert.equal(await input.isVisible(), true);
        assert.equal(await input.isEnabled(), true); assert.equal(await input.inputValue() === "", true);
      }
      const submit = page.getByRole("button", { name: /^(Login|Sign in)$/ });
      assert.equal(await submit.count(), 1); assert.equal(await submit.isVisible(), true); assert.equal(await submit.isEnabled(), true);
    });
    assert.equal(result.images.length, UI_CAPTURE_VIEWPORTS.length);
    assert.equal(result.metrics.every(metric => metric.documentWidth <= metric.width + 1), true);
    healthy(); result.checks.push({ name: "Visible enabled empty public login at four matching viewport sizes", status: "PASS", statusCode: 200 });
    const reads = [...ANONYMOUS_PROTECTED_APIS.map(path => ({ path, method: "GET" })),
      ...ANONYMOUS_PROTECTED_FILES.map(path => ({ path, method: "HEAD" }))];
    for (const { path, method } of reads) {
      stage = "Anonymous " + method + " " + path; expectedUnauthorized = path;
      try {
        const status = await page.evaluate(async target => (await fetch(target.path, { method: target.method, credentials: "omit", redirect: "error" })).status, { path, method });
        assert.equal(status, 401); await settleCapturePage(page); healthy();
        result.checks.push({ name: stage, status: "PASS", statusCode: status });
      } finally { expectedUnauthorized = undefined; }
    }
    for (const path of ANONYMOUS_PROTECTED_PAGES) {
      stage = "Anonymous page redirects to login: " + path;
      assert.equal((await page.goto(frontend + path, { waitUntil: "domcontentloaded" }))?.status(), 200);
      await page.waitForURL(frontend + "/login"); await settleCapturePage(page);
      assert.equal(new URL(page.url()).pathname === "/login", true); healthy();
      result.checks.push({ name: stage, status: "PASS" });
    }
    healthy(); result.status = "PASS";
  } catch (error) { result.checks.push({ name: stage, status: "FAIL", failure: safeBrowserFailure(error, stage) }); }
  finally {
    try { await context?.close(); await browser?.close(); } catch { result.status = "FAIL"; result.checks.push({ name: "Owned anonymous browser cleanup", status: "FAIL" }); }
    result.finishedAt = new Date().toISOString(); writePrivateNew(result.receipt, result);
  }
  return result;
}

const currentFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === currentFile) {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ status: "REFUSED", detail: "Anonymous verification accepts no credentials or command arguments." })); process.exitCode = 1;
  } else if (process.env.CRM_SQLITE_DEMO !== acknowledgement) {
    const loader = pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href;
    const child = spawn(process.execPath, ["--import", loader, currentFile],
      { cwd: backendRoot, env: captureChildEnvironment(), windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise<number>(resolveExit => { child.once("error", () => resolveExit(1)); child.once("exit", code => resolveExit(code ?? 1)); });
  } else {
    try {
      const result = await runAnonymousAcceptance();
      console.log(JSON.stringify({ status: result.status, scope: result.scope, receipt: result.receipt, directory: result.directory,
        checks: result.checks.length, screenshots: result.images.length, observations: result.observations,
        loginAttempts: result.loginAttempts, applicationWrites: result.applicationWrites }));
      process.exitCode = result.status === "PASS" ? 0 : 1;
    } catch { console.error(JSON.stringify({ status: "REFUSED", detail: "Anonymous verification failed its guard; no private or raw browser data was logged." })); process.exitCode = 1; }
  }
}
