import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createPortReservation, type AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Download, LaunchOptions, Page } from "playwright";
import { createApp } from "../../src/app.js";
import { createHttpLifecycle } from "../../src/server.js";
import { assertNoHarnessDebug } from "../mysql-auth/http-browser.js";
import { mysqlEnvironmentKeys, zohoEnvironmentKeys } from "../../src/runtime/environment-settings.js";
import type { CrmDemoCaseOptions } from "./cases.js";
import { consumeCrmDemo, CrmDemoCaseError, ensureCrmDemo, verifyCrmDemoFixture } from "./fixture.js";

export const expectedCrmDemoChromiumChecks = 6;
export const crmDemoInstanceId = "isolated-crm-demo";
export interface OwnedCrmFrontend { readonly origin: string; close(): Promise<void> }
export interface CrmChromiumEffects {
  verify(options: CrmDemoCaseOptions): Promise<void>;
  consume(options: CrmDemoCaseOptions): void;
  open(options: CrmDemoCaseOptions): Promise<OwnedCrmFrontend>;
  check(target: OwnedCrmFrontend, options: CrmDemoCaseOptions): Promise<number>;
}

function ownOrigin(origin: string): boolean {
  try {
    const value = new URL(origin), port = Number(value.port);
    return value.origin === origin && value.protocol === "http:" && value.hostname === "127.0.0.1"
      && !value.username && !value.password && Number.isInteger(port) && port >= 1024 && port <= 65535;
  } catch { return false; }
}

/** Only the owned Next origin. External navigation, workers and sockets cannot become integration calls. */
export function allowedCrmBrowserRequest(origin: string, value: string): boolean {
  if (!ownOrigin(origin)) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password
      && !/%(?:2f|5c|00)/i.test(url.pathname) && !url.pathname.includes("\\")
      && (url.pathname.startsWith("/_next/static/") || url.pathname === "/favicon.ico" || url.pathname === "/"
        || /^\/legacy\/assets\/(?:css|fonts|images)\/[A-Za-z0-9_./-]+\.(?:css|woff2?|ttf|eot|svg|png|jpe?g|webp)$/.test(url.pathname)
        || /^\/(?:login|account|dashboard|pipeline|items|jobs|quotations)$/.test(url.pathname)
        || /^\/(?:jobs|leads|quotations)\/[1-9][0-9]{0,18}(?:\/edit)?$/.test(url.pathname)
        || /^\/(?:items|quotations|deals)\/new$/.test(url.pathname)
        || /^\/departments\/(?:Electrical|Civil|PM|Switchgear|Maintenance)\/jobs(?:\/[1-9][0-9]{0,18})?$/.test(url.pathname)
        || /^\/settings\/(?:users(?:\/departments)?|permissions(?:\/assign)?|permission-groups)$/.test(url.pathname)
        || url.pathname === "/reports/employee-performance"
        || /^\/api\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(url.pathname));
  } catch { return false; }
}

