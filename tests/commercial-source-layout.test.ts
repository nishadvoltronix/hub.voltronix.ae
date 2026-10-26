import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";

const origin = "http://127.0.0.1:39982";
async function fixture(t: TestContext, component: "Products" | "ProductCreate" | "Quotations" | "QuotationCreateForm" | "QuotationForm", respond: (route: Route, url: URL) => Promise<boolean>) {
  const directory = resolve(".local-data", "reports", `commercial-source-${component}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const module = component === "QuotationForm" ? "quotation-form" : component === "QuotationCreateForm" ? "quotation-create-form" : component === "Quotations" ? "quotations" : "products";
  const savedQuote = `const quotation=parseLocalQuotationInput({subject:'Saved fixture quote',kindAttention:'',discountType:'percentage',discount:'5',adjustment:'0',items:[{productId:'101',productName:'Fixture item',description:'Original',uom:'NOS',quantity:'2',unitPrice:'100',itemDiscount:'10'}]});const quote={id:'local-3',taskId:'7',quoteNumber:'SAVED-7',version:1,taskVersion:3,persistence:'local-demo',calculationPolicy:'percentage-only-v2',createdAt:'2026-10-13T00:00:00Z',quotation,totals:calculateLocalQuotation(quotation),task:{dealNumber:'DEAL-7'}};`;
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {${component}} from './src/components/crm/${module}';import {parseLocalQuotationInput,calculateLocalQuotation} from './src/server/commercial/quotations';${component === "QuotationForm" ? savedQuote : ""}createRoot(document.getElementById('root')).render(<main className="crm-page"><${component} canCreate={true} initialTaskId="7" ${component === "QuotationForm" ? "quote={quote}" : ""}/></main>);`, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-link-fixture", setup(api) {
      api.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation") ? "export function useRouter(){return{refresh(){},push(path){window.fixtureDestination=path}}}" : "import React from 'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  const css = (await Promise.all(["src/app/globals.css", "public/legacy/assets/css/style.css"].map(file => readFile(file, "utf8"))))
    .join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const failures: string[] = [], checks: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  let passed = false;
  t.after(async () => {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", checks, failures,
      scope: "Synthetic component browser with intercepted API replies; no CRM credentials, services, sessions or database writes." }, null, 2), { flag: "wx" });
    t.diagnostic("Commercial source evidence: " + directory);
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { failures.push("Unexpected origin"); return route.abort(); }
    if (url.pathname === "/" && route.request().method() === "GET") return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body data-pc-direction="ltr"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (await respond(route, url)) return;
    failures.push("Unexpected request: " + route.request().method() + " " + url.pathname); return route.abort();
  });
  async function captures(name: string) {
    assert.equal(await page.evaluate(() => document.characterSet), "UTF-8");
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const modal = page.getByRole("dialog");
      const open = await modal.count() > 0;
      if (open) {
        const bounds = await modal.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900);
      }
      await page.screenshot({ path: join(directory, `${name}-${width}.png`), fullPage: !open });
    }
    checks.push(name + " at 1440/768/390px with no document overflow");
  }
  return { page, checks, captures, finish() { assert.deepEqual(failures, []); passed = true; } };
}

