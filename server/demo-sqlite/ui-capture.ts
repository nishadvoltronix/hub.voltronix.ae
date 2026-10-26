import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { privateAccess } from "../scripts/mysql-auth/files.js";
import { acknowledgement, access, backendRoot, demoConfiguration, privateDirectory, workspaceRoot, writePrivateNew } from "./storage.js";

const frontend = "http://127.0.0.1:3001";
const currentFile = fileURLToPath(import.meta.url);
const loader = pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href;
export const UI_CAPTURE_VIEWPORTS = [{ name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 768, height: 1024 }, { name: "mobile", width: 390, height: 844 },
  { name: "narrow", width: 360, height: 844 }] as const;

export function captureChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, CRM_SQLITE_DEMO: acknowledgement, CRM_API_ENVIRONMENT: "development", CRM_API_HOST: "127.0.0.1",
    CRM_API_PORT: "3002", APP_ORIGIN: frontend, NODE_ENV: "development", CRM_MYSQL_NETWORK_DISABLED: "1",
    NEXT_TELEMETRY_DISABLED: "1", TSX_DISABLE_CACHE: "1" };
}

export function allowedCaptureRequest(origin: string, value: string, method: string): boolean {
  try {
    const url = new URL(value);
    if (origin !== frontend || url.origin !== origin || url.username || url.password
      || /%(?:2e|2f|5c|00)|\\/i.test(url.pathname) || url.pathname.split("/").some(segment => segment.startsWith("."))) return false;
    if (method === "POST") return url.pathname === "/api/auth/login";
    if (method !== "GET" && method !== "HEAD") return false;
    return url.pathname === "/" || /^\/(?:login|account|dashboard|jobs|pipeline|leads|deals|items|quotations|reports|settings|departments)(?:\/|$)/.test(url.pathname)
      || /^\/api\/(?:auth\/(?:csrf|me)|health\/live|dashboard|jobs|pipeline|leads|items|quotations|reports|settings|departments|tasks)(?:\/|$)/.test(url.pathname)
      || /^\/(?:_next\/static|legacy|assets|include)\//.test(url.pathname) || url.pathname === "/favicon.ico";
  } catch { return false; }
}

export interface CaptureImage { screen: string; viewport: string; filename: string; width: number; height: number; documentWidth: number }
export interface CaptureMetrics {
  screen: string; viewport: string; width: number; height: number; documentWidth: number;
  selectors: Record<string, null | { x: number; y: number; width: number; height: number; color: string; background: string;
    fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; padding: string; margin: string;
    borderColor: string; borderRadius: string; boxShadow: string; display: string; position: string }>;
}
interface CaptureReceipt {
  status: "PASS" | "CAPTURED" | "FAILED";
  phase: "before" | "after" | "reference";
  capturedAt: string;
  directory: string;
  images: CaptureImage[];
  metrics: CaptureMetrics[];
  metricFiles?: { filename: string; samples: number }[];
  currentScreen: string;
  observations: { blockedRequests: number; consoleErrors: number; pageErrors: number; failedRequests: number; navigationAborts: number; httpErrors: number };
  reference: "PENDING_ORIGINAL_PHP_RENDERER" | "SEPARATE_ORIGINAL_VIEW_REFERENCE" | "ORIGINAL_VIEWS_SYNTHETIC_RECORDS";
  limitation: string;
}

