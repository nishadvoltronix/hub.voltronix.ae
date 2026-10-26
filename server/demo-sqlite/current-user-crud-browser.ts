import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Download, type Page } from "playwright";
import { privateAccess } from "../scripts/mysql-auth/files.js";
import { allowedDemoBrowserRequest, safeBrowserFailure, type SafeBrowserFailure } from "./browser-acceptance.js";
import { boundedBrowserOperation } from "./current-user-browser.js";
import { dataRoot, demoConfiguration, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";
import { UI_CAPTURE_VIEWPORTS } from "./ui-capture.js";

/** No CLI, credential reader, database access, provisioning or lifecycle calls.
 * Every business write is armed once and restricted to records created here.
 * An interrupted/ambiguous write is never automatically retried. */
export interface CrudBrowserOptions {
  origin: string;
  account: { email: string; password: string };
  mode: "create" | "resume";
  existingPdfTaskIds: { contracting: string; switchgear: string };
  priorReceipt?: string;
}
export interface CrudOwnedRecords {
  productId?: string; taskId?: string; noteId?: string; quoteId?: string;
  attachmentId?: string; accountsAssignmentId?: string;
}
type Json = Record<string, unknown>;
type Status = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export interface CrudOperation {
  sequence: number; eventId: string; case: string; method: string; path: string;
  operationId: string | null; requestSha256: string; expectedVersion: number | null;
  targets: CrudOwnedRecords; intentFile: string; outcomeFile?: string;
  status: "INTENT" | "COMMITTED" | "REFUSED" | "UNRESOLVED";
  httpStatus?: number; created?: CrudOwnedRecords; version?: number; quoteVersion?: number;
}
export interface CrudBrowserReceipt {
  schemaVersion: 1; kind: "current-user-local-crud"; mode: "create" | "resume";
  status: "PASS" | "FAIL"; runId: string; marker: string; actorId: "15";
  directory: string; receipt: string; sourceReceipt?: string; startedAt: string; finishedAt?: string;
  created: CrudOwnedRecords; operations: CrudOperation[];
  cases: { name: string; status: Status; reason?: string; failure?: SafeBrowserFailure }[];
  counts: Record<"pass" | "fail" | "blocked" | "notRun", number>;
  snapshots: { path: string; sha256: string }[];
  attachment?: { filename: string; bytes: number; sha256: string };
  images: { screen: string; viewport: string; filename: string; documentWidth: number; viewportWidth: number }[];
  artifacts: { kind: "pdf"; template: string; filename: string; bytes: number; sha256: string }[];
  observations: { loginAttempts: number; businessWriteRequests: number; blockedRequests: number;
    unexpectedConsoleErrors: number; pageErrors: number; unexpectedHttpErrors: number;
    unexpectedRequestFailures: number; expectedRefusals: number; expectedConsoleRefusals: number; navigationAborts: number };
  accountInvariant?: { totalUsers: number; activeUsers: number; unchanged: boolean };
  ownSessionCleanup: "NOT_NEEDED" | "PASS" | "FAIL";
}
const ORIGIN = "http://127.0.0.1:3001";
const id = /^[1-9][0-9]{0,18}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const productId = /^9[0-9]{39}$/;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Json => { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Json; };
const positiveVersion = (value: unknown): number => { assert.ok(Number.isSafeInteger(value) && Number(value) > 0); return Number(value); };
const numericId = (value: unknown): string => { assert.equal(typeof value, "string"); assert.match(value as string, id); return value as string; };

/** Refusals have no committed result to decode. A fetch that only consumes
 * headers can leave Playwright's separate body promise unresolved. Preserve
 * the observed refusal immediately; subsequent reads verify no mutation. */
export async function readCrudMutationBody(response: { status(): number; json(): Promise<unknown> }, timeout = 20_000): Promise<Json> {
  if (response.status() !== 200) return {};
  return object(await boundedBrowserOperation(response.json(), timeout));
}

export function validateCrudOptions(options: CrudBrowserOptions): void {
  assert.equal(options.origin, ORIGIN);
  assert.ok(options.mode === "create" || options.mode === "resume");
  assert.ok(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.account.email) && options.account.email.length <= 254);
  assert.ok(typeof options.account.password === "string" && Buffer.byteLength(options.account.password) > 0
    && Buffer.byteLength(options.account.password) <= 72 && !options.account.password.includes("\0"));
  for (const value of Object.values(options.existingPdfTaskIds)) assert.match(value, id);
  assert.ok(options.mode === "resume" ? typeof options.priorReceipt === "string" : options.priorReceipt === undefined);
}

/** This is a second boundary in addition to the one-shot armed request. Merely
 * supplying an existing fixture ID can never make it a writable target. */
export function allowedCrudRequest(state: { origin: string; mode: "create" | "resume"; created: CrudOwnedRecords }, value: string, method: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (state.origin !== ORIGIN || url.origin !== ORIGIN || url.username || url.password
    || /%|\\/.test(url.pathname) || url.hash) return false;
  if (method === "GET" || method === "HEAD") return url.pathname === "/deals" || allowedDemoBrowserRequest(ORIGIN, value);
  if (url.search) return false;
  if (method === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(url.pathname)) return true;
  if (state.mode !== "create") return false;
  const owned = state.created, path = url.pathname;
  if (method === "POST" && path === "/api/items") return !owned.productId;
  if (method === "POST" && path === "/api/deals") return !owned.taskId;
  if (!owned.taskId || !id.test(owned.taskId)) return false;
  if (method === "POST") return path === `/api/leads/${owned.taskId}/notes` && !owned.noteId
    || path === `/api/leads/${owned.taskId}/attachments` && !owned.attachmentId
    || path === `/api/jobs/${owned.taskId}/accounts` && !owned.accountsAssignmentId
    || path === "/api/quotations" && !owned.quoteId;
  if (method !== "PATCH") return false;
  return [`/api/leads/${owned.taskId}/stage`, `/api/jobs/${owned.taskId}/remarks`, `/api/jobs/${owned.taskId}/status`].includes(path)
    || !!owned.noteId && id.test(owned.noteId) && path === `/api/leads/${owned.taskId}/notes/${owned.noteId}`
    || !!owned.quoteId && /^local-[1-9][0-9]{0,18}$/.test(owned.quoteId) && path === `/api/quotations/${owned.taskId}`;
}