test("source Items list restores columns, search, count and ten-row pagination without exposing invented prices", { timeout: 90_000 }, async t => {
  const requested: URL[] = [];
  const f = await fixture(t, "Products", async (route, url) => {
    if (url.pathname === "/api/capabilities") { await route.fulfill({ json: { productCreate: true, persistence: "local-demo" } }); return true; }
    if (url.pathname !== "/api/items" || route.request().method() !== "GET") return false;
    requested.push(url);
    const page = Number(url.searchParams.get("page"));
    await route.fulfill({ json: { page, pageSize: 10, total: 12, items: [{ externalId: String(page), name: "Synthetic source item " + page,
      description: "Hidden supplementary value", unitPrice: null, updatedAt: "2026-10-13T00:00:00Z" }] } }); return true;
  });
  await f.page.goto(origin);
  await f.page.getByRole("cell", { name: "Synthetic source item 1", exact: true }).waitFor();
  assert.deepEqual(await f.page.getByRole("columnheader").allTextContents(), ["#", "Item Name", "Modified"]);
  assert.equal(requested[0]!.searchParams.get("pageSize"), "10");
  await f.page.getByText("Records on this page:", { exact: false }).waitFor();
  assert.equal(await f.page.getByRole("link", { name: "Create Item", exact: true }).getAttribute("href"), "/items/new");
  await f.captures("source-items-list");
  await f.page.getByRole("button", { name: "Next page", exact: true }).click();
  await f.page.getByRole("cell", { name: "Synthetic source item 2", exact: true }).waitFor();
  assert.equal(await f.page.getByRole("row").nth(1).getByRole("cell").first().textContent(), "11");
  await f.page.getByLabel("Search Items", { exact: true }).fill("100% item");
  await f.page.getByRole("button", { name: "Search", exact: true }).click();
  await f.page.getByRole("cell", { name: "Synthetic source item 1", exact: true }).waitFor();
  assert.equal(requested.at(-1)!.searchParams.get("query"), "100% item");
  assert.equal(requested.at(-1)!.searchParams.get("page"), "1");
  const sorted = f.page.waitForResponse(response => new URL(response.url()).searchParams.get("sort") === "updatedAt");
  await f.page.getByRole("button", { name: "Sort by Modified", exact: true }).click(); await sorted;
  assert.equal(requested.at(-1)!.searchParams.get("direction"), "asc");
  await f.page.getByRole("columnheader", { name: "Sort by Modified", exact: true }).waitFor();
  assert.equal(await f.page.getByRole("columnheader", { name: "Sort by Modified", exact: true }).getAttribute("aria-sort"), "ascending");
  const resized = f.page.waitForResponse(response => new URL(response.url()).searchParams.get("pageSize") === "50");
  await f.page.getByRole("combobox", { name: "Items per page", exact: true }).selectOption("50"); await resized;
  assert.equal(requested.at(-1)!.searchParams.get("page"), "1");
  assert.equal(requested.at(-1)!.searchParams.get("query"), "100% item");
  f.checks.push("original list fields and explicit server search/pagination preserve encoded query and reset page");
  f.finish();
});