export async function settleCapturePage(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 20_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Viewport changes start CSS transitions without network activity. Measure
    // their settled bounds, matching the animation-disabled screenshots.
    const finiteAnimations = document.getAnimations().filter(animation => {
      const duration = animation.effect?.getComputedTiming().endTime;
      return animation.playState === "running" && typeof duration === "number" && Number.isFinite(duration) && duration <= 5_000;
    });
    await Promise.all(finiteAnimations.map(animation => animation.finished.catch(() => undefined)));
  });
}
export async function captureUiScreen(page: Page, receipt: Pick<CaptureReceipt, "directory" | "images" | "metrics">,
  screen: string, screenshots = true, validateViewport?: (viewport: typeof UI_CAPTURE_VIEWPORTS[number]) => Promise<void>): Promise<void> {
  if (!/^[a-z][a-z-]{0,40}$/.test(screen)) throw new Error("Screenshot label refused.");
  for (const viewport of UI_CAPTURE_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settleCapturePage(page);
    await validateViewport?.(viewport);
    const selectors = await page.evaluate(() => {
      const result: CaptureMetrics["selectors"] = {};
      for (const selector of [".pc-sidebar", ".pc-header", ".pc-container", ".pc-content", ".auth-main", ".auth-wrapper",
        ".auth-form", ".auth-form .card", ".auth-sidecontent", ".auth-sidecontent .card", ".auth-card", ".crm-login-card", ".workspace"]) {
        const element = document.querySelector(selector);
        if (!element) { result[selector] = null; continue; }
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        result[selector] = { x: box.x, y: box.y, width: box.width, height: box.height, color: style.color,
          background: style.backgroundColor, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
          lineHeight: style.lineHeight, padding: style.padding, margin: style.margin, borderColor: style.borderColor,
          borderRadius: style.borderRadius, boxShadow: style.boxShadow, display: style.display, position: style.position };
      }
      return result;
    });
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    receipt.metrics.push({ screen, viewport: viewport.name, width: viewport.width, height: viewport.height, documentWidth, selectors });
    if (!screenshots) continue;
    const filename = `${viewport.name}-${screen}.png`, path = join(receipt.directory, filename);
    // Credentials are never photographed. Blank login inputs remain visually
    // faithful; authenticated synthetic addresses are masked in every view.
    const masks = page.locator('input[type="password"],input[type="email"]').filter({ visible: true });
    let filledCredentials = false;
    for (const input of await masks.all()) if (await input.inputValue() !== "") filledCredentials = true;
    const bytes = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide",
      mask: [...(filledCredentials ? [masks] : []), page.getByText(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)], maskColor: "#d5d9df" });
    if (bytes.length > 20 * 1024 * 1024) throw new Error("Screenshot size refused.");
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); bytes.fill(0); }
    privateAccess(path, false);
    receipt.images.push({ screen, viewport: viewport.name, filename, width: viewport.width, height: viewport.height,
      documentWidth });
  }
}

/** UI evidence only: existing authenticated synthetic reads plus one normal
 * login. No CRM mutation, service lifecycle, trace/state dump or external fetch. */
