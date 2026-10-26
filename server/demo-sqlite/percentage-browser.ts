import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { privateAccess } from "../scripts/mysql-auth/files.js";
import { boundedBrowserOperation } from "./current-user-browser.js";
import { acknowledgement, backendRoot, dataRoot, demoConfiguration, openDemo, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";
import { captureChildEnvironment, settleCapturePage } from "./ui-capture.js";

const origin = "http://127.0.0.1:3001";
const approval = "--account-owner-local-percentage-20261013";
const readbackApproval = "--read-only-owner-percentage-20261013";
type Json = Record<string, unknown>;
const object = (value: unknown): Json => { assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value as Json; };
const digest = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
type Snapshot = { tables: Record<string, { count: number; rows: Record<string, string> }>; ownerSessions: string; rows: number };

function snapshot(): Snapshot {
  const db = openDemo(true);
  try {
    return db.transaction(() => {
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(db.pragma("foreign_key_check"), []);
      const tables: Snapshot["tables"] = {}; let rows = 0;
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]) {
        assert.match(name, /^[a-z_]+$/i);
        const keys = (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string; pk: number }[]).filter(column => column.pk).map(column => column.name);
        const records = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Json[];
        tables[name] = { count: records.length, rows: Object.fromEntries(records.map(row => [digest(keys.length ? keys.map(key => row[key]) : row.name), digest(row)])) };
        rows += records.length;
      }
      return { tables, rows, ownerSessions: digest(db.prepare("SELECT * FROM crm_sessions WHERE user_id=15 ORDER BY token_hash").all()) };
    })();
  } finally { db.close(); }
}

export function allowedPercentageMutation(taskId: string | undefined, path: string, method: string): boolean {
  if (method === "POST" && path === "/api/deals") return taskId === undefined;
  if (!taskId || !/^[1-9][0-9]{0,18}$/.test(taskId)) return false;
  return method === "PATCH" && [ `/api/leads/${taskId}/stage`, `/api/quotations/${taskId}` ].includes(path)
    || method === "POST" && path === "/api/quotations";
}

export function allowedPercentageReadbackRequest(value: string, method: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.hash || /%|\\/.test(url.pathname)) return false;
    return ["GET", "HEAD"].includes(method) || method === "POST" && !url.search && ["/api/auth/login", "/api/auth/logout"].includes(url.pathname);
  } catch { return false; }
}

async function read(page: Page, path: string): Promise<Json> {
  assert.match(path, /^\/api\/[a-zA-Z0-9/_?=&.-]+$/);
  return boundedBrowserOperation(page.evaluate(async target => {
    const response = await fetch(target, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) throw new Error("Expected authenticated read");
    return await response.json() as Record<string, unknown>;
  }, path));
}