test("source item create dialog preserves drafts and operation identity after denial, then resets and focuses Create Another", { timeout: 90_000 }, async t => {
  const writes: { name: string; description: string; operationId: string }[] = [];
  let available = true;
  const f = await fixture(t, "ProductCreate", async (route, url) => {
    if (url.pathname === "/api/capabilities") { await route.fulfill({ json: { productCreate: available, persistence: "local-demo" } }); return true; }
    if (url.pathname === "/api/auth/csrf" && route.request().method() === "GET") { await route.fulfill({ json: { csrfToken: "synthetic-csrf" } }); return true; }
    if (url.pathname !== "/api/items" || route.request().method() !== "POST") return false;
    assert.equal(route.request().headers()["x-csrf-token"], "synthetic-csrf");
    writes.push(route.request().postDataJSON());
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill(writes.length === 1 ? { status: 403, json: { error: "Access denied." } } : { json: { productId: "synthetic-2", version: 1 } }); return true;
  });
  await f.page.goto(origin);
  await f.page.getByRole("heading", { name: "Add New Item", exact: true }).waitFor();
  const name = f.page.getByRole("textbox", { name: "Item Name", exact: true });
  const description = f.page.getByRole("textbox", { name: "Description (Optional)", exact: true });
  await name.fill("Synthetic item"); await description.fill("Preserved description");
  await f.captures("source-item-form");
  await f.page.getByRole("button", { name: "Save Item", exact: true }).click();
  await f.page.getByRole("heading", { name: "Creating Item", exact: true }).waitFor();
  await f.page.keyboard.press("Escape");
  assert.equal(await f.page.getByRole("dialog").isVisible(), true);
  await f.page.getByRole("heading", { name: "Item Creation Failed", exact: true }).waitFor();
  assert.equal(await f.page.getByRole("alert").textContent(), "Access denied.");
  await f.page.getByRole("button", { name: "OK", exact: true }).click();
  assert.equal(await name.inputValue(), "Synthetic item"); assert.equal(await description.inputValue(), "Preserved description");
  await f.page.getByRole("button", { name: "Save Item", exact: true }).click();
  await f.page.getByRole("heading", { name: "Item Created Successfully", exact: true }).waitFor();
  assert.equal(writes[0]!.operationId, writes[1]!.operationId);
  assert.equal(await name.inputValue(), ""); assert.equal(await description.inputValue(), "");
  assert.equal(await f.page.getByRole("button", { name: "Create Another", exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), "rgb(13, 110, 253)");
  await f.captures("source-item-result");
  assert.equal(await f.page.locator(".crm-item-status-dialog").evaluate(node => getComputedStyle(node).borderRadius), "16px");
  await f.page.getByRole("button", { name: "Create Another", exact: true }).click();
  assert.equal(await name.evaluate(node => node === document.activeElement), true);
  await name.fill("   "); await f.page.getByRole("button", { name: "Save Item", exact: true }).click();
  assert.equal(writes.length, 2);
  available = false; await f.page.reload();
  await f.page.getByText("Product creation is unavailable", { exact: false }).waitFor();
  assert.equal(await f.page.getByRole("button", { name: "Save Item", exact: true }).isDisabled(), true);
  f.checks.push("busy cancellation blocked; CSRF carried; denied draft/idempotency preserved; success reset/focus; whitespace and disabled capability cannot submit");
  f.finish();
});

test("source quotation list restores actual task context and PDF/deal actions without changing amount or historical provenance", { timeout: 90_000 }, async t => {
  const requested: URL[] = [];
  const longAccountName = "Source account with a long recorded name and unbroken identifier " + "A".repeat(160);
  const f = await fixture(t, "Quotations", async (route, url) => {
    if (url.pathname === "/api/capabilities" && route.request().method() === "GET") { await route.fulfill({ json: { persistence: "local-demo", zohoInbound: false } }); return true; }
    if (url.pathname !== "/api/quotations" || route.request().method() !== "GET") return false;
    requested.push(url);
    await route.fulfill({ json: { page: 1, pageSize: 10, total: 2, items: [
      { id: "local-1", taskId: "7", quoteNumber: "SAVED-7", createdAt: "2026-10-12T11:29:38Z", dealNumber: "DEAL-7", accountName: longAccountName, dealStatus: "Proposal/Price Quote", jobStatus: "Hold", assignedName: "Source salesperson", subtotal: "160.00", grandTotal: "159.60", persistence: "local-demo", pdfAvailable: true },
      { id: "local-2", taskId: "8", quoteNumber: "SAVED-8", createdAt: "2026-10-13T00:00:00Z", dealNumber: null, accountName: null, dealStatus: "Qualification", jobStatus: null, assignedName: null, subtotal: "200.00", grandTotal: "210.00", persistence: "local-demo", pdfAvailable: false },
    ] } }); return true;
  });
  await f.page.goto(origin);
  await f.page.getByRole("cell", { name: "DEAL-7", exact: true }).waitFor();
  assert.deepEqual(await f.page.getByRole("columnheader").allTextContents(), ["Quote Created", "Quote Number", "Deal Number", "Account Name", "Deal Status", "Overall Status", "Salesperson", "Amount", "Action"]);
  assert.equal(await f.page.getByRole("link", { name: "Download SAVED-7 PDF", exact: true }).getAttribute("href"), "/api/quotations/7/pdf");
  assert.equal(await f.page.getByRole("link", { name: "View deal for SAVED-7", exact: true }).getAttribute("href"), "/leads/7");
  assert.equal(await f.page.getByRole("link", { name: "SAVED-7", exact: true }).getAttribute("href"), "/quotations/7");
  assert.equal(await f.page.getByRole("link", { name: "Download SAVED-8 PDF", exact: true }).count(), 0);
  assert.equal(await f.page.getByText("Hold", { exact: true }).count(), 1);
  assert.equal(await f.page.getByText("Active", { exact: true }).count(), 1);
  for (const [label, foreground, background] of [["Active", "rgb(25, 135, 84)", "rgb(233, 247, 239)"], ["Hold", "rgb(206, 11, 11)", "rgb(246, 197, 202)"]]) {
    assert.deepEqual(await f.page.getByText(label!, { exact: true }).evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor })), { foreground, background });
  }
  const account = f.page.locator(".crm-cell-scroll").filter({ hasText: longAccountName });
  assert.equal(await account.innerText(), longAccountName);
  const accountBounds = await account.boundingBox();
  assert.ok(accountBounds && accountBounds.width <= 260 && accountBounds.height <= 60);
  assert.equal(await account.evaluate(element => getComputedStyle(element).overflowY), "auto");
  const listRegion = f.page.getByRole("region", { name: "All quotations", exact: true });
  for (const width of [1440, 768, 390]) {
    await f.page.setViewportSize({ width, height: 900 });
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.equal(await listRegion.evaluate(element => getComputedStyle(element).overflowX), "auto");
    await f.page.getByRole("link", { name: "View deal for SAVED-7", exact: true }).scrollIntoViewIfNeeded();
    const regionBounds = await listRegion.boundingBox(), actionBounds = await f.page.getByRole("link", { name: "View deal for SAVED-7", exact: true }).boundingBox();
    assert.ok(regionBounds && actionBounds && actionBounds.x >= regionBounds.x && actionBounds.x + actionBounds.width <= regionBounds.x + regionBounds.width);
  }
  await listRegion.evaluate(element => { element.scrollLeft = 0; });
  assert.equal(await f.page.getByText("160.00", { exact: true }).count(), 1);
  assert.equal(await f.page.getByText("159.60", { exact: true }).count(), 0);
  await f.captures("source-quotation-list");
  const sorted = f.page.waitForResponse(response => new URL(response.url()).searchParams.get("sort") === "subtotal");
  await f.page.getByRole("button", { name: "Sort by Amount", exact: true }).click(); await sorted;
  assert.equal(requested.at(-1)!.searchParams.get("direction"), "asc");
  await f.page.getByRole("columnheader", { name: "Sort by Amount", exact: true }).waitFor();
  const descending = f.page.waitForResponse(response => new URL(response.url()).searchParams.get("sort") === "subtotal" && new URL(response.url()).searchParams.get("direction") === "desc");
  await f.page.getByRole("button", { name: "Sort by Amount", exact: true }).click(); await descending;
  const resized = f.page.waitForResponse(response => new URL(response.url()).searchParams.get("pageSize") === "100");
  await f.page.getByRole("combobox", { name: "Quotations per page", exact: true }).selectOption("100"); await resized;
  assert.equal(requested[0]!.searchParams.get("pageSize"), "10");
  assert.equal(requested.at(-1)!.searchParams.get("sort"), "subtotal");
  assert.equal(requested.at(-1)!.searchParams.get("page"), "1");
  f.checks.push("nine source columns, bounded source account cell with preserved text, original Active/Hold colors, persisted task fields/status, pre-VAT source Amount, guarded PDF action and original deal-details destination");
  f.finish();
});