export async function captureCurrentUi(phase: "before" | "after"): Promise<CaptureReceipt> {
  demoConfiguration(process.env);
  const state = spawnSync(process.execPath, ["--import", loader, join(backendRoot, "demo-sqlite/control.ts"), "status"],
    { cwd: backendRoot, env: captureChildEnvironment(), windowsHide: true, encoding: "utf8", timeout: 25_000 });
  if (state.status !== 0 || JSON.parse(state.stdout).status !== "RUNNING") throw new Error("Owned demo is not ready.");
  const fixture = access().fixture, directory = privateDirectory(["evidence", `ui-${phase}-${randomUUID()}`], true);
  const receipt: CaptureReceipt = { status: "FAILED", phase, capturedAt: new Date().toISOString(), directory, images: [], metrics: [],
    currentScreen: "browser", observations: { blockedRequests: 0, consoleErrors: 0, pageErrors: 0, failedRequests: 0, navigationAborts: 0, httpErrors: 0 },
    reference: phase === "after" ? "SEPARATE_ORIGINAL_VIEW_REFERENCE" : "PENDING_ORIGINAL_PHP_RENDERER",
    limitation: "Screenshots establish the running UI, not original PHP parity or new workflow acceptance. Login secrets, browser state and raw errors are not retained." };
  let browser: Browser | undefined, context: BrowserContext | undefined;
  try {
    if (!existsSync(chromium.executablePath())) throw new Error("Installed Chromium required.");
    browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string>, timeout: 30_000,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync",
        "--no-first-run", "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(25_000);
    await context.route("**/*", route => {
      if (allowedCaptureRequest(frontend, route.request().url(), route.request().method())) return route.continue();
      receipt.observations.blockedRequests++; return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", socket => { receipt.observations.blockedRequests++; socket.close(); });
    context.on("requestfailed", request => {
      if (request.failure()?.errorText === "net::ERR_ABORTED") receipt.observations.navigationAborts++;
      else receipt.observations.failedRequests++;
    });
    context.on("response", response => { if (response.status() >= 400) receipt.observations.httpErrors++; });
    const page = await context.newPage();
    page.on("console", message => { if (message.type() === "error") receipt.observations.consoleErrors++; });
    page.on("pageerror", () => { receipt.observations.pageErrors++; });
    const visit = async (screen: string, path: string) => {
      receipt.currentScreen = screen;
      const response = await page.goto(frontend + path, { waitUntil: "domcontentloaded" });
      if (response?.status() !== 200) throw new Error("Screenshot page unavailable.");
      await settleCapturePage(page); await captureUiScreen(page, receipt, screen);
    };
    await visit("login", "/login");
    receipt.currentScreen = "login-authentication";
    await page.getByLabel("Email address", { exact: true }).fill(fixture.identities.browser.email);
    await page.getByLabel("Password", { exact: true }).fill(fixture.identities.browser.password);
    await page.getByRole("button", { name: /^(Login|Sign in)$/ }).click();
    await page.waitForURL(url => url.origin === frontend && ["/account", "/dashboard"].includes(url.pathname)); await settleCapturePage(page);
    for (const [screen, path] of [
      ["dashboard", "/dashboard"], ["jobs", "/jobs"], ["pipeline", "/pipeline"], ["users", "/settings/users"],
      ["quotation-form", "/quotations/new"], ["reports", "/reports/employee-performance"], ["products", "/items"],
      ["quotations", "/quotations"], ["permissions", "/settings/permissions"], ["job-detail", `/jobs/${fixture.jobId}`],
      ["lead-detail", `/leads/${fixture.leadId}`], ["quotation-detail", `/quotations/${fixture.contractingTaskId}`],
    ]) await visit(screen!, path!);
    const overflow = receipt.metrics.find(metric => metric.documentWidth > metric.width + 1);
    if (overflow) receipt.currentScreen = `responsive-${overflow.screen}-${overflow.width}px`;
    receipt.status = receipt.observations.blockedRequests === 0 && receipt.observations.pageErrors === 0
      && receipt.observations.failedRequests === 0 && receipt.observations.httpErrors === 0 && receipt.observations.consoleErrors === 0
      && !overflow ? "PASS" : "FAILED";
  } catch { receipt.status = "FAILED"; }
  finally { try { await context?.close(); await browser?.close(); } catch { receipt.status = "FAILED"; } }
  writePrivateNew(join(directory, "receipt.json"), receipt);
  return receipt;
}

/** Runs the reviewed CLI-only PHP view renderer with configuration/network
 * loading disabled. The ephemeral server owns no database or authenticated
 * application session and serves only in-memory rendered HTML and public assets. */
export async function captureOriginalReference(metricsOnly = false): Promise<CaptureReceipt> {
  demoConfiguration(process.env);
  const php = join(process.env.LOCALAPPDATA ?? "", "voltronix-crm-runtime/php/php.exe");
  const renderer = join(backendRoot, "demo-sqlite/ui-reference.php");
  if (!existsSync(php) || !existsSync(renderer) || !existsSync(chromium.executablePath())) throw new Error("Reference dependencies unavailable.");
  const render = (page: string) => spawnSync(php, ["-n", "-d", "allow_url_fopen=0", renderer, page],
    { cwd: workspaceRoot, env: captureChildEnvironment(), windowsHide: true, encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const listed = render("--list");
  if (listed.status !== 0) throw new Error("Reference page list unavailable.");
  const pages = (JSON.parse(listed.stdout) as { pages?: unknown }).pages;
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 25
    || !pages.every(page => typeof page === "string" && /^[a-z][a-z-]{0,40}$/.test(page))) throw new Error("Reference page list invalid.");
  const html = new Map<string, string>();
  for (const page of pages as string[]) {
    const rendered = render(page);
    if (rendered.status !== 0 || !rendered.stdout.includes('name="crm-ui-reference"')) throw new Error("Original view render failed.");
    html.set(`/reference/${page}`, rendered.stdout);
  }
  const directory = privateDirectory(["evidence", `ui-reference${metricsOnly ? "-metrics" : ""}-${randomUUID()}`], true);
  const receipt: CaptureReceipt = { status: "FAILED", phase: "reference", capturedAt: new Date().toISOString(), directory,
    images: [], metrics: [], currentScreen: "reference-server", observations: { blockedRequests: 0, consoleErrors: 0, pageErrors: 0,
      failedRequests: 0, navigationAborts: 0, httpErrors: 0 }, reference: "ORIGINAL_VIEWS_SYNTHETIC_RECORDS",
    limitation: "Unchanged original PHP views rendered with synthetic display records. This is not a running PHP CRM or auth/database proof. CSP and browser routing block external assets, network APIs and forms; blocked-resource/script observations are retained." };
  const mediaTypes: Record<string, string> = { ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject" };
  const server = createServer((request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const document = html.get(url.pathname);
      if (document !== undefined) { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(request.method === "HEAD" ? undefined : document); return; }
      if (/[%\\]/.test(url.pathname) || url.pathname.split("/").some(segment => segment.startsWith("."))
        || !/^\/(?:include\/dist\/assets|assets)\//.test(url.pathname)) { response.writeHead(404).end(); return; }
      const type = mediaTypes[extname(url.pathname).toLowerCase()];
      const filename = resolve(workspaceRoot, "." + url.pathname);
      const expectedRoot = join(workspaceRoot, url.pathname.startsWith("/include/") ? "include/dist/assets" : "assets");
      if (!type || !filename.startsWith(expectedRoot + sep) || !existsSync(filename)) { response.writeHead(404).end(); return; }
      const actual = realpathSync(filename), stat = lstatSync(filename);
      if (actual.toLowerCase() !== filename.toLowerCase() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 25 * 1024 * 1024) {
        response.writeHead(404).end(); return;
      }
      response.writeHead(200, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : readFileSync(filename));
    } catch { response.writeHead(404).end(); }
  });
  let browser: Browser | undefined;
  try {
    await new Promise<void>((resolveReady, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveReady); });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string>, timeout: 30_000,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run",
        "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(25_000);
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && ["GET", "HEAD"].includes(route.request().method())
        && (html.has(url.pathname) || /^\/(?:include\/dist\/assets|assets)\//.test(url.pathname))) return route.continue();
      receipt.observations.blockedRequests++; return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", socket => { receipt.observations.blockedRequests++; socket.close(); });
    context.on("response", response => { if (response.status() >= 400) receipt.observations.httpErrors++; });
    context.on("requestfailed", request => {
      if (request.failure()?.errorText === "net::ERR_ABORTED") receipt.observations.navigationAborts++;
      else receipt.observations.failedRequests++;
    });
    const page = await context.newPage();
    page.on("pageerror", () => { receipt.observations.pageErrors++; });
    page.on("console", message => { if (message.type() === "error") receipt.observations.consoleErrors++; });
    for (const screen of pages as string[]) {
      receipt.currentScreen = screen;
      const response = await page.goto(`${origin}/reference/${screen}`, { waitUntil: "domcontentloaded" });
      if (response?.status() !== 200) throw new Error("Reference page unavailable.");
      await settleCapturePage(page); await captureUiScreen(page, receipt, screen, !metricsOnly);
    }
    receipt.status = "CAPTURED";
  } catch { receipt.status = "FAILED"; }
  finally {
    try { await browser?.close(); } catch { receipt.status = "FAILED"; }
    server.closeAllConnections();
    await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
  }
  // Keep the existing private-record size guard. Larger source inventories
  // retain login geometry inline and place the remaining samples in bounded
  // immutable parts, rather than weakening the private writer's byte limit.
  if (Buffer.byteLength(JSON.stringify(receipt, null, 2)) > 230_000) {
    const remaining = receipt.metrics.splice(UI_CAPTURE_VIEWPORTS.length);
    receipt.metricFiles = [];
    for (let offset = 0; offset < remaining.length; offset += 32) {
      const filename = `metrics-${String(receipt.metricFiles.length + 1).padStart(2, "0")}.json`;
      const samples = remaining.slice(offset, offset + 32);
      writePrivateNew(join(directory, filename), samples);
      receipt.metricFiles.push({ filename, samples: samples.length });
    }
  }
  writePrivateNew(join(directory, "receipt.json"), receipt);
  return receipt;
}

if (resolve(process.argv[1] ?? "") === currentFile) {
  const phase = process.argv[2];
  if (phase !== "before" && phase !== "after" && phase !== "reference" && phase !== "reference-metrics") {
    console.error(JSON.stringify({ status: "REFUSED", detail: "Select before, after, reference or reference-metrics capture." })); process.exitCode = 1;
  } else if (process.env.CRM_SQLITE_DEMO !== acknowledgement) {
    const child = spawn(process.execPath, ["--import", loader, currentFile, phase],
      { cwd: backendRoot, env: captureChildEnvironment(), windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise<number>(resolveExit => { child.once("error", () => resolveExit(1)); child.once("exit", code => resolveExit(code ?? 1)); });
  } else {
    try {
      const receipt = phase === "reference" || phase === "reference-metrics"
        ? await captureOriginalReference(phase === "reference-metrics") : await captureCurrentUi(phase);
      console.log(JSON.stringify({ status: receipt.status, phase, directory: receipt.directory, screenshots: receipt.images.length,
        metricSamples: receipt.metrics.length + (receipt.metricFiles ?? []).reduce((count, file) => count + file.samples, 0),
        currentScreen: receipt.currentScreen, observations: receipt.observations, reference: receipt.reference }));
      process.exitCode = receipt.status === "FAILED" ? 1 : 0;
    } catch { console.error(JSON.stringify({ status: "FAILED", phase, detail: "UI capture refused; no secret or raw browser errors were logged." })); process.exitCode = 1; }
  }
}