/** Deliberately do not spread process.env or inherit debug/profile credentials. */
export function crmBrowserProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE", "HOME", "PATH"]) {
    const value = source[name]; if (value !== undefined) result[name] = value;
  }
  return result;
}
export function crmNextProcessEnvironment(source: NodeJS.ProcessEnv, origin: string, api: string): NodeJS.ProcessEnv {
  ensureCrmDemo(ownOrigin(origin) && ownOrigin(api) && origin !== api);
  return { ...crmBrowserProcessEnvironment(source), NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    // Next also reads the root .env. Blank backend-only values explicitly so
    // its dotenv loader cannot populate production credentials in this child.
    ...Object.fromEntries([...mysqlEnvironmentKeys, ...zohoEnvironmentKeys, "CRM_RUNTIME_ENABLE", "CRM_RUNTIME_SOURCE", "CRM_RUNTIME_PROFILE"].map(key => [key, ""])),
    CRM_API_INSTANCE_ID: crmDemoInstanceId, ZOHO_ENABLED: "false",
    CRM_MYSQL_NETWORK_DISABLED: "1", CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: api, APP_ORIGIN: origin };
}
export function crmChromiumLaunchOptions(source: NodeJS.ProcessEnv): LaunchOptions {
  return { headless: true, env: crmBrowserProcessEnvironment(source), timeout: 30_000,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync",
      "--no-first-run", "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
      "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] };
}

/** Test-only owned child bootstrap using the installed Next production server.
 * Standard Next configuration loading remains intact; explicit process values
 * select Express and disable direct SQL. Child output is discarded, never
 * copied into reports. Existing environment files are never changed. */
export const crmNextChildBootstrap = String.raw`
"use strict";
const root = process.argv[1], port = Number(process.argv[2]), receipt = process.argv[3];
const fail = () => { if (process.send) process.send({ type: "crm-demo-failed" }); process.exit(1); };
process.on("uncaughtException", fail); process.on("unhandledRejection", fail);
try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9-]{36}$/.test(receipt)) throw Error();
  const { startServer } = require(require.resolve("next/dist/server/lib/start-server", { paths: [root] }));
  startServer({ dir: root, port, hostname: "127.0.0.1", isDev: false, allowRetry: false, keepAliveTimeout: 1000 })
    .then(() => { if (process.send) process.send({ type: "crm-demo-ready", receipt, pid: process.pid, port }); }).catch(fail);
} catch { fail(); }
`;

/** Offline orchestration seam only. Production runner uses fixed real effects below. */
export function createCrmChromiumRunner(effects: CrmChromiumEffects) {
  return async (options: CrmDemoCaseOptions): Promise<number> => {
    let target: OwnedCrmFrontend | undefined, failed = false, count = 0;
    try {
      await effects.verify(options); effects.consume(options);
      target = await effects.open(options); ensureCrmDemo(ownOrigin(target.origin));
      count = await effects.check(target, options); ensureCrmDemo(count === expectedCrmDemoChromiumChecks);
      await effects.verify(options);
    } catch { failed = true; }
    if (target) { try { await target.close(); } catch { failed = true; } }
    if (failed) throw new CrmDemoCaseError();
    return count;
  };
}

function ordinaryFile(root: string, file: string) {
  ensureCrmDemo(file.startsWith(root + "/") || file.startsWith(root + "\\"));
  const values = [root];
  for (let cursor = dirname(file); cursor !== root; cursor = dirname(cursor)) {
    ensureCrmDemo(cursor !== dirname(cursor)); values.push(cursor);
  }
  values.push(file);
  for (const value of values) {
    const stat = lstatSync(value); ensureCrmDemo(!stat.isSymbolicLink() && realpathSync(value).toLowerCase() === value.toLowerCase());
  }
  ensureCrmDemo(lstatSync(file).isFile() && lstatSync(file).nlink === 1);
}
async function freePort(): Promise<number> {
  const reservation = createPortReservation();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", () => reject(new CrmDemoCaseError()));
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(new CrmDemoCaseError()) : resolve()));
  ensureCrmDemo(port >= 1024 && port <= 65535); return port;
}
async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      // Kill only this exact owned child handle; never use PID lookup/taskkill.
      child.kill("SIGKILL"); reject(new CrmDemoCaseError());
    }, 8000);
    child.once("exit", () => { clearTimeout(deadline); resolve(); });
    child.once("error", () => { clearTimeout(deadline); reject(new CrmDemoCaseError()); });
    child.kill("SIGTERM");
  });
}