function snapshotPaths(created: CrudOwnedRecords): string[] {
  assert.ok(created.productId && productId.test(created.productId)); assert.ok(created.taskId && id.test(created.taskId));
  return [`/api/items/${created.productId}`, `/api/leads/${created.taskId}`, `/api/leads/${created.taskId}/capabilities`,
    `/api/leads/${created.taskId}/notes`, `/api/leads/${created.taskId}/history`, `/api/quotations/${created.taskId}`,
    `/api/jobs/${created.taskId}`, `/api/jobs/${created.taskId}/assignments`, `/api/leads/${created.taskId}/attachments`];
}
export function validateCrudResumeReceipt(value: unknown): asserts value is CrudBrowserReceipt {
  const record = object(value);
  assert.equal(record.schemaVersion, 1); assert.equal(record.kind, "current-user-local-crud");
  assert.equal(record.mode, "create"); assert.equal(record.status, "PASS"); assert.equal(record.actorId, "15");
  assert.equal(typeof record.runId, "string"); assert.match(record.runId as string, uuid);
  assert.equal(record.marker, `LOCAL CRUD ACCEPTANCE ${String(record.runId)}`);
  const created = object(record.created) as CrudOwnedRecords;
  assert.ok(created.productId && productId.test(created.productId));
  for (const key of ["taskId", "noteId", "accountsAssignmentId"] as const) assert.ok(created[key] && id.test(created[key]!));
  assert.ok(created.quoteId && /^local-[1-9][0-9]{0,18}$/.test(created.quoteId)); assert.ok(created.attachmentId && uuid.test(created.attachmentId));
  assert.ok(Array.isArray(record.operations) && record.operations.length >= 10 && record.operations.length <= 25);
  for (const entry of record.operations) {
    const operation = object(entry); assert.ok(["COMMITTED", "REFUSED"].includes(String(operation.status)));
    assert.match(String(operation.eventId), uuid); assert.match(String(operation.requestSha256), /^[0-9a-f]{64}$/);
  }
  const paths = snapshotPaths(created);
  assert.ok(Array.isArray(record.snapshots)); assert.equal(record.snapshots.length, paths.length);
  for (const [index, entry] of record.snapshots.entries()) {
    const snapshot = object(entry); assert.equal(snapshot.path, paths[index]); assert.match(String(snapshot.sha256), /^[0-9a-f]{64}$/);
  }
  const attachment = object(record.attachment);
  assert.equal(attachment.filename, `local-crud-${String(record.runId)}.txt`);
  const bytes = Buffer.from(`${String(record.marker)}\nPersistent acceptance attachment.\n`);
  assert.equal(attachment.bytes, bytes.length); assert.equal(attachment.sha256, hash(bytes));
  assert.equal(record.ownSessionCleanup, "PASS");
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 20_000 });
  await boundedBrowserOperation(page.evaluate(async () => { await document.fonts.ready; }), 10_000);
}
async function read(page: Page, path: string): Promise<Json> {
  const reply = await boundedBrowserOperation(page.evaluate(async path => {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as unknown };
  }, path));
  assert.equal(reply.status, 200); return object(reply.body);
}
async function downloadBytes(download: Download): Promise<Buffer> {
  assert.equal(await boundedBrowserOperation(download.failure()), null);
  const stream = await boundedBrowserOperation(download.createReadStream()); assert.ok(stream);
  try { return await boundedBrowserOperation((async () => {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of stream) { const bytes = Buffer.from(chunk as Uint8Array); length += bytes.length;
      assert.ok(length <= 20 * 1024 * 1024); chunks.push(bytes); }
    return Buffer.concat(chunks);
  })()); } finally { stream.destroy(); }
}
function privateBytes(directory: string, filename: string, bytes: Buffer): void {
  const path = join(directory, filename), descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  privateAccess(path, false);
}