test("source quotation create result dialog retains failed drafts and offers only the confirmed saved PDF", { timeout: 90_000 }, async t => {
  const writes: { operationId: string; expectedVersion: number; quotation: { discountType: string; subject: string } }[] = [];
  let pdfAvailable = true;
  const f = await fixture(t, "QuotationCreateForm", async (route, url) => {
    if (url.pathname === "/api/capabilities") { await route.fulfill({ json: { localWorkflow: true, persistence: "local-demo" } }); return true; }
    if (url.pathname === "/api/leads/7") { await route.fulfill({ json: { id: "7", dealNumber: "DEAL-7" } }); return true; }
    if (url.pathname === "/api/quotations/candidates") { await route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } }); return true; }
    if (url.pathname === "/api/quotations/7/capabilities") { await route.fulfill({ json: { canCreate: true, taskVersion: 3, persistence: "local-demo" } }); return true; }
    if (url.pathname === "/api/items") { await route.fulfill({ json: { items: [{ externalId: "101", name: "Synthetic item", description: "Fixture", unitPrice: "100" }], total: 1, page: 1, pageSize: 25 } }); return true; }
    if (url.pathname === "/api/auth/csrf") { await route.fulfill({ json: { csrfToken: "synthetic-csrf" } }); return true; }
    if (url.pathname === "/api/quotations/7" && route.request().method() === "GET") { await route.fulfill({ json: { id: "local-3", taskId: "7", quoteNumber: "CONFIRMED-7", pdfAvailable } }); return true; }
    if (url.pathname !== "/api/quotations" || route.request().method() !== "POST") return false;
    assert.equal(route.request().headers()["x-csrf-token"], "synthetic-csrf");
    writes.push(route.request().postDataJSON());
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill(writes.length === 1 ? { status: 409, json: { error: "Quotation version changed." } } : { json: { taskId: "7", quoteId: "local-3", version: 4 } }); return true;
  });
  await f.page.goto(origin);
  const fillDraft = async () => {
    await f.page.getByLabel("Subject", { exact: false }).fill("Retained quotation draft");
    await f.page.getByRole("button", { name: "Item 1 product", exact: true }).click();
    await f.page.getByRole("combobox", { name: "Item 1 product search", exact: true }).fill("sy");
    await f.page.getByRole("option", { name: "Synthetic item (101)", exact: true }).click();
  };
  await fillDraft();
  await f.page.getByRole("button", { name: "Save Proposal", exact: true }).click();
  await f.page.getByRole("heading", { name: "Creating Quote", exact: true }).waitFor();
  await f.page.keyboard.press("Escape"); assert.equal(await f.page.getByRole("dialog").isVisible(), true);
  await f.page.getByRole("heading", { name: "Creation Failed", exact: true }).waitFor();
  assert.equal(await f.page.getByRole("alert").filter({ hasText: "Quotation version changed." }).count(), 1);
  await f.page.getByRole("button", { name: "OK", exact: true }).click();
  assert.equal(await f.page.getByLabel("Subject", { exact: false }).inputValue(), "Retained quotation draft");
  await f.page.getByRole("button", { name: "Save Proposal", exact: true }).click();
  await f.page.getByRole("heading", { name: "Quote Created Successfully", exact: true }).waitFor();
  const download = f.page.getByRole("link", { name: "Download PDF", exact: true });
  await download.waitFor(); assert.equal(await download.getAttribute("href"), "/api/quotations/7/pdf");
  assert.equal(writes[0]!.operationId, writes[1]!.operationId);
  assert.equal(writes[1]!.expectedVersion, 3); assert.equal(writes[1]!.quotation.discountType, "percentage");
  assert.equal(writes[1]!.quotation.subject, "Retained quotation draft");
  await f.page.getByText("CONFIRMED-7", { exact: false }).waitFor();
  await f.captures("source-quotation-result");
  await f.page.getByRole("button", { name: "OK", exact: true }).click();
  assert.equal(await f.page.getByRole("button", { name: "Save Proposal", exact: true }).isDisabled(), true);
  pdfAvailable = false; await f.page.reload(); await fillDraft();
  await f.page.getByRole("button", { name: "Save Proposal", exact: true }).click();
  await f.page.getByRole("heading", { name: "Quote Created Successfully", exact: true }).waitFor();
  await f.page.getByText("CONFIRMED-7", { exact: false }).waitFor();
  assert.equal(await download.count(), 0);
  f.checks.push("busy modal blocks Escape; failed save preserves draft and operation ID; CSRF/version/percentage payload intact; success uses fresh recorded quote identity and PDF capability; duplicate submit disabled");
  f.finish();
});