async function openOwnedFrontend(options: CrmDemoCaseOptions): Promise<OwnedCrmFrontend> {
  const nextRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
  ordinaryFile(nextRoot, join(nextRoot, ".next", "BUILD_ID"));
  ordinaryFile(nextRoot, join(nextRoot, "node_modules", "next", "dist", "server", "lib", "start-server.js"));
  const runtime = options.createRuntime();
  let app: ReturnType<typeof createApp> | undefined, child: ChildProcess | undefined, stopped: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (request, response) => {
    if (!app) { response.writeHead(503); response.end(); return; } app(request, response);
  });
  const lifecycle = createHttpLifecycle(server);
  server.on("error", () => { app = undefined; });
  const close = () => stopped ??= (async () => {
    let failed = false;
    if (child) { try { await stopOwnedChild(child); } catch { failed = true; } }
    try { await lifecycle.stop(); } catch { failed = true; }
    try { await runtime.close(); } catch { failed = true; }
    if (failed) throw new CrmDemoCaseError();
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new CrmDemoCaseError()); server.once("error", fail);
      server.listen(0, "127.0.0.1", () => { server.off("error", fail); resolve(); });
    });
    const apiPort = (server.address() as AddressInfo).port, port = await freePort();
    const origin = `http://127.0.0.1:${port}`, api = `http://127.0.0.1:${apiPort}`, receipt = randomUUID();
    ensureCrmDemo(ownOrigin(api) && ownOrigin(origin) && origin !== api);
    app = createApp({ environment: "test", host: "127.0.0.1", port: apiPort, appOrigin: origin, instanceId: crmDemoInstanceId }, { auth: runtime.auth, crmDatabase: runtime.database });
    child = spawn(process.execPath, ["--input-type=commonjs", "-e", crmNextChildBootstrap, nextRoot, String(port), receipt],
      { cwd: nextRoot, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: crmNextProcessEnvironment(process.env, origin, api) });
    const owned = child;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(fail, 30_000);
      function done() { clearTimeout(deadline); owned.off("error", fail); owned.off("exit", fail); owned.off("message", message); }
      function fail() { done(); reject(new CrmDemoCaseError()); }
      function message(value: unknown) {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (record.type === "crm-demo-failed") { fail(); return; }
        if (record.type === "crm-demo-ready" && record.receipt === receipt && record.pid === owned.pid && record.port === port) {
          done(); resolve();
        }
      }
      owned.on("error", fail); owned.on("exit", fail); owned.on("message", message);
    });
    ensureCrmDemo(owned.exitCode === null && owned.signalCode === null);
    // No port probe occurs before the exact owned child's authenticated IPC readiness.
    return { origin, close };
  } catch {
    try { await close(); } catch { /* aggregate refusal only */ }
    throw new CrmDemoCaseError();
  }
}

async function downloadBytes(download: Download): Promise<Buffer> {
  ensureCrmDemo(await download.failure() === null);
  const stream = await download.createReadStream(); ensureCrmDemo(stream);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk as Uint8Array); length += bytes.length;
    if (length > 20 * 1024 * 1024) { stream.destroy(); throw new CrmDemoCaseError(); } chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
