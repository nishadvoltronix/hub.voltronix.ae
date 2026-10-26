import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { captureChildEnvironment, captureUiScreen, settleCapturePage, type CaptureImage, type CaptureMetrics } from "./ui-capture.js";
import { backendRoot, privateDirectory, writePrivateNew } from "./storage.js";

const origin = "http://127.0.0.1:3001";
const pagePaths = ["/account", "/dashboard", "/pipeline", "/deals", "/deals/new", "/items", "/items/new", "/jobs",
  "/quotations", "/quotations/new", "/reports/employee-performance", "/settings/users", "/settings/users/departments",
  "/settings/permissions", "/settings/permission-groups", "/settings/permissions/assign",
  ...["Electrical", "Civil", "PM", "Switchgear", "Maintenance"].map(name => `/departments/${name}/jobs`)];

export function manualUiScreenName(path: string): string {
  if (!pagePaths.includes(path)) throw new Error("Unknown audit page");
  const screen = path.slice(1).replaceAll("/", "-").toLowerCase();
  if (!/^[a-z][a-z-]{0,40}$/.test(screen)) throw new Error("Invalid audit screen name");
  return screen;
}

/** Keep only measurements used by this audit. Full CSS diagnostics belong to
 * the isolated visual audit; 84 verbose selector records exceed private limits. */
export function compactManualUiMetrics(metrics: readonly CaptureMetrics[]) {
  return metrics.map(({ screen, viewport, width, height, documentWidth }) => ({ screen, viewport, width, height, documentWidth }));
}