test("source quotation edit confirms a successful versioned save before returning to the original deal workflow", { timeout: 90_000 }, async t => {
  const writes: { operationId: string; expectedVersion: number; expectedQuoteVersion: number; quotation: { discountType: string; discount: string } }[] = [];
  const f = await fixture(t, "QuotationForm", async (route, url) => {
    if (url.pathname === "/api/capabilities") { await route.fulfill({ json: { localWorkflow: true, persistence: "local-demo" } }); return true; }
    if (url.pathname === "/api/quotations/7/capabilities") { await route.fulfill({ json: { canEdit: true, taskVersion: 3, quoteVersion: 1, persistence: "local-demo", pdfAvailable: true } }); return true; }
    if (url.pathname === "/api/auth/csrf") { await route.fulfill({ json: { csrfToken: "synthetic-csrf" } }); return true; }
    if (url.pathname !== "/api/quotations/7" || route.request().method() !== "PATCH") return false;
    assert.equal(route.request().headers()["x-csrf-token"], "synthetic-csrf"); writes.push(route.request().postDataJSON());
    await route.fulfill(writes.length === 1 ? { status: 403, json: { error: "Access denied." } } : { json: { taskId: "7", quoteId: "local-3", version: 4, quoteVersion: 2 } }); return true;
  });
  await f.page.goto(origin);
  const save = f.page.getByRole("button", { name: "Save quotation", exact: true });
  await save.click(); await f.page.getByRole("alert").filter({ hasText: "Access denied." }).waitFor();
  assert.equal(await f.page.getByRole("dialog").count(), 0);
  assert.equal(await f.page.evaluate(() => (window as Window & { fixtureDestination?: string }).fixtureDestination), undefined);
  await save.click();
  await f.page.getByRole("heading", { name: "Quotation updated successfully.", exact: true }).waitFor();
  assert.equal(await f.page.evaluate(() => (window as Window & { fixtureDestination?: string }).fixtureDestination), undefined);
  assert.equal(writes[0]!.operationId, writes[1]!.operationId);
  assert.equal(writes[1]!.expectedVersion, 3); assert.equal(writes[1]!.expectedQuoteVersion, 1);
  assert.equal(writes[1]!.quotation.discountType, "percentage"); assert.equal(writes[1]!.quotation.discount, "5");
  await f.captures("source-quotation-edit-confirmation");
  await f.page.getByRole("button", { name: "OK", exact: true }).click();
  await f.page.waitForFunction(() => (window as Window & { fixtureDestination?: string }).fixtureDestination === "/leads/7");
  f.checks.push("failure never redirects; successful CSRF/versioned percentage edit retains source confirmation then returns to the same deal after OK");
  f.finish();
});