async function resetCaptureScroll(page: Page) {
  await page.evaluate(async () => {
    document.documentElement.style.scrollBehavior = "auto"; document.body.style.scrollBehavior = "auto";
    (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  await page.waitForFunction(() => window.scrollY === 0 && window.scrollX === 0);
}

/** Reads only an already-created quote; never repeats acceptance mutations. */
export async function runPercentageReadback(priorName: string) {
  demoConfiguration(process.env); assert.match(priorName, /^percentage-browser-[a-f0-9-]{36}$/);
  const prior = object(readPrivate(join(dataRoot, "evidence", priorName, "receipt.json")));
  assert.equal(prior.actorId, "15"); assert.match(String(prior.taskId), /^[1-9][0-9]*$/);
  const priorChecks = prior.checks as { name: string; status: string }[];
  assert.ok(priorChecks.some(check => check.name === "Percentage quotation edit persists with fresh versions" && check.status === "PASS"));
  assert.ok(priorChecks.filter(check => check.status === "FAIL").every(check => check.name === "Existing records, passwords, grants, files and owner session preserved"));
  const saved = object(readPrivate(join(dataRoot, "evidence", priorName, "saved-quotation.json")));
  const savedPdf = object(readPrivate(join(dataRoot, "evidence", priorName, "pdf.json")));
  const handoff = object(readPrivate(join(dataRoot, "browser-login-20261012-8ffdfce6.json"))); assert.equal(String(handoff.accountId), "15");
  const directory = privateDirectory(["evidence", "percentage-readback-" + randomUUID()], true);
  const before = snapshot();
  const result = { status: "FAIL", kind: "read-only-percentage-readback", directory, priorReceipt: priorName, taskId: String(prior.taskId),
    startedAt: new Date().toISOString(), finishedAt: "", checks: [] as { name: string; status: string }[],
    images: [] as { filename: string; width: number; documentWidth: number }[], businessWrites: 0,
    blockedRequests: 0, logins: 0, logouts: 0, before, after: undefined as Snapshot | undefined, failure: undefined as string | undefined };
  const browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string> });
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(20_000); const page = await context.newPage(); let signedIn = false;
  await context.route("**/*", route => {
    const request = route.request();
    if (allowedPercentageReadbackRequest(request.url(), request.method())) return route.continue();
    result.blockedRequests++; return route.abort("blockedbyclient");
  });
  try {
    await page.goto(origin + "/login"); await page.getByLabel("Email address", { exact: true }).fill(String(handoff.email));
    await page.getByLabel("Password", { exact: true }).fill(String(handoff.password)); result.logins++;
    const [response] = await Promise.all([page.waitForResponse(value => new URL(value.url()).pathname === "/api/auth/login" && value.request().method() === "POST"), page.getByRole("button", { name: /^(Login|Sign in)$/ }).click()]);
    assert.equal(response.status(), 200); signedIn = true; await page.waitForURL(url => url.origin === origin && ["/account", "/dashboard"].includes(url.pathname));
    assert.equal(object((await read(page, "/api/auth/me")).user).localUserId, "15");
    result.checks.push({ name: "Normal unchanged-credential owner login", status: "PASS" });
    assert.equal(digest(await read(page, `/api/quotations/${result.taskId}`)), digest(saved));
    const pdf = await context.request.get(origin + `/api/quotations/${result.taskId}/pdf`, { maxRedirects: 0 }); assert.equal(pdf.status(), 200);
    // PDF generators may vary document IDs; verify financial content rather than binary metadata.
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: new Uint8Array(await pdf.body()), useSystemFonts: false });
    try { const document = await loading.promise; const text = (await (await document.getPage(1)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ");
      assert.ok(text.includes("159.60") && text.includes("Discount (5%)") && text.includes("20%")); assert.equal(savedPdf.taskId, result.taskId);
    } finally { await loading.destroy(); }
    result.checks.push({ name: "Saved percentage quote and PDF financial values survive restart", status: "PASS" });
    for (const [name, path] of [["users", "/settings/users"], ["quotation-edit", `/quotations/${result.taskId}/edit`]]) {
      assert.equal((await page.goto(origin + path!, { waitUntil: "domcontentloaded" }))?.status(), 200); await settleCapturePage(page);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: width === 1440 ? 1000 : 1024 }); await settleCapturePage(page); await resetCaptureScroll(page);
        const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth); assert.ok(documentWidth <= width + 1);
        if (name === "users" && width === 1440) assert.equal(await page.locator(".crm-settings-list").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
        const filename = `${name}-${width}.png`; await page.screenshot({ path: join(directory, filename), fullPage: true, animations: "disabled" }); privateAccess(join(directory, filename), false);
        result.images.push({ filename, width, documentWidth });
      }
    }
    result.checks.push({ name: "Corrected Users columns and edit capture at desktop tablet phone", status: "PASS" });
    assert.equal(result.blockedRequests, 0); result.status = "PASS";
  } catch (error) {
    result.failure = error instanceof Error ? error.message.replaceAll(String(handoff.email), "[redacted-email]").replaceAll(String(handoff.password), "[redacted-password]").slice(0, 1600) : "Readback failure";
    result.checks.push({ name: "Read-only browser verification", status: "FAIL" });
  } finally {
    if (signedIn) { try { await page.goto(origin + "/account"); await page.getByRole("button", { name: "User menu", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(origin + "/login"); result.logouts++;
    } catch { result.status = "FAIL"; } }
    await context.close(); await browser.close(); result.after = snapshot();
    const unchanged = Object.entries(before.tables).every(([name, table]) => name === "crm_login_attempts" || digest(table) === digest(result.after!.tables[name]))
      && before.ownerSessions === result.after.ownerSessions;
    result.checks.push({ name: "Zero business writes and exact records accounts grants owner-session preservation", status: unchanged ? "PASS" : "FAIL" });
    if (!unchanged || result.logins !== result.logouts) result.status = "FAIL";
    result.finishedAt = new Date().toISOString(); writePrivateNew(join(directory, "receipt.json"), result);
  }
  return result;
}

export async function runPercentageBrowser() {
  demoConfiguration(process.env);
  const handoff = object(readPrivate(join(dataRoot, "browser-login-20261012-8ffdfce6.json")));
  assert.equal(String(handoff.accountId), "15");
  assert.equal(typeof handoff.email, "string"); assert.equal(typeof handoff.password, "string");
  const runId = randomUUID(), marker = `LOCAL PERCENTAGE ACCEPTANCE ${runId}`;
  const directory = privateDirectory(["evidence", "percentage-browser-" + runId], true);
  const result = { status: "FAIL", approval: "Account Owner conversation 2026-10-13: local migration and percentage-only verification",
    runId, marker, actorId: "15", startedAt: new Date().toISOString(), finishedAt: "", directory,
    taskId: undefined as string | undefined, quoteId: undefined as string | undefined,
    checks: [] as { name: string; status: "PASS" | "FAIL" }[],
    operations: [] as { method: string; path: string; requestSha256: string; operationId: unknown; expectedVersion: unknown; at: string; httpStatus?: number }[],
    images: [] as { file: string; width: number; documentWidth: number }[],
    before: snapshot(), after: undefined as Snapshot | undefined,
    observations: { loginAttempts: 0, logouts: 0, blockedRequests: 0, pageErrors: 0 }, failure: undefined as string | undefined,
    preservation: { existingRows: false, ownerSession: false },
  };
  writePrivateNew(join(directory, "before.json"), result.before);
  let stage = "Launch", signedIn = false, context: BrowserContext | undefined, page: Page | undefined;
  let armed: { path: string; method: string; validate: (body: Json) => void; consumed: boolean } | undefined;
  const browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string>,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"] });
  const check = async (name: string, work: () => Promise<void>) => {
    stage = name; await work(); result.checks.push({ name, status: "PASS" });
  };
  try {
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(25_000);
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== origin || url.username || url.password || /%|\\/.test(url.pathname)) {
        result.observations.blockedRequests++; return route.abort("blockedbyclient");
      }
      if (["GET", "HEAD"].includes(method) || method === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(url.pathname)) return route.continue();
      if (!armed || armed.consumed || armed.path !== url.pathname || armed.method !== method || url.search
        || !allowedPercentageMutation(result.taskId, url.pathname, method)) {
        result.observations.blockedRequests++; return route.abort("blockedbyclient");
      }
      try {
        const payload = object(request.postDataJSON()); armed.validate(payload); armed.consumed = true;
        const operation = { method, path: url.pathname, requestSha256: digest(payload), operationId: payload.operationId,
          expectedVersion: payload.expectedVersion, at: new Date().toISOString() };
        result.operations.push(operation);
        writePrivateNew(join(directory, `intent-${result.operations.length}.json`), { ...operation, payload });
        return route.continue();
      } catch { result.observations.blockedRequests++; return route.abort("blockedbyclient"); }
    });
    page = await context.newPage(); const activePage = page;
    page.on("pageerror", () => { result.observations.pageErrors++; });
    const visit = async (path: string) => { assert.equal((await activePage.goto(origin + path, { waitUntil: "domcontentloaded" }))?.status(), 200); await settleCapturePage(activePage); };
    const capture = async (name: string) => {
      for (const width of [1440, 768, 390]) {
        await activePage.setViewportSize({ width, height: width === 1440 ? 1000 : 1024 }); await settleCapturePage(activePage);
        await resetCaptureScroll(activePage);
        const documentWidth = await activePage.evaluate(() => document.documentElement.scrollWidth);
        const file = `${name}-${width}.png`;
        await activePage.screenshot({ path: join(directory, file), fullPage: true, animations: "disabled" }); privateAccess(join(directory, file), false);
        result.images.push({ file, width, documentWidth }); assert.ok(documentWidth <= width + 1, name + " viewport overflow");
      }
      await activePage.setViewportSize({ width: 1440, height: 1000 });
    };
    const mutate = async (path: string, method: string, validate: (body: Json) => void, action: () => Promise<unknown>, expected = 200) => {
      assert.equal(armed, undefined); armed = { path, method, validate, consumed: false };
      try {
        const [response] = await Promise.all([activePage.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method), action()]);
        assert.equal(armed.consumed, true); result.operations.at(-1)!.httpStatus = response.status();
        writePrivateNew(join(directory, `outcome-${result.operations.length}.json`), result.operations.at(-1));
        assert.equal(response.status(), expected);
        return response.status() === 200 ? object(await boundedBrowserOperation(response.json())) : {};
      } finally { armed = undefined; }
    };
    const versioned = (body: Json) => { assert.match(String(body.operationId), /^[a-f0-9-]{36}$/); assert.ok(Number.isSafeInteger(body.expectedVersion) && Number(body.expectedVersion) > 0); };
    await check("Normal owner login and current effective permissions", async () => {
      await visit("/login"); await activePage.getByLabel("Email address", { exact: true }).fill(handoff.email as string);
      await activePage.getByLabel("Password", { exact: true }).fill(handoff.password as string); result.observations.loginAttempts++;
      const [response] = await Promise.all([activePage.waitForResponse(value => new URL(value.url()).pathname === "/api/auth/login" && value.request().method() === "POST"),
        activePage.getByRole("button", { name: /^(Login|Sign in)$/ }).click()]);
      assert.equal(response.status(), 200); signedIn = true; await activePage.waitForURL(url => url.origin === origin && ["/account", "/dashboard"].includes(url.pathname));
      const user = object((await read(activePage, "/api/auth/me")).user); assert.equal(user.localUserId, "15");
      const permissions = user.permissions as string[]; assert.ok(permissions.includes("deals.manage"));
      assert.ok(permissions.some(key => ["leads.manage", "leads.manage.agents"].includes(key)));
      assert.equal((await read(activePage, "/api/capabilities")).persistence, "local-demo");
    });
    await check("Authenticated Users and Assign Permissions source layout at three widths", async () => {
      await visit("/settings/users"); await activePage.getByRole("heading", { name: "Admin Users", exact: true }).waitFor(); await capture("users");
      await visit("/settings/permissions/assign"); await activePage.getByLabel("Admin user", { exact: true }).selectOption("5");
      await activePage.getByRole("button", { name: "Load", exact: true }).click();
      await activePage.getByRole("button", { name: "Save", exact: true }).waitFor(); await capture("permissions-user5");
    });
    await check("Create one marked local acceptance deal through the original form", async () => {
      await visit("/deals/new");
      for (const [label, value] of [["First name", "LOCAL PERCENTAGE ACCEPTANCE"], ["Last name", runId], ["Company name", marker],
        ["Customer email", `percentage-${runId}@example.invalid`], ["Mobile", "0500000000"], ["Phone", "040000000"],
        ["Description", `${marker}; retained local verification record`]]) await activePage.getByLabel(label!, { exact: true }).fill(value!);
      await activePage.getByRole("combobox", { name: "Company department", exact: true }).selectOption("VOLTRONIX CONTRACTING LLC");
      const reply = await mutate("/api/deals", "POST", body => { assert.equal(body.companyName, marker); assert.equal(body.lastName, runId); },
        () => activePage.getByRole("button", { name: "Save Deal", exact: true }).click());
      assert.match(String(reply.taskId), /^[1-9][0-9]*$/); result.taskId = String(reply.taskId);
      writePrivateNew(join(directory, "owned-record.json"), { taskId: result.taskId, actorId: "15", marker });
    });
    await check("Eligible Site Visit transition on the new deal only", async () => {
      await visit(`/leads/${result.taskId}`); await activePage.getByRole("button", { name: "Update Status", exact: true }).click();
      await activePage.getByRole("combobox", { name: "Next lead stage", exact: true }).selectOption("Site Visit");
      await mutate(`/api/leads/${result.taskId}/stage`, "PATCH", body => { versioned(body); assert.equal(body.stage, "Site Visit"); },
        () => activePage.getByRole("button", { name: "Save lead stage", exact: true }).click());
      assert.equal((await read(activePage, `/api/leads/${result.taskId}`)).status, "Site Visit");
    });
    await check("Percentage line and header quotation create through original proposal form", async () => {
      const products = (await read(activePage, "/api/items?page=1&pageSize=25")).items as Json[]; assert.ok(products.length);
      const product = products[0]!;
      await visit(`/quotations/new?taskId=${result.taskId}`);
      await activePage.getByLabel("Subject", { exact: false }).fill(`${marker} quotation`);
      await activePage.getByRole("button", { name: "Item 1 product", exact: true }).click();
      await activePage.getByRole("combobox", { name: "Item 1 product search", exact: true }).fill(String(product.name));
      await activePage.getByRole("option", { name: `${String(product.name)} (${String(product.externalId)})`, exact: true }).click();
      await activePage.getByLabel("Item 1 description", { exact: true }).fill(`${marker} line`);
      await activePage.getByLabel("Item 1 quantity", { exact: true }).fill("2");
      await activePage.getByLabel("Item 1 price", { exact: true }).fill("100");
      await activePage.getByLabel("Item 1 discount percent", { exact: true }).fill("10");
      await activePage.getByLabel("Discount (%)", { exact: true }).fill("10");
      await capture("quotation-create");
      const saved = await mutate("/api/quotations", "POST", body => { versioned(body); assert.equal(body.taskId, result.taskId);
        const quote = object(body.quotation); assert.equal(quote.discountType, "percentage"); assert.equal(quote.discount, "10");
        assert.equal((quote.items as Json[])[0]!.itemDiscount, "10"); }, () => activePage.getByRole("button", { name: "Save Proposal", exact: true }).click());
      result.quoteId = String(saved.quoteId);
      const quote = await read(activePage, `/api/quotations/${result.taskId}`);
      assert.equal(quote.calculationPolicy, "percentage-only-v2");
      assert.equal(object(quote.totals).subtotal, "180.00"); assert.equal(object(quote.totals).grandTotal, "170.10");
    });
    await check("Percentage quotation edit persists with fresh versions", async () => {
      await visit(`/quotations/${result.taskId}/edit`);
      await activePage.getByLabel("Item 1 discount (%)", { exact: true }).fill("20");
      await activePage.getByLabel("Discount (%)", { exact: true }).fill("5");
      await capture("quotation-edit");
      await mutate(`/api/quotations/${result.taskId}`, "PATCH", body => { versioned(body); assert.ok(Number(body.expectedQuoteVersion) > 0);
        const quote = object(body.quotation); assert.equal(quote.discountType, "percentage"); assert.equal(quote.discount, "5"); },
        () => activePage.getByRole("button", { name: "Save quotation", exact: true }).click());
      const saved = await read(activePage, `/api/quotations/${result.taskId}`);
      assert.equal(saved.calculationPolicy, "percentage-only-v2"); assert.equal(object(saved.totals).subtotal, "160.00");
      assert.equal(object(saved.totals).headerDiscount, "8"); assert.equal(object(saved.totals).grandTotal, "159.60");
      writePrivateNew(join(directory, "saved-quotation.json"), saved);
    });
    await check("Fixed discount, bounds, stale version and missing CSRF refuse atomically", async () => {
      const path = `/api/quotations/${result.taskId}`, before = await read(activePage, path), quote = object(before.quotation);
      for (const test of ["fixed", "range", "stale", "csrf"] as const) {
        const payload = { operationId: randomUUID(), expectedVersion: test === "stale" ? Number(before.taskVersion) - 1 : before.taskVersion,
          expectedQuoteVersion: before.version, quotation: { ...quote, ...(test === "fixed" ? { discountType: "fixed" } : {}), ...(test === "range" ? { discount: "101" } : {}) } };
        await mutate(path, "PATCH", body => { assert.equal(body.operationId, payload.operationId); assert.equal(digest(body), digest(payload)); },
          () => boundedBrowserOperation(activePage.evaluate(async input => {
            const challenge = await fetch("/api/auth/csrf", { credentials: "same-origin" }); const csrf = await challenge.json() as { csrfToken: string };
            const response = await fetch(input.path, { method: "PATCH", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(15_000),
              headers: { "Content-Type": "application/json", ...(input.csrf ? { "X-CSRF-Token": csrf.csrfToken } : {}) }, body: JSON.stringify(input.payload) });
            return response.status;
          }, { path, payload, csrf: test !== "csrf" })), test === "csrf" ? 403 : test === "stale" ? 409 : 400);
        assert.equal(digest(await read(activePage, path)), digest(before));
      }
    });
    await check("Persisted quote, authorized PDF and responsive source navigation", async () => {
      await visit(`/quotations/${result.taskId}`); await capture("quotation-detail");
      const pdf = await context!.request.get(origin + `/api/quotations/${result.taskId}/pdf`, { maxRedirects: 0 });
      assert.equal(pdf.status(), 200); const bytes = await pdf.body(); assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      const filename = join(directory, "percentage-quotation.pdf"); writeFileSync(filename, bytes, { flag: "wx" }); privateAccess(filename, false);
      writePrivateNew(join(directory, "pdf.json"), { taskId: result.taskId, bytes: bytes.length, sha256: digest(bytes) });
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
      try {
        const document = await loading.promise, first = await document.getPage(1);
        const text = (await first.getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ");
        assert.ok(text.includes("159.60")); assert.ok(text.includes("Discount (5%)")); assert.ok(text.includes("20%"));
        const viewport = first.getViewport({ scale: 1.5 });
        const surface = (document.canvasFactory as { create(width: number, height: number): {
          canvas: HTMLCanvasElement & { toBuffer(type: "image/png"): Buffer }; context: CanvasRenderingContext2D;
        } }).create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await first.render({ canvas: surface.canvas, canvasContext: surface.context, viewport }).promise;
        const imageFile = join(directory, "percentage-quotation-page-1.png");
        writeFileSync(imageFile, surface.canvas.toBuffer("image/png"), { flag: "wx" }); privateAccess(imageFile, false);
      } finally { await loading.destroy(); }
      await activePage.setViewportSize({ width: 390, height: 844 }); await activePage.getByRole("button", { name: "Open navigation", exact: true }).click();
      await activePage.getByRole("button", { name: "Close navigation", exact: true }).click();
      assert.equal(result.observations.pageErrors, 0); assert.equal(result.observations.blockedRequests, 0);
    });
    result.status = "PASS";
  } catch (error) {
    result.failure = error instanceof Error ? error.message.replaceAll(String(handoff.email), "[redacted-email]").replaceAll(String(handoff.password), "[redacted-password]").slice(0, 2400) : "Unknown browser failure";
    if (page) { try { const filename = join(directory, "failed-stage.png"); await page.screenshot({ path: filename, fullPage: true }); privateAccess(filename, false); } catch { /* Preserve the receipt even if capture is unavailable. */ } }
    result.checks.push({ name: stage, status: "FAIL" });
  } finally {
    if (signedIn && page) {
      try {
        await page.goto(origin + "/account", { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "User menu", exact: true }).click();
        await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(origin + "/login");
        result.observations.logouts++; result.checks.push({ name: "Normal owned test-session logout", status: "PASS" });
      } catch { result.status = "FAIL"; result.checks.push({ name: "Normal owned test-session logout", status: "FAIL" }); }
    }
    await context?.close(); await browser.close(); result.after = snapshot();
    // The normal Site Visit transition appends tasks_status_log for the new task.
    // Existing rows in this and every other business table must still match.
    const append = new Set(["tasks", "tasks_status_log", "crm_demo_local_tasks", "crm_demo_local_operations", "crm_demo_local_audit", "crm_demo_percentage_quotations"]);
    result.preservation.existingRows = Object.entries(result.before.tables).every(([table, before]) => {
      const after = result.after!.tables[table]; if (!after) return false;
      if (["crm_login_attempts", "sqlite_sequence"].includes(table)) return true;
      return Object.entries(before.rows).every(([key, hash]) => after.rows[key] === hash) && (append.has(table) || before.count === after.count);
    });
    result.preservation.ownerSession = result.before.ownerSessions === result.after.ownerSessions;
    if (!result.preservation.existingRows || !result.preservation.ownerSession) result.status = "FAIL";
    result.checks.push({ name: "Existing records, passwords, grants, files and owner session preserved", status: result.preservation.existingRows && result.preservation.ownerSession ? "PASS" : "FAIL" });
    result.finishedAt = new Date().toISOString(); writePrivateNew(join(directory, "receipt.json"), result);
  }
  return result;
}

const currentFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === currentFile) {
  const readOnly = process.argv.length === 4 && process.argv[2] === readbackApproval && /^percentage-browser-[a-f0-9-]{36}$/.test(process.argv[3] ?? "");
  if (!readOnly && (process.argv.length !== 3 || process.argv[2] !== approval)) { console.error("Explicit recorded local acceptance scope required."); process.exitCode = 1; }
  else if (process.env.CRM_SQLITE_DEMO !== acknowledgement) {
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href, currentFile, ...process.argv.slice(2)],
      { cwd: backendRoot, env: captureChildEnvironment(), windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise<number>(done => { child.once("error", () => done(1)); child.once("exit", code => done(code ?? 1)); });
  } else if (readOnly) {
    try { const result = await runPercentageReadback(process.argv[3]!); console.log(JSON.stringify({ status: result.status, receipt: join(result.directory, "receipt.json"), checks: result.checks, images: result.images.length, businessWrites: result.businessWrites })); process.exitCode = result.status === "PASS" ? 0 : 1; }
    catch { console.error("Read-only local acceptance preflight failed."); process.exitCode = 1; }
  } else {
    try { const result = await runPercentageBrowser(); console.log(JSON.stringify({ status: result.status, receipt: join(result.directory, "receipt.json"),
      passed: result.checks.filter(check => check.status === "PASS").length, failed: result.checks.filter(check => check.status === "FAIL").length,
      operations: result.operations.length, taskId: result.taskId, images: result.images.length, observations: result.observations, preservation: result.preservation })); process.exitCode = result.status === "PASS" ? 0 : 1; }
    catch { console.error("Local acceptance preflight failed; no credential details emitted."); process.exitCode = 1; }
  }
}
