import { assertSqliteReferenceBuild } from "./sqlite-reference-http-guard";
assertSqliteReferenceBuild();
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
import { createAuthService } from "../tests/sqlite-reference/auth/service";
import { createCommercialService } from "../tests/sqlite-reference/commercial/service";
import type { CommercialRequest, CommercialTransport } from "../tests/sqlite-reference/commercial/transport";
import type { CommercialPage, ProductRecord, QuotationDetail, QuotationSummary } from "../tests/sqlite-reference/commercial/persistence-contracts";
import type { QuotationInput } from "../tests/sqlite-reference/commercial/quotations";

let currentCheck = "isolated commercial fixture setup";
async function main() {
  const root = realpathSync(process.cwd()), testRoot = localDirectory(root, [".local-data", "test"], true);
  const directory = mkdtempSync(join(testRoot, "commercial-http-")), databasePath = relative(root, join(directory, "crm.sqlite"));
  let db: SqliteDatabase | undefined, child: ChildProcess | undefined, exited: Promise<unknown> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const password = randomBytes(24).toString("base64url"), passwordHash = hashSync(password, 4);
  const hostile = "<script>globalThis.__commercialXss=1</script>";
  try {
    db = openDatabase(parseDatabaseConfig({ DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath }, root), { create: true }); migrateDatabase(db);
    for (let id = 1; id <= 4; id++) db.prepare("INSERT INTO users(id,user_id,username,email,password,company,sale_name) VALUES(?,?,?,?,?,?,?)")
      .run(id, `90000000000000${id}`, `Synthetic commercial user ${id}`, `commercial-${id}@example.test`, passwordHash,
        id === 2 ? "VOLTRONIX SWITCHGEAR LLC" : "VOLTRONIX CONTRACTING LLC", `Fixture salesperson ${id}`);
    function grant(user: number, key: string) {
      db!.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
      db!.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(user, key);
    }
    for (const key of ["leads.manage.agents", "leads.view", "items.write", "items.view"]) grant(1, key);
    grant(2, "leads.manage.agents"); grant(3, "leads.view"); grant(3, "items.view");
    for (let id = 1; id <= 4; id++) db.prepare("INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status,account_name,deal_number) VALUES(?,?,?,?,?,?,?)")
      .run(id, `70000000000000${id}`, id === 2 ? "900000000000002" : "900000000000001", `Synthetic quotation deal ${id}`, "Site Visit", `Synthetic customer ${id}`, `SYN-${id}`);
    let productIndex = 100, quoteIndex = 300;
    const requests: CommercialRequest[] = [];
    const success = (id: string) => ({ status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } });
    // This port is injected into setup services only; the spawned app receives no transport.
    const transport: CommercialTransport = { async request(request) {
      requests.push(request);
      if (request.path === "/Products" && request.method === "POST") return success(String(++productIndex));
      if (request.path.startsWith("/Contacts/search")) return { status: 200, body: { data: [{ id: "201", Last_Name: "Synthetic contact" }] } };
      if (request.path === "/Quotes" && request.method === "POST") return success(String(++quoteIndex));
      if (/^\/Quotes\/\d+$/.test(request.path)) { const id = request.path.split("/").at(-1)!; return { status: 200, body: { data: [{ id, Quote_No: `SYN-Q-${id}`, Modified_Time: "2026-10-10T12:00:00+04:00" }] } }; }
      if (request.path === "/Deals" && request.method === "PUT") return success((request.body as { data: { id: string }[] }).data[0]!.id);
      throw new Error("Unexpected isolated fixture contract request.");
    } };
    const auth = createAuthService(db), service = createCommercialService(db, { transport });
    const ownerToken = (await auth.login("commercial-1@example.test", password, "fixture")).sessionToken;
    const otherToken = (await auth.login("commercial-2@example.test", password, "fixture")).sessionToken;
    const product = await service.createProduct(ownerToken, { operationId: randomUUID(), name: "Synthetic product 100%_", description: hostile });
    const quotation = (discount = "0"): QuotationInput => ({ subject: "Synthetic commercial quotation", kindAttention: "Synthetic contact", discount: "0", adjustment: "0",
      project: null, termsOfPayment: "Synthetic terms only", specification: null, generalExclusion: null, brand: null, warranty: null, delivery: null, notes: hostile, validUntil: null,
      items: [{ productId: product.productId!, productName: "Synthetic product 100%_", description: "Synthetic line description", quantity: "2", unitPrice: "100", itemDiscount: discount, uom: "NOS" }] });
    for (const taskId of ["1", "2", "3"]) await service.createQuotation(taskId === "2" ? otherToken : ownerToken, taskId,
      { operationId: randomUUID(), expectedVersion: 1, quotation: quotation(taskId === "3" ? "10" : "0") });
    assert.equal(requests.length, 13);
    const beforeOperations = (db.prepare("SELECT COUNT(*) n FROM crm_commercial_operations").get() as { n: number }).n;
    const beforeQuotes = db.prepare("SELECT * FROM crm_quotations ORDER BY id").all();
    const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const address = listener.address(); assert(address && typeof address !== "string"); const port = address.port;
    await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, windowsHide: true, stdio: "ignore",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath, APP_ORIGIN: base } }); exited = once(child, "exit");
    function client() {
      const cookies = new Map<string, string>(); let csrf = "";
      async function request(path: string, options: RequestInit = {}) {
        const headers = new Headers(options.headers); headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
        const response = await fetch(base + path, { ...options, headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
        for (const item of response.headers.getSetCookie()) { const pair = item.split(";")[0]!, index = pair.indexOf("="); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
        return response;
      }
      async function login(id: number) {
        const challenge = await request("/api/auth/csrf"); assert.equal(challenge.status, 200); csrf = (await challenge.json() as { csrfToken: string }).csrfToken;
        const response = await request("/api/auth/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ email: `commercial-${id}@example.test`, password }) });
        assert.equal(response.status, 200); csrf = (await response.json() as { csrfToken: string }).csrfToken;
      }
      const write = (path: string, method: string, body: unknown, headers: Record<string, string> = {}) => request(path, { method,
        headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrf, ...headers }, body: JSON.stringify(body) });
      return { request, login, write };
    }
    async function json<T>(response: Response, expected = 200): Promise<T> {
      assert.equal(response.status, expected); assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text(); assert(!text.includes(password) && !text.includes(passwordHash) && !text.includes("SQLITE_") && !text.includes(".local-data")); return JSON.parse(text) as T;
    }
    currentCheck = "built server startup";
    const deadline = Date.now() + 20_000; let ready = false;
    while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error("Owned server exited."); try { ready = (await fetch(base + "/api/health/live", { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ } if (ready) break; await delay(150); }
    assert(ready);
    const anonymous = client(), owner = client(), other = client(), reader = client(), denied = client();
    for (const [caller, id] of [[owner, 1], [other, 2], [reader, 3], [denied, 4]] as const) await caller.login(id);
    currentCheck = "commercial HTTP persisted reads and current grants/owner scopes";
    await json(await anonymous.request("/api/items"), 401); await json(await denied.request("/api/items"), 403); await json(await denied.request("/api/quotations"), 403);
    const products = await json<CommercialPage<ProductRecord>>(await owner.request("/api/items?query=%25_&pageSize=1")); assert.equal(products.total, 1); assert.equal(products.items[0]!.description, hostile); assert.equal(products.items[0]!.unitPrice, null);
    assert.equal((await json<CommercialPage<QuotationSummary>>(await owner.request("/api/quotations"))).total, 2);
    assert.equal((await json<CommercialPage<QuotationSummary>>(await reader.request("/api/quotations?pageSize=1&page=2"))).items.length, 1);
    assert.equal((await json<CommercialPage<QuotationSummary>>(await other.request("/api/quotations"))).total, 1);
    await json(await owner.request("/api/quotations/2"), 404);
    assert.equal((await json<QuotationDetail>(await reader.request("/api/quotations/1"))).grandTotal, "210.00");
    assert.equal((await json<QuotationDetail>(await owner.request("/api/quotations/3"))).grandTotal, "189.00");
    await json(await reader.request("/api/quotations/candidates"), 403); await json(await owner.request("/api/quotations?userId=2"), 400);
    await json(await owner.request("/api/quotations", { headers: { Origin: "https://cross-origin.invalid" } }), 403);
    for (const page of ["/items", "/quotations", "/quotations/1", "/items/new", "/quotations/new"]) assert.equal((await anonymous.request(page)).status, 307);
    assert.equal((await denied.request("/items")).status, 404); assert.equal((await reader.request("/items/new")).status, 404); assert.equal((await reader.request("/quotations/1/edit")).status, 404);
    currentCheck = "runtime writes unavailable with zero business effects, discounts blocked and body security";
    const create = { taskId: "4", operationId: randomUUID(), expectedVersion: 1, quotation: quotation() };
    const edit = { operationId: randomUUID(), expectedVersion: 2, expectedQuoteVersion: 1, quotation: quotation() };
    await json(await owner.write("/api/items", "POST", { operationId: randomUUID(), name: "Synthetic runtime product", description: "Never persisted" }), 503);
    await json(await owner.write("/api/quotations", "POST", create), 503); await json(await owner.write("/api/quotations/1", "PATCH", edit), 503);
    await json(await owner.write("/api/quotations/3", "PATCH", edit), 409);
    await json(await owner.write("/api/quotations/1", "PATCH", { ...edit, quotation: quotation("10") }), 409);
    await json(await owner.write("/api/quotations/1", "PATCH", { ...edit, expectedVersion: 1 }), 409);
    await json(await reader.write("/api/quotations/1", "PATCH", edit), 403);
    await json(await owner.write("/api/quotations", "POST", create, { Origin: "https://cross-origin.invalid" }), 403);
    await json(await owner.write("/api/quotations", "POST", create, { "X-CSRF-Token": "invalid" }), 403);
    await json(await owner.write("/api/quotations", "POST", { ...create, quotation: { ...quotation(), items: [] } }), 400);
    await json(await owner.write("/api/quotations", "POST", { ...create, unexpected: true }), 400);
    await json(await owner.write("/api/quotations", "POST", { ...create, quotation: { ...quotation(), notes: "a".repeat(9000) } }), 503);
    await json(await owner.write("/api/quotations", "POST", { oversized: "a".repeat(262_145) }), 413);
    await json(await owner.write("/api/items", "POST", { oversized: "a".repeat(65_537) }), 413);
    assert.equal((await owner.request("/api/quotations/1", { method: "DELETE" })).status, 405);
    assert.deepEqual(db.prepare("SELECT * FROM crm_quotations ORDER BY id").all(), beforeQuotes);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM crm_commercial_operations").get() as { n: number }).n, beforeOperations);
    currentCheck = "authorized PDF bytes, persisted canonical totals, missing metadata and denied downloads";
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    for (const [caller, taskId, expected] of [[owner, "1", "210.00"], [other, "2", "210.00"], [owner, "3", "189.00"]] as const) {
      const response = await caller.request(`/api/quotations/${taskId}/pdf`); assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/pdf"); assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const bytes = new Uint8Array(await response.arrayBuffer()); assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
      const loading = pdfjs.getDocument({ data: bytes, useSystemFonts: false });
      const pdf = await loading.promise;
      let text = ""; for (let i = 1; i <= pdf.numPages; i++) text += (await (await pdf.getPage(i)).getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
      assert(text.includes(expected)); assert(text.includes("Synthetic contact")); assert.equal(await pdf.getJSActions(), null); await loading.destroy();
    }
    await json(await anonymous.request("/api/quotations/1/pdf"), 401); await json(await denied.request("/api/quotations/1/pdf"), 404); await json(await other.request("/api/quotations/1/pdf"), 404);
    await json(await owner.request("/api/quotations/1/pdf", { headers: { Origin: "https://cross-origin.invalid" } }), 403);
    db.prepare("UPDATE users SET company=NULL WHERE id=1").run(); await json(await owner.request("/api/quotations/1/pdf"), 409);
    db.prepare("UPDATE users SET company='VOLTRONIX CONTRACTING LLC' WHERE id=1").run();
    currentCheck = "Chromium product/quotation pages, preview controls, persisted detail and PDF download";
    browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.name));
    await page.goto(base + "/login"); await page.getByLabel("Email").fill("commercial-1@example.test"); await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.origin === base && ["/account", "/dashboard"].includes(url.pathname));
    await page.getByRole("link", { name: "Products", exact: true }).click(); await page.getByText(hostile, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Reflect.get(globalThis, "__commercialXss")), undefined);
    await page.getByLabel("Search products").fill("100%_"); await Promise.all([page.waitForResponse((r) => r.url().includes("/api/items?") && r.url().includes("query=100") && r.status() === 200), page.getByRole("button", { name: "Search", exact: true }).click()]);
    await page.getByRole("link", { name: "Create product", exact: true }).click(); assert(await page.getByRole("button", { name: "Create product", exact: true }).isDisabled());
    await page.goto(base + "/quotations"); await page.getByRole("link", { name: "SYN-Q-301", exact: true }).click(); await page.getByRole("region", { name: "Quotation items" }).waitFor();
    await page.getByText(hostile, { exact: true }).waitFor(); const downloaded = page.waitForEvent("download"); await page.getByRole("link", { name: "Download quotation PDF", exact: true }).click(); assert.match((await downloaded).suggestedFilename(), /\.pdf$/);
    await page.getByRole("link", { name: "Edit quotation", exact: true }).click(); assert(await page.getByRole("button", { name: "Save quotation", exact: true }).isDisabled());
    await page.getByRole("button", { name: "Calculate preview totals", exact: true }).click(); await page.getByText(/grand total: 210.00 AED/).waitFor();
    await page.goto(base + "/quotations/3/edit"); await page.getByRole("alert").filter({ hasText: "Discounted quotation edits are blocked" }).waitFor(); assert(await page.getByLabel("Quotation subject", { exact: true }).isDisabled());
    await page.goto(base + "/quotations/new?taskId=4"); await page.getByLabel("Quotation subject", { exact: true }).fill("Synthetic preview only"); await page.getByLabel("Kind attention", { exact: true }).fill("Synthetic contact");
    await page.getByLabel("Quotation product", { exact: true }).selectOption(product.productId!); await page.getByRole("button", { name: "Add selected product", exact: true }).click();
    await page.getByLabel("Item 1 description", { exact: true }).fill("Synthetic preview description"); await page.getByLabel("Item 1 unit price", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Calculate preview totals", exact: true }).click(); await page.getByText(/grand total: 105.00 AED/).waitFor(); assert(await page.getByRole("button", { name: "Create quotation", exact: true }).isDisabled());
    await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.goto(base + "/quotations/1"); await page.getByRole("region", { name: "Quotation items" }).waitFor(); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const screenshots = mkdtempSync(join(localDirectory(root, [".local-data", "reports"], true), "commercial-browser-")); await page.screenshot({ path: join(screenshots, "quotation-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: join(screenshots, "quotation-desktop.png"), fullPage: true });
    assert.deepEqual(errors, []);
    currentCheck = "fresh permissions, logout and persisted database integrity";
    db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run(); await json(await owner.request("/api/quotations/1/pdf"), 404); await json(await owner.request("/api/items"), 403);
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(base + "/login");
    assert.deepEqual(db.pragma("foreign_key_check"), []); assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.deepEqual(db.prepare("SELECT * FROM crm_quotations ORDER BY id").all(), beforeQuotes);
    console.log("PASS: Commercial persisted HTTP reads, owner/grant boundaries, literal search/pagination, body/CSRF/origin checks, disabled runtime mutations and zero new journal/business writes.");
    console.log("PASS: Both company PDFs and discounted-create canonical totals, authorized private downloads, no JavaScript, missing-metadata/IDOR/revocation checks.");
    console.log("PASS: Chromium product/quotation search/detail, safe text, exact preview totals, disabled writes/discounted edits, PDF download and 390px layouts; no runtime errors.");
    console.log("Synthetic screenshots only: " + join(screenshots, "quotation-desktop.png") + "; " + join(screenshots, "quotation-mobile.png"));
  } finally {
    await browser?.close().catch(() => { /* owned cleanup */ }); if (child?.exitCode === null) child.kill(); if (exited) await exited; db?.close();
    const target = realpathSync(directory); assert.equal(dirname(target), resolve(testRoot)); assert.equal(target, resolve(directory)); rmSync(target, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => { console.error(`Commercial HTTP/browser verification failed during ${currentCheck}. No real CRM data was used.`);
  if (error instanceof assert.AssertionError && typeof error.actual === "number" && typeof error.expected === "number") console.error(`Numeric assertion: expected ${error.expected}, received ${error.actual}.`);
  process.exitCode = 1;
});