/** A human enters credentials only into the visible app; no credential reader or business writes. */
export function allowedManualUiRequest(value: string, method: string): boolean {
  try {
    if (/%(?:2e|2f|5c|00)|\\/i.test(value.split(/[?#]/, 1)[0]!)) return false;
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || /%(?:2e|2f|5c|00)|\\/i.test(url.pathname)
      || url.pathname.split("/").some(part => part.startsWith("."))) return false;
    if (method === "POST") return !url.search && ["/api/auth/login", "/api/auth/logout"].includes(url.pathname);
    if (method !== "GET" && method !== "HEAD") return false;
    return url.pathname === "/" || url.pathname === "/login" || pagePaths.includes(url.pathname)
      || /^\/(?:jobs|leads|quotations)\/[1-9][0-9]*(?:\/edit)?$/.test(url.pathname)
      || /^\/departments\/(?:Electrical|Civil|PM|Switchgear|Maintenance)\/jobs\/[1-9][0-9]*$/.test(url.pathname)
      || /^\/api\/(?:auth\/(?:csrf|me)|capabilities|dashboard|pipeline|jobs|leads|deals|items|quotations|reports|settings|departments|tasks)(?:\/|$)/.test(url.pathname)
      || /^\/_next\/static\/(?:(?:[a-zA-Z0-9_.-]+|(?:\[|%5[bB])(?:department|id|taskId)(?:\]|%5[dD]))\/)*[a-zA-Z0-9_.-]+\.(?:js|css|woff2?|ttf)$/.test(url.pathname)
      || /^\/legacy\/assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:png|jpg|jpeg|svg|css|woff2?|ttf|eot)$/.test(url.pathname)
      || url.pathname === "/favicon.ico";
  } catch { return false; }
}

export async function runManualUiCheck() {
  // Validate every artifact name before asking the owner to log in.
  pagePaths.forEach(manualUiScreenName);
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "PWDEBUG", "NODE_OPTIONS"].some(key => !!process.env[key])
    || process.execArgv.some(arg => arg.startsWith("--inspect"))) throw new Error("Disable debug logging before human login");
  const probe = spawnSync(process.execPath, ["--import", pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href,
    join(backendRoot, "demo-sqlite/control.ts"), "status"], { cwd: backendRoot, env: captureChildEnvironment(),
    encoding: "utf8", windowsHide: true, timeout: 45_000, maxBuffer: 16_384 });
  if (probe.error || probe.status !== 0 || JSON.parse(probe.stdout).status !== "RUNNING") throw new Error("Owned services must be running before manual login");
  const directory = privateDirectory(["evidence", `manual-ui-${randomUUID()}`], true);
  const receipt = { status: "FAIL", scope: "Human login and read-only current-user responsive UI; no business writes", directory,
    images: [] as CaptureImage[], metrics: [] as CaptureMetrics[],
    pages: [] as { path: string; status: "PASS" | "FAIL" | "UNAVAILABLE"; horizontalOverflow: boolean }[],
    pageErrors: 0, unexpectedHttpErrors: 0, unexpectedConsoleErrors: 0, requestFailures: 0, navigationAborts: 0, blockedRequests: 0, authRequests: 0,
    attemptedBusinessWrites: 0, completedBusinessWrites: 0, loginCompleted: false, logoutCompleted: false,
    failure: undefined as string | undefined };
  let browser: Browser | undefined, page: Page | undefined;
  try {
    browser = await chromium.launch({ headless: false, env: captureChildEnvironment() as Record<string, string>,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"] });
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(25_000);
    await context.route("**/*", route => {
      const request = route.request();
      if (allowedManualUiRequest(request.url(), request.method())) {
        if (request.method() === "POST") receipt.authRequests++;
        return route.continue();
      }
      receipt.blockedRequests++;
      if (!["GET", "HEAD"].includes(request.method())) receipt.attemptedBusinessWrites++;
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", socket => { receipt.blockedRequests++; socket.close(); });
    context.on("response", response => {
      if (response.status() < 400) return;
      if (!receipt.loginCompleted && response.status() === 401 && new URL(response.url()).pathname === "/api/auth/me") return;
      receipt.unexpectedHttpErrors++;
    });
    context.on("requestfailed", request => {
      if (request.failure()?.errorText === "net::ERR_ABORTED" && allowedManualUiRequest(request.url(), request.method())) receipt.navigationAborts++;
      else receipt.requestFailures++;
    });
    page = await context.newPage();
    page.on("pageerror", () => receipt.pageErrors++);
    page.on("console", message => {
      if (message.type() !== "error") return;
      try {
        if (!receipt.loginCompleted && new URL(message.location().url).pathname === "/api/auth/me"
          && message.text().startsWith("Failed to load resource: the server responded with a status of 401")) return;
      } catch { /* No browser-controlled text is retained. */ }
      receipt.unexpectedConsoleErrors++;
    });
    await page.goto(origin + "/login", { waitUntil: "domcontentloaded" });
    console.log(JSON.stringify({ status: "WAITING_FOR_HUMAN_LOGIN", origin, credentialCapture: false }));
    await page.waitForURL(url => url.origin === origin && url.pathname !== "/login", { timeout: 15 * 60_000 });
    await settleCapturePage(page);
    const authenticated = await page.evaluate(async () => (await fetch("/api/auth/me", { redirect: "error", credentials: "same-origin" })).status === 200);
    if (!authenticated) throw new Error("Login was not confirmed");
    receipt.loginCompleted = true;
    console.log(JSON.stringify({ status: "LOGIN_CONFIRMED_READ_ONLY_AUDIT_STARTED", businessWrites: 0 }));
    // Login can briefly visit a redirect-only page before the authenticated shell mounts.
    await page.goto(origin + "/account", { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "CRM navigation" }).waitFor({ state: "attached" });
    await settleCapturePage(page);
    // Visit only navigation links visible to this identity; do not bypass UI authorization.
    const available = new Set(await page.locator('nav a[href^="/"]').evaluateAll(links => links.map(link => new URL(link.getAttribute("href")!, location.origin).pathname)));
    for (const path of ["/account", ...pagePaths.filter(path => path !== "/account" && available.has(path))]) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      const response = await page.goto(origin + path, { waitUntil: "domcontentloaded" });
      await settleCapturePage(page);
      if (response?.status() !== 200 || new URL(page.url()).pathname !== path) {
        receipt.pages.push({ path, status: "UNAVAILABLE", horizontalOverflow: false }); continue;
      }
      const screen = manualUiScreenName(path);
      const before = receipt.metrics.length;
      await captureUiScreen(page, receipt, screen, true);
      const horizontalOverflow = receipt.metrics.slice(before).some(metric => metric.documentWidth > metric.width + 1);
      const alert = await page.locator('.crm-content-body [role="alert"]').count() > 0;
      receipt.pages.push({ path, status: horizontalOverflow || alert ? "FAIL" : "PASS", horizontalOverflow });
      console.log(JSON.stringify({ path, status: receipt.pages.at(-1)!.status, viewportChecks: 4 }));
    }
    receipt.status = receipt.pages.every(value => value.status === "PASS") && receipt.pageErrors === 0
      && receipt.unexpectedHttpErrors === 0 && receipt.unexpectedConsoleErrors === 0 && receipt.requestFailures === 0
      && receipt.blockedRequests === 0 ? "PASS" : "FAIL";
  } catch { receipt.failure = receipt.loginCompleted ? "Read-only browser audit did not complete" : "Manual login timed out, browser closed, or startup failed"; }
  finally {
    // Cleanup still runs after a failed navigation/capture; never leave a known audit session behind silently.
    if (receipt.loginCompleted && page && !page.isClosed()) {
      try {
        receipt.logoutCompleted = await page.evaluate(async () => {
          const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(5000) });
          const body = await challenge.json() as { csrfToken?: string };
          if (!challenge.ok || !body.csrfToken) return false;
          return (await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", redirect: "error",
            headers: { "X-CSRF-Token": body.csrfToken }, signal: AbortSignal.timeout(5000) })).ok;
        });
      } catch { receipt.logoutCompleted = false; }
    }
    if (receipt.loginCompleted && !receipt.logoutCompleted) receipt.status = "FAIL";
    try { await browser?.close(); } catch { receipt.status = "FAIL"; }
    if (receipt.pageErrors || receipt.unexpectedHttpErrors || receipt.unexpectedConsoleErrors
      || receipt.requestFailures || receipt.blockedRequests || receipt.attemptedBusinessWrites) receipt.status = "FAIL";
    writePrivateNew(join(directory, "receipt.json"), { ...receipt, metrics: compactManualUiMetrics(receipt.metrics) });
  }
  console.log(JSON.stringify({ status: receipt.status, directory, pages: receipt.pages, screenshots: receipt.images.length,
    loginCompleted: receipt.loginCompleted, logoutCompleted: receipt.logoutCompleted, pageErrors: receipt.pageErrors,
    unexpectedConsoleErrors: receipt.unexpectedConsoleErrors, requestFailures: receipt.requestFailures,
    blockedRequests: receipt.blockedRequests, unexpectedHttpErrors: receipt.unexpectedHttpErrors,
    attemptedBusinessWrites: receipt.attemptedBusinessWrites, completedBusinessWrites: 0, failure: receipt.failure }));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--human-login-read-only") {
    console.error("Explicit --human-login-read-only required. Never pass credentials in arguments."); process.exitCode = 1;
  } else {
    try { if ((await runManualUiCheck()).status !== "PASS") process.exitCode = 1; }
    catch { console.error("Manual UI check failed its private evidence/browser guard; no secrets printed."); process.exitCode = 1; }
  }
}