export async function runCurrentUserCrudAcceptance(options: CrudBrowserOptions): Promise<CrudBrowserReceipt> {
  validateCrudOptions(options); demoConfiguration(process.env);
  let prior: CrudBrowserReceipt | undefined;
  if (options.mode === "resume") {
    const filename = resolve(options.priorReceipt!);
    assert.equal(basename(filename), "receipt.json");
    assert.match(basename(dirname(filename)), /^current-user-crud-[0-9a-f-]{36}$/);
    assert.equal(dirname(dirname(filename)), join(dataRoot, "evidence"));
    const value = readPrivate(filename); validateCrudResumeReceipt(value); prior = value;
  }
  const runId = prior?.runId ?? randomUUID(), marker = `LOCAL CRUD ACCEPTANCE ${runId}`;
  const directory = privateDirectory(["evidence", `current-user-crud-${randomUUID()}`], true);
  const result: CrudBrowserReceipt = { schemaVersion: 1, kind: "current-user-local-crud", mode: options.mode, status: "FAIL",
    actorId: "15", runId, marker, directory, receipt: join(directory, "receipt.json"),
    ...(prior ? { sourceReceipt: resolve(options.priorReceipt!) } : {}), startedAt: new Date().toISOString(),
    created: prior ? { ...prior.created } : {}, operations: [], cases: [], counts: { pass: 0, fail: 0, blocked: 0, notRun: 0 },
    snapshots: [], images: [], artifacts: [], ownSessionCleanup: "NOT_NEEDED", observations: { loginAttempts: 0,
      businessWriteRequests: 0, blockedRequests: 0, unexpectedConsoleErrors: 0, pageErrors: 0, unexpectedHttpErrors: 0,
      unexpectedRequestFailures: 0, expectedRefusals: 0, expectedConsoleRefusals: 0, navigationAborts: 0 } };
  writePrivateNew(join(directory, "run.json"), { schemaVersion: 1, runId, marker, mode: options.mode, actorId: "15", startedAt: result.startedAt });
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
  let ownSession = false, currentCase = "Normal authorized login", step = "Initialize guarded browser", progressNumber = 0;
  let initialUsers = "", initialPermissions = "";
  let armed: { path: string; method: string; status: number; validate: (body: Json, bytes: Buffer) => void; operation?: CrudOperation } | undefined;
  const expected = new Map<string, number>();
  const progress = (name: string) => { step = name; writePrivateNew(join(directory, `progress-${String(++progressNumber).padStart(4, "0")}.json`),
    { at: new Date().toISOString(), step, case: currentCase, operations: result.operations.length, images: result.images.length }); };
  const state = { origin: options.origin, mode: options.mode, created: result.created };
  const healthy = () => { for (const key of ["blockedRequests", "unexpectedConsoleErrors", "pageErrors", "unexpectedHttpErrors", "unexpectedRequestFailures"] as const)
    assert.equal(result.observations[key], 0); };
  const check = async (name: string, action: () => Promise<void>) => {
    currentCase = name; progress("Begin case"); await action(); healthy(); result.cases.push({ name, status: "PASS" }); progress("Case complete");
  };
  try {
    assert.ok(existsSync(chromium.executablePath()));
    const environment: Record<string, string> = {};
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "USERPROFILE", "PATH"])
      if (process.env[key] !== undefined) environment[key] = process.env[key]!;
    browser = await chromium.launch({ headless: true, timeout: 30_000, env: environment,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync", "--no-first-run",
        "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
    context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(25_000);
    await context.route("**/*", async route => {
      const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
      if (!allowedCrudRequest(state, request.url(), method)) { result.observations.blockedRequests++; await route.abort("blockedbyclient"); return; }
      if (method === "POST" && path === "/api/auth/login") {
        result.observations.loginAttempts++;
        if (result.observations.loginAttempts > 1) { result.observations.blockedRequests++; await route.abort("blockedbyclient"); return; }
      }
      if (!["GET", "HEAD"].includes(method) && !["/api/auth/login", "/api/auth/logout"].includes(path)) {
        result.observations.businessWriteRequests++;
        try {
          assert.ok(armed && !armed.operation && armed.path === path && armed.method === method);
          const bytes = request.postDataBuffer(); assert.ok(bytes && bytes.length <= 128 * 1024);
          const body = request.headers()["content-type"]?.startsWith("application/json") ? object(JSON.parse(bytes.toString("utf8"))) : {};
          armed.validate(body, bytes);
          const operationId = body.operationId === undefined ? null : String(body.operationId);
          if (operationId) assert.match(operationId, uuid);
          const multipartVersion = body.expectedVersion === undefined && path.endsWith("/attachments")
            ? /name="expectedVersion"\r\n\r\n([1-9][0-9]*)\r\n/.exec(bytes.toString("utf8"))?.[1] : undefined;
          const expectedVersion = body.expectedVersion ?? (multipartVersion ? Number(multipartVersion) : undefined);
          const sequence = result.operations.length + 1;
          const operation: CrudOperation = { sequence, eventId: randomUUID(), case: currentCase, method, path,
            operationId, requestSha256: hash(bytes), expectedVersion: expectedVersion === undefined ? null : positiveVersion(expectedVersion),
            targets: { ...result.created }, intentFile: `intent-${String(sequence).padStart(3, "0")}.json`, status: "INTENT" };
          // This synchronous exclusive+fsync write must complete before the request leaves Chromium.
          writePrivateNew(join(directory, operation.intentFile), { ...operation, at: new Date().toISOString(), runId, marker, actorId: "15" });
          result.operations.push(operation); armed.operation = operation;
        } catch { result.observations.blockedRequests++; await route.abort("blockedbyclient"); return; }
      }
      await route.continue();
    });
    await context.routeWebSocket("**/*", socket => { result.observations.blockedRequests++; socket.close(); });
    context.on("response", response => {
      const path = new URL(response.url()).pathname;
      if (response.request().method() === "POST" && response.status() === 200) {
        if (path === "/api/auth/login") ownSession = true;
        if (path === "/api/auth/logout") ownSession = false;
      }
      if (response.status() >= 400) {
        if (expected.get(path) === response.status()) result.observations.expectedRefusals++;
        else result.observations.unexpectedHttpErrors++;
      }
    });
    context.on("requestfailed", request => {
      if (request.failure()?.errorText === "net::ERR_ABORTED" && allowedCrudRequest(state, request.url(), request.method())) result.observations.navigationAborts++;
      else result.observations.unexpectedRequestFailures++;
    });
    page = await context.newPage(); const activePage = page;
    page.on("pageerror", () => { result.observations.pageErrors++; });
    page.on("console", message => {
      if (message.type() !== "error") return;
      let allowed = false;
      try { const status = expected.get(new URL(message.location().url).pathname);
        allowed = status !== undefined && message.text().startsWith(`Failed to load resource: the server responded with a status of ${status}`); } catch { /* No raw browser output. */ }
      if (allowed) result.observations.expectedConsoleRefusals++; else result.observations.unexpectedConsoleErrors++;
    });
    const visit = async (path: string) => {
      progress("Open positive page"); assert.equal((await activePage.goto(ORIGIN + path, { waitUntil: "domcontentloaded" }))?.status(), 200);
      await settle(activePage);
      await activePage.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')]
        .some(element => element.getClientRects().length && /^Loading\b/.test(element.textContent?.trim() ?? "")));
      assert.equal(await activePage.locator('[role="alert"]:not(#__next-route-announcer__)').filter({ hasText: /\S/ }).count(), 0);
    };
    const capture = async (screen: string) => {
      for (const viewport of UI_CAPTURE_VIEWPORTS) {
        progress(`Capture ${screen} ${viewport.name}`); await activePage.setViewportSize(viewport);
        await boundedBrowserOperation(activePage.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          window.scrollTo(0, 0);
        }));
        await settle(activePage);
        await boundedBrowserOperation(activePage.evaluate(() => new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })), 10_000);
        const documentWidth = await boundedBrowserOperation(activePage.evaluate(() => document.documentElement.scrollWidth));
        const email = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
        const bytes = await activePage.screenshot({ fullPage: true, animations: "disabled", caret: "hide", maskColor: "#d5d9df",
          mask: [activePage.locator('input[type="email"],input[type="password"],input[name="email"]'), activePage.getByText(email),
            activePage.locator("select").filter({ has: activePage.locator("option").filter({ hasText: email }) })] });
        const filename = `${viewport.name}-${screen}.png`; privateBytes(directory, filename, bytes); bytes.fill(0);
        result.images.push({ screen, viewport: viewport.name, filename, documentWidth, viewportWidth: viewport.width });
        writePrivateNew(join(directory, `${viewport.name}-${screen}.json`), result.images.at(-1));
        assert.ok(documentWidth <= viewport.width + 1);
      }
      await activePage.setViewportSize({ width: 1440, height: 1000 }); await settle(activePage);
    };
    const mutate = async (name: string, path: string, method: string, validate: (body: Json, bytes: Buffer) => void,
      action: () => Promise<unknown>, extract: (reply: Json) => Partial<CrudOwnedRecords> = () => ({}), status = 200): Promise<Json> => {
      progress(name); assert.equal(armed, undefined); assert.equal(options.mode, "create");
      armed = { path, method, status, validate }; if (status >= 400) expected.set(path, status);
      try {
        progress(`${name}: wait for HTTP status`);
        const [response] = await Promise.all([activePage.waitForResponse(reply => new URL(reply.url()).pathname === path && reply.request().method() === method), action()]);
        const operation = armed.operation; assert.ok(operation); operation.httpStatus = response.status();
        progress(`${name}: observed HTTP ${response.status()}`);
        if (response.status() === 200) progress(`${name}: read committed response`);
        const body = await readCrudMutationBody(response);
        // Save safe response fields immediately, before navigation, screenshots or further reads.
        const created = response.status() === 200 ? extract(body) : {};
        const version = body.version === undefined ? undefined : positiveVersion(body.version);
        const quoteVersion = body.quoteVersion === undefined ? undefined : positiveVersion(body.quoteVersion);
        operation.status = response.status() === 200 ? "COMMITTED" : [400, 401, 403, 404, 409, 415].includes(response.status()) ? "REFUSED" : "UNRESOLVED";
        operation.created = created; operation.version = version; operation.quoteVersion = quoteVersion;
        operation.outcomeFile = `outcome-${String(operation.sequence).padStart(3, "0")}.json`;
        writePrivateNew(join(directory, operation.outcomeFile), { ...operation, at: new Date().toISOString() });
        Object.assign(result.created, created); assert.equal(response.status(), status);
        if (operation.operationId && response.status() === 200) assert.equal(body.operationId, operation.operationId);
        progress(`${name}: verify settled page`); await settle(activePage); return body;
      } catch (failure) {
        if (armed.operation?.status === "INTENT") {
          armed.operation.status = "UNRESOLVED";
          writePrivateNew(join(directory, `unresolved-${String(armed.operation.sequence).padStart(3, "0")}.json`),
            { ...armed.operation, at: new Date().toISOString(), reason: "Outcome not confirmed. Reconcile the recorded operation or request before any retry." });
        }
        throw failure;
      } finally { armed = undefined; expected.delete(path); }
    };
    const click = (name: string) => activePage.getByRole("button", { name, exact: true }).click();
    const field = (name: string) => activePage.getByLabel(name, { exact: true });
    const operationBody = (body: Json) => { assert.match(String(body.operationId), uuid); };
    const versioned = (body: Json) => { operationBody(body); positiveVersion(body.expectedVersion); };
    const attachmentName = `local-crud-${runId}.txt`, attachmentBytes = Buffer.from(`${marker}\nPersistent acceptance attachment.\n`);
    const productName = `${marker} product`, dealName = marker, noteTitle = `${marker} note`, noteContent = `${marker} edited note`;
    const quoteSubject = `${marker} quotation edited`, remarks = `${marker} administrator remarks`;

    await check("Normal authorized login and unchanged single active identity", async () => {
      await visit("/login"); await capture("login");
      await field("Email address").fill(options.account.email); await field("Password").fill(options.account.password);
      const [response] = await Promise.all([activePage.waitForResponse(value => new URL(value.url()).pathname === "/api/auth/login" && value.request().method() === "POST"),
        activePage.getByRole("button", { name: /^(Login|Sign in)$/ }).click()]);
      assert.equal(response.status(), 200); await activePage.waitForURL(url => url.origin === ORIGIN && ["/account", "/dashboard"].includes(url.pathname)); await settle(activePage);
      const me = await read(activePage, "/api/auth/me"), user = object(me.user); assert.equal(user.localUserId, "15");
      assert.ok(Array.isArray(user.permissions)); assert.equal(user.permissions.includes("leads.manage.agents"), false);
      initialPermissions = hash(JSON.stringify([...user.permissions].sort()));
      const users = await read(activePage, "/api/settings/users?page=1&pageSize=100"); const rows = users.items as Json[];
      assert.equal(users.total, 15); assert.equal(rows.length, 15); assert.equal(rows.filter(row => row.status === "active").length, 1);
      assert.equal(rows.find(row => row.status === "active")?.id, "15"); initialUsers = hash(JSON.stringify(users));
      result.accountInvariant = { totalUsers: 15, activeUsers: 1, unchanged: false };
      const caps = await read(activePage, "/api/capabilities"); assert.equal(caps.integrationAvailable, false);
      assert.equal(caps.persistence, "local-demo"); assert.equal(caps.localWorkflow, true); assert.equal(caps.dealCreate, true);
    });
    if (options.mode === "create") {
      await check("Create a uniquely marked persistent local product", async () => {
        await visit("/items/new"); await field("Item Name").fill(productName);
        await field("Description (Optional)").fill(`${marker} product description`);
        await capture("new-product-form");
        await mutate("Create product", "/api/items", "POST", body => { operationBody(body); assert.equal(body.name, productName);
          assert.equal(body.description, `${marker} product description`); }, () => click("Save Item"), reply => {
          assert.equal(reply.persistence, "local-demo"); assert.match(String(reply.productId), productId); return { productId: String(reply.productId) }; });
        const saved = await read(activePage, `/api/items/${result.created.productId}`); assert.equal(saved.name, productName);
        await visit("/items"); await field("Search Items").fill(productName); await field("Search Items").press("Enter"); await settle(activePage);
        await activePage.getByRole("cell", { name: productName, exact: true }).waitFor(); await capture("created-product");
      });
      await check("Create a locally owned deal with no external identifiers", async () => {
        await visit("/deals/new");
        for (const [label, value] of [["First name", "LOCAL CRUD ACCEPTANCE"], ["Last name", runId], ["Company name", marker],
          ["Customer email", `acceptance-${runId}@example.invalid`], ["Mobile", "0500000000"], ["Phone", "040000000"],
          ["P.O. box", "00000"], ["TRN", "000000000000000"], ["Address", `${marker} address`], ["Description", `${marker} description`]])
          await field(label!).fill(value!);
        await activePage.getByRole("combobox", { name: "Company department", exact: true }).selectOption("VOLTRONIX CONTRACTING LLC"); await capture("new-deal-form");
        await mutate("Create local deal", "/api/deals", "POST", body => { operationBody(body); assert.equal(body.firstName, "LOCAL CRUD ACCEPTANCE");
          assert.equal(body.lastName, runId); assert.equal(body.companyName, marker); }, () => click("Save Deal"), reply => {
          assert.equal(reply.persistence, "local-demo"); return { taskId: numericId(reply.taskId) }; });
        const saved = await read(activePage, `/api/leads/${result.created.taskId}`);
        assert.equal(saved.dealName, dealName); assert.equal(saved.persistence, "local-demo"); assert.equal(saved.localOwnerId, "15");
        for (const key of ["externalId", "assignedExternalId", "ownerExternalId"]) assert.equal(saved[key], null);
        assert.equal(saved.status, "Pending"); await visit(`/leads/${result.created.taskId}`); await capture("created-deal");
      });
      await check("Create and edit only this run's local lead note", async () => {
        const path = `/api/leads/${result.created.taskId}`;
        await click("Add Note"); await field("New note title").fill(noteTitle); await field("New note content").fill(`${marker} initial note`);
        await mutate("Create owned note", path + "/notes", "POST", body => { versioned(body); assert.equal(body.title, noteTitle);
          assert.equal(body.content, `${marker} initial note`); }, () => click("Add lead note"), reply => ({ noteId: numericId(reply.noteId) }));
        await visit(`/leads/${result.created.taskId}`); await click(`Edit note: ${noteTitle}`);
        await field("Edit note content").fill(noteContent);
        await mutate("Edit owned note", `${path}/notes/${result.created.noteId}`, "PATCH", body => { versioned(body); assert.equal(body.content, noteContent); }, () => click("Save lead note"));
        await visit(`/leads/${result.created.taskId}`); await activePage.getByRole("region", { name: "Lead notes", exact: true }).getByText(noteContent, { exact: true }).waitFor();
        await capture("edited-note");
      });
      const changeStage = async (stage: string) => {
        await visit(`/leads/${result.created.taskId}`); await activePage.getByRole("button", { name: "Update Status", exact: true }).click();
        await activePage.getByRole("combobox", { name: "Next lead stage", exact: true }).selectOption(stage);
        if (stage === "Closed Won") await field("Service charge (AED)").fill("200.00");
        await mutate(`Set owned lead stage ${stage}`, `/api/leads/${result.created.taskId}/stage`, "PATCH", body => { versioned(body);
          assert.equal(body.stage, stage); if (stage === "Closed Won") assert.equal(body.serviceCharge, "200.00"); }, () => click("Save lead stage"));
        assert.equal((await read(activePage, `/api/leads/${result.created.taskId}`)).status, stage);
      };
      await check("Persist supported Site Visit transition", () => changeStage("Site Visit"));
      await check("Create a zero-discount quotation using this run's product and deal", async () => {
        await visit("/quotations/new"); await field("Find quotation deal").fill(dealName); await settle(activePage);
        await field("Quotation deal").selectOption(result.created.taskId!); await settle(activePage);
        await field("Quotation subject").fill(`${marker} quotation`); await field("Kind attention").fill("Synthetic acceptance customer");
        await field("Find quotation product").fill(productName); await settle(activePage);
        await field("Quotation product").selectOption(result.created.productId!); await click("Add selected product"); await settle(activePage);
        await field("Item 1 description").fill(`${marker} line item`); await field("Item 1 quantity").fill("2");
        await field("Item 1 unit price").fill("100.00"); await field("Item 1 discount (%)").fill("0");
        await capture("new-quotation-form");
        await mutate("Create owned quotation", "/api/quotations", "POST", body => { versioned(body); assert.equal(body.taskId, result.created.taskId);
          const quote = object(body.quotation); assert.equal(quote.subject, `${marker} quotation`);
          const items = quote.items as Json[]; assert.equal(items.length, 1); assert.equal(items[0]?.productId, result.created.productId); assert.equal(items[0]?.itemDiscount, "0");
        }, () => click("Create quotation"), reply => { assert.match(String(reply.quoteId), /^local-[1-9][0-9]{0,18}$/); return { quoteId: String(reply.quoteId) }; });
        assert.equal((await read(activePage, `/api/leads/${result.created.taskId}`)).status, "Proposal/Price Quote");
        await visit(`/quotations/${result.created.taskId}`); await capture("created-quotation");
      });
      await check("Discounted edit is refused atomically; zero-discount edit persists", async () => {
        const path = `/api/quotations/${result.created.taskId}`, saved = await read(activePage, path), before = hash(JSON.stringify(saved));
        writePrivateNew(join(directory, "before-discount-refusal.json"), { at: new Date().toISOString(), taskId: result.created.taskId,
          quoteId: result.created.quoteId, taskVersion: positiveVersion(saved.taskVersion), quoteVersion: positiveVersion(saved.version), responseSha256: before });
        await visit(`/quotations/${result.created.taskId}/edit`); await field("Item 1 discount (%)").fill("10");
        assert.equal(await activePage.getByRole("button", { name: "Save quotation", exact: true }).isDisabled(), true);
        const invalidQuotation = structuredClone(object(saved.quotation)); (invalidQuotation.items as Json[])[0]!.itemDiscount = "10";
        const refusedBody = { operationId: randomUUID(), expectedVersion: positiveVersion(saved.taskVersion),
          expectedQuoteVersion: positiveVersion(saved.version), quotation: invalidQuotation };
        await mutate("Reject discounted owned quotation edit", path, "PATCH", body => { versioned(body); positiveVersion(body.expectedQuoteVersion);
          const items = object(body.quotation).items as Json[]; assert.equal(items[0]?.itemDiscount, "10");
        }, () => boundedBrowserOperation(activePage.evaluate(async ({ path, body }) => {
          const signal = AbortSignal.timeout(15_000);
          const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin", signal });
          const csrf = await challenge.json() as { csrfToken: string };
          const response = await fetch(path, { method: "PATCH", credentials: "same-origin", signal,
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.csrfToken }, body: JSON.stringify(body) });
          return response.status;
        }, { path, body: refusedBody })), undefined, 409);
        assert.equal(hash(JSON.stringify(await read(activePage, path))), before);
        await visit(`/quotations/${result.created.taskId}/edit`); await field("Quotation subject").fill(quoteSubject);
        await field("Item 1 discount (%)").fill("0");
        await capture("edit-quotation-form");
        await mutate("Save zero-discount owned quotation edit", path, "PATCH", body => { versioned(body); positiveVersion(body.expectedQuoteVersion);
          const quote = object(body.quotation); assert.equal(quote.subject, quoteSubject); assert.equal((quote.items as Json[])[0]?.itemDiscount, "0");
        }, () => click("Save quotation"));
        await visit(`/quotations/${result.created.taskId}`); await capture("edited-quotation");
      });
      await check("Close this run's deal as won without remote effects", () => changeStage("Closed Won"));
      await check("Edit remarks and status only on this run's new job", async () => {
        const path = `/api/jobs/${result.created.taskId}`; await visit(`/jobs/${result.created.taskId}`);
        await field("Administrator remarks").fill(remarks);
        await mutate("Save owned job remarks", path + "/remarks", "PATCH", body => { positiveVersion(body.expectedVersion); assert.equal(body.remarks, remarks); }, () => click("Save remarks"));
        for (const status of ["Hold", "Active"]) {
          await visit(`/jobs/${result.created.taskId}`); await field("Job status").selectOption(status);
          await mutate(`Save owned job ${status}`, path + "/status", "PATCH", body => { positiveVersion(body.expectedVersion); assert.equal(body.jobStatus, status); }, () => click("Save job status"));
          assert.equal((await read(activePage, path)).jobStatus, status);
        }
        assert.equal((await read(activePage, path)).remarks, remarks);
      });
      await check("Assign Accounts to the unchanged active owner on this run's job", async () => {
        await visit(`/jobs/${result.created.taskId}`); await field("Accounts user").selectOption("15");
        await mutate("Assign owned job Accounts", `/api/jobs/${result.created.taskId}/accounts`, "POST", body => { positiveVersion(body.expectedVersion); assert.equal(body.userId, "15"); },
          () => click("Assign accounts"), reply => { const accounts = object(reply.accounts); assert.equal(accounts.userId, "15"); return { accountsAssignmentId: numericId(accounts.id) }; });
      });
      await check("Upload a uniquely marked new attachment and verify its bytes", async () => {
        await visit(`/jobs/${result.created.taskId}`); await field("Attachment file").setInputFiles({ name: attachmentName, mimeType: "text/plain", buffer: attachmentBytes });
        await mutate("Upload owned job attachment", `/api/leads/${result.created.taskId}/attachments`, "POST", (_body, bytes) => {
          assert.ok(bytes.includes(Buffer.from(attachmentName)) && bytes.includes(attachmentBytes));
          assert.ok(/name="expectedVersion"\r\n\r\n[1-9][0-9]*\r\n/.test(bytes.toString("utf8")));
        }, () => click("Upload attachment"), reply => { assert.match(String(reply.id), uuid); return { attachmentId: String(reply.id) }; });
        result.attachment = { filename: attachmentName, bytes: attachmentBytes.length, sha256: hash(attachmentBytes) };
        await visit(`/jobs/${result.created.taskId}`); const received = activePage.waitForEvent("download");
        await activePage.getByRole("link", { name: attachmentName, exact: true }).click();
        assert.equal(hash(await downloadBytes(await received)), result.attachment.sha256); await capture("new-job-complete");
      });
    } else result.cases.push({ name: "Business mutations during restart verification", status: "NOT_RUN", reason: "Resume mode only reads the prior successful run's records; all business methods are refused by the browser guard." });

    await check("Fresh reads verify every run-owned record and attachment", async () => {
      const paths = snapshotPaths(result.created);
      for (const path of paths) {
        const body = await read(activePage, path); result.snapshots.push({ path, sha256: hash(JSON.stringify(body)) });
        if (path === `/api/items/${result.created.productId}`) assert.equal(body.name, productName);
        if (path === `/api/leads/${result.created.taskId}`) {
          assert.equal(body.dealName, dealName); assert.equal(body.localOwnerId, "15"); assert.equal(body.persistence, "local-demo"); assert.equal(body.status, "Closed Won");
          for (const key of ["externalId", "assignedExternalId", "ownerExternalId"]) assert.equal(body[key], null);
        }
        if (path === `/api/quotations/${result.created.taskId}`) {
          assert.equal(body.id, result.created.quoteId); assert.equal(body.persistence, "local-demo"); assert.equal(body.localOwnerId, "15");
          assert.equal(body.externalId, null); assert.equal(body.remoteModifiedAt, null); assert.equal(body.subject, quoteSubject);
          const totals = object(body.totals); assert.equal(totals.subtotal, "200.00"); assert.equal(totals.vatAmount, "10.00"); assert.equal(totals.grandTotal, "210.00");
          const quote = object(body.quotation), items = quote.items as Json[]; assert.equal(items.length, 1);
          assert.equal(items[0]?.productId, result.created.productId); assert.ok(/^0(?:\.0+)?$/.test(String(items[0]?.itemDiscount)));
          const task = object(body.task); assert.equal(task.assignedLocalId, "15"); assert.equal(task.assignedExternalId, null);
          assert.equal(task.assignedCompany, "VOLTRONIX CONTRACTING LLC"); assert.equal(task.assignedSaleName, "nishad");
        }
        if (path.endsWith("/notes")) { const note = (body.items as Json[]).find(value => value.id === result.created.noteId); assert.ok(note); assert.equal(note.content, noteContent); assert.equal(note.externalNoteId, null); }
        if (path === `/api/jobs/${result.created.taskId}`) { assert.equal(body.jobStatus, "Active"); assert.equal(body.remarks, remarks); }
        if (path.endsWith("/assignments")) { const accounts = object(body.accounts); assert.equal(accounts.id, result.created.accountsAssignmentId); assert.equal(accounts.userId, "15"); }
      }
      if (prior) assert.deepEqual(result.snapshots, prior.snapshots);
      result.attachment = { filename: attachmentName, bytes: attachmentBytes.length, sha256: hash(attachmentBytes) };
      await visit(`/jobs/${result.created.taskId}`); const received = activePage.waitForEvent("download");
      await activePage.getByRole("link", { name: attachmentName, exact: true }).click(); assert.equal(hash(await downloadBytes(await received)), result.attachment.sha256);
      if (prior) await capture("restart-persisted-job");
    });
    if (options.mode === "resume") await check("Read-only restart screenshots of current forms and persisted records", async () => {
      for (const [screen, path] of [["restart-empty-deal-form", "/deals/new"], ["restart-persisted-lead", `/leads/${result.created.taskId}`],
        ["restart-persisted-quotation", `/quotations/${result.created.taskId}`], ["restart-quotation-edit-form", `/quotations/${result.created.taskId}/edit`]]) {
        await visit(path!); await capture(screen!);
      }
      await visit("/items"); await field("Search Items").fill(productName); await field("Search Items").press("Enter"); await settle(activePage);
      await activePage.getByRole("cell", { name: productName, exact: true }).waitFor(); await capture("restart-persisted-product");
    });
    if (options.mode === "create") await check("Owned-job CSRF and stale-version refusals preserve every accepted record", async () => {
      const path = `/api/jobs/${result.created.taskId}/remarks`, job = await read(activePage, `/api/jobs/${result.created.taskId}`);
      const version = positiveVersion(job.version); assert.ok(version > 1);
      for (const scenario of [{ name: "Missing CSRF is refused", csrf: false, status: 403, expectedVersion: version },
        { name: "Stale version is refused", csrf: true, status: 409, expectedVersion: version - 1 }]) {
        const body = { expectedVersion: scenario.expectedVersion, remarks: `${marker} refused change` };
        await mutate(scenario.name, path, "PATCH", value => { assert.equal(value.expectedVersion, scenario.expectedVersion);
          assert.equal(value.remarks, body.remarks); }, () => boundedBrowserOperation(activePage.evaluate(async input => {
          const signal = AbortSignal.timeout(15_000), headers: Record<string, string> = { "Content-Type": "application/json" };
          if (input.csrf) {
            const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin", signal });
            const value = await challenge.json() as { csrfToken: string }; headers["X-CSRF-Token"] = value.csrfToken;
          }
          const response = await fetch(input.path, { method: "PATCH", credentials: "same-origin", signal, headers, body: JSON.stringify(input.body) });
          return response.status;
        }, { path, body, csrf: scenario.csrf })), undefined, scenario.status);
        for (const snapshot of result.snapshots) assert.equal(hash(JSON.stringify(await read(activePage, snapshot.path))), snapshot.sha256);
      }
    });
    await check("Read-only downloads of both preexisting authorized PDF templates", async () => {
      for (const [template, taskId] of Object.entries(options.existingPdfTaskIds)) {
        await visit(`/quotations/${taskId}`); const received = activePage.waitForEvent("download");
        await activePage.getByRole("link", { name: "Download quotation PDF", exact: true }).click();
        const bytes = await downloadBytes(await received); assert.equal(bytes.subarray(0, 5).toString(), "%PDF-"); assert.ok(bytes.length > 1000);
        const filename = `existing-${template}.pdf`; privateBytes(directory, filename, bytes);
        result.artifacts.push({ kind: "pdf", template, filename, bytes: bytes.length, sha256: hash(bytes) }); bytes.fill(0);
      }
    });
    await check("Download the new local quotation PDF with approved issuer details", async () => {
      const caps = await read(activePage, `/api/quotations/${result.created.taskId}/capabilities`);
      assert.equal(caps.integrationAvailable, false); assert.equal(caps.pdfAvailable, true);
      await visit(`/quotations/${result.created.taskId}`); const received = activePage.waitForEvent("download");
      await activePage.getByRole("link", { name: "Download quotation PDF", exact: true }).click();
      const bytes = await downloadBytes(await received); assert.equal(bytes.subarray(0, 5).toString(), "%PDF-"); assert.ok(bytes.length > 1000);
      const filename = "new-local-contracting-quotation.pdf"; privateBytes(directory, filename, bytes);
      result.artifacts.push({ kind: "pdf", template: "new-local-contracting", filename, bytes: bytes.length, sha256: hash(bytes) }); bytes.fill(0);
    });
    await check("Accounts and grants stay unchanged", async () => {
      assert.equal(hash(JSON.stringify(await read(activePage, "/api/settings/users?page=1&pageSize=100"))), initialUsers);
      const user = object((await read(activePage, "/api/auth/me")).user); assert.equal(user.localUserId, "15");
      assert.equal(hash(JSON.stringify([...(user.permissions as string[])].sort())), initialPermissions);
      result.accountInvariant!.unchanged = true;
      result.cases.push({ name: "Department worker assignments and work logs", status: "BLOCKED", reason: "The unchanged current account has no department worker role. No account/role/grant or worker assignment is altered." });
      result.cases.push({ name: "Unsupported record deletion and product update", status: "NOT_RUN", reason: "These endpoints are unavailable. Acceptance records and history remain persistent; no existing record is deleted." });
    });
    healthy(); result.status = "PASS";
  } catch (failure) {
    result.cases.push({ name: currentCase, status: "FAIL", failure: safeBrowserFailure(failure, step) });
  } finally {
    if (ownSession && page) {
      try {
        progress("Clean up only this browser's normal session"); expected.set("/api/auth/me", 401);
        const reply = await boundedBrowserOperation(page.evaluate(async () => {
          const signal = AbortSignal.timeout(10_000);
          const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin", signal });
          const value = await challenge.json() as { csrfToken: string };
          const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", signal, headers: { "X-CSRF-Token": value.csrfToken } });
          const me = await fetch("/api/auth/me", { credentials: "same-origin", signal }); return { logout: response.status, me: me.status };
        }), 15_000);
        assert.equal(reply.logout, 200); assert.equal(reply.me, 401); ownSession = false; result.ownSessionCleanup = "PASS";
      } catch (failure) { result.status = "FAIL"; result.ownSessionCleanup = "FAIL";
        result.cases.push({ name: "Own-session cleanup", status: "FAIL", failure: safeBrowserFailure(failure, "Bounded normal logout") }); }
    }
    for (const [name, close] of [["Browser context", () => context?.close()], ["Browser process", () => browser?.close()]] as const) {
      try { await boundedBrowserOperation(Promise.resolve(close()), 10_000); }
      catch (failure) { result.status = "FAIL"; result.cases.push({ name: `${name} cleanup`, status: "FAIL", failure: safeBrowserFailure(failure, "Bounded browser cleanup") }); }
    }
    if (result.observations.blockedRequests || result.observations.unexpectedHttpErrors || result.observations.unexpectedConsoleErrors
      || result.observations.pageErrors || result.observations.unexpectedRequestFailures) result.status = "FAIL";
    for (const entry of result.cases) result.counts[entry.status === "PASS" ? "pass" : entry.status === "FAIL" ? "fail" : entry.status === "BLOCKED" ? "blocked" : "notRun"]++;
    result.finishedAt = new Date().toISOString(); writePrivateNew(result.receipt, result);
  }
  return result;
}