async function uiLogin(page: Page, origin: string, options: CrmDemoCaseOptions, name: "operator" | "denied") {
  await page.goto(origin + "/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email address", { exact: true }).fill(options.fixture.identities[name].email);
  await page.getByLabel("Password", { exact: true }).fill(options.fixture.password);
  await page.getByRole("button", { name: /^(Login|Sign in)$/ }).click();
  const destination = name === "operator" ? "/dashboard" : "/account";
  await page.waitForURL(origin + destination);
  await page.getByRole("heading", { name: name === "operator" ? "Dashboard" : "Your account", exact: true }).waitFor();
}
async function uiLogout(page: Page, origin: string) {
  await page.getByRole("button", { name: "User menu", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(origin + "/login");
  await page.goto(origin + "/account", { waitUntil: "domcontentloaded" });
  await page.waitForURL(origin + "/login");
}

async function realChromiumChecks(target: OwnedCrmFrontend, options: CrmDemoCaseOptions): Promise<number> {
  const { chromium } = await import("playwright");
  ensureCrmDemo(existsSync(chromium.executablePath())); // never downloads a browser
  let browser: Browser | undefined, passed = 0, failed = false;
  const check = async (name: string, work: () => Promise<void>) => { await work(); options.record(name, "chromium"); passed++; };
  try {
    browser = await chromium.launch(crmChromiumLaunchOptions(process.env));
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(15_000); context.setDefaultNavigationTimeout(20_000);
    await context.route("**/*", route => allowedCrmBrowserRequest(target.origin, route.request().url()) ? route.continue() : route.abort("blockedbyclient"));
    await context.routeWebSocket("**/*", socket => socket.close());
    const page = await context.newPage(); let consoleErrors = 0, pageErrors = 0;
    page.on("console", message => { if (message.type() === "error") consoleErrors++; });
    page.on("pageerror", () => { pageErrors++; });
    await check("Chromium Next to Express login and permission-scoped navigation", async () => {
      await uiLogin(page, target.origin, options, "operator");
      await page.getByRole("button", { name: "Jobs Departments", exact: true }).click();
      await page.getByRole("navigation", { name: "CRM navigation" }).getByRole("link", { name: "Jobs", exact: true }).waitFor();
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    });
    await check("Chromium job remarks persist after a full frontend reload", async () => {
      await page.goto(`${target.origin}/jobs/${options.fixture.jobId}`, { waitUntil: "domcontentloaded" });
      const remarks = `${options.fixture.marker}:chromium`;
      await page.getByLabel("Administrator remarks", { exact: true }).fill(remarks);
      await page.getByRole("button", { name: "Save remarks", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Job saved." }).waitFor();
      await page.reload({ waitUntil: "domcontentloaded" });
      ensureCrmDemo(await page.getByLabel("Administrator remarks", { exact: true }).inputValue() === remarks);
    });
    await check("Chromium authorized task file upload and private download bytes", async () => {
      const name = `synthetic-browser-${options.fixture.fixtureId}.txt`, bytes = Buffer.from(`${options.fixture.marker}:browser-file`);
      await page.getByLabel("Attachment file", { exact: true }).setInputFiles({ name, mimeType: "text/plain", buffer: bytes });
      await page.getByRole("button", { name: "Upload attachment", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Attachment saved." }).waitFor();
      const pending = page.waitForEvent("download"); await page.getByRole("link", { name, exact: true }).click();
      ensureCrmDemo((await downloadBytes(await pending)).equals(bytes));
    });
    await check("Chromium authorized quotation PDFs through both company templates", async () => {
      for (const taskId of [options.fixture.contractingTaskId, options.fixture.switchgearTaskId]) {
        await page.goto(`${target.origin}/quotations/${taskId}`, { waitUntil: "domcontentloaded" });
        const pending = page.waitForEvent("download"); await page.getByRole("link", { name: "Download quotation PDF", exact: true }).click();
        const bytes = await downloadBytes(await pending); ensureCrmDemo(bytes.subarray(0, 8).toString() === "%PDF-1.7");
      }
    });
    await check("Chromium responsive positive pages have no horizontal overflow or console exceptions", async () => {
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 900 }); await page.goto(target.origin + "/account", { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Your account", exact: true }).waitFor();
        ensureCrmDemo(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1") === true);
      }
      ensureCrmDemo(consoleErrors === 0 && pageErrors === 0);
    });
    await uiLogout(page, target.origin); await context.close();
    await check("Chromium denied identity lacks navigation and protected pages and logout revokes access", async () => {
      const denied = await browser!.newContext({ serviceWorkers: "block", acceptDownloads: false });
      try {
        denied.setDefaultTimeout(15000);
        await denied.route("**/*", route => allowedCrmBrowserRequest(target.origin, route.request().url()) ? route.continue() : route.abort("blockedbyclient"));
        await denied.routeWebSocket("**/*", socket => socket.close());
        const page = await denied.newPage(); let exceptions = 0; page.on("pageerror", () => { exceptions++; });
        await uiLogin(page, target.origin, options, "denied");
        ensureCrmDemo(await page.getByRole("navigation", { name: "CRM navigation" }).getByRole("link", { name: "Jobs", exact: true }).count() === 0);
        const refusal = await page.goto(target.origin + "/jobs", { waitUntil: "domcontentloaded" });
        ensureCrmDemo(refusal?.status() === 404);
        await page.goto(target.origin + "/account", { waitUntil: "domcontentloaded" }); await uiLogout(page, target.origin);
        ensureCrmDemo(exceptions === 0);
      } finally { await denied.close(); }
    });
  } catch { failed = true; }
  if (browser) { try { await browser.close(); } catch { failed = true; } }
  if (failed) throw new CrmDemoCaseError(); return passed;
}

/** PREPARED ONLY. Outer runner must independently require current approval's
 * Chromium scope and owned isolated target before calling this entry point. */
export async function runCrmDemoChromium(options: CrmDemoCaseOptions): Promise<number> {
  assertNoHarnessDebug(process.env, process.execArgv);
  return createCrmChromiumRunner({
    verify: value => verifyCrmDemoFixture(value.fixtureConnection, value.fixture),
    consume: value => consumeCrmDemo(value.fixture, "chromium"), open: openOwnedFrontend, check: realChromiumChecks,
  })(options);
}
