import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { calculateQuotation, parseQuotationInput } from "../src/server/commercial/quotations";

test("native Zoho editor preserves row identity across removal/addition and refuses an unverified receipt", { timeout: 45_000 }, async () => {
  const origin = "http://127.0.0.1:39979";
  const item = { productId: "101", productName: "Synthetic item", description: "Synthetic original", uom: "NOS", quantity: "1", unitPrice: "10", itemDiscount: "0" };
  const quotation = parseQuotationInput({ subject: "Synthetic quote", kindAttention: "Synthetic contact", notes: "Hub PDF note",
    discountType: "percentage", discount: "0", adjustment: "0", items: [item, { ...item, description: "Synthetic second line" }] });
  const quote = { id: "1", taskId: "7", externalId: "901", quoteNumber: "QUOTE-SYNTHETIC", version: 2, taskVersion: 4,
    persistence: "zoho", calculationPolicy: "percentage-only-v2", remoteRowIds: ["501", "502"], remoteModifiedAt: "2026-10-19T01:00:00Z",
    createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T01:00:00Z", quotation, totals: calculateQuotation(quotation),
    task: { dealNumber: "DEAL-SYNTHETIC", assignedExternalId: "801" } };
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {QuotationForm} from './src/components/crm/quotation-form';
    const quote=${JSON.stringify(quote)};if(location.search==='?missing-rows')delete quote.remoteRowIds;
    createRoot(document.getElementById('root')).render(<QuotationForm quote={quote}/>);`, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-fixture", setup(api) {
      api.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function useRouter(){return{refresh(){},push(){}}}"
        : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  const browser = await chromium.launch({ headless: true });
  const failures: string[] = [], submissions: { operationId: string; remoteRowIds: (string | null)[]; quotation: typeof quotation }[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    page.setDefaultTimeout(8000); page.on("pageerror", error => failures.push(error.message));
    await page.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { failures.push("Unexpected origin"); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><html><head><style>input,textarea{max-width:160px}table{width:100%}.visually-hidden{position:absolute;clip:rect(0,0,0,0)}</style></head><body><div id='root'></div><script src='/fixture.js'></script></body></html>" });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
      if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "synthetic-csrf" } });
      if (url.pathname === "/api/capabilities") return route.fulfill({ json: {
        persistence: "zoho", integrationAvailable: true, remoteWorkflow: true, localWorkflow: true, productCreate: true, leadNotes: true,
      } });
      if (url.pathname === "/api/quotations/7/capabilities") return route.fulfill({ json: {
        persistence: "zoho", taskVersion: 4, quoteVersion: 2, integrationAvailable: true, canEdit: true, canCreate: false,
        discountedEditBlocked: false, ...(new URL(page.url()).search === "?blocked" ? { blockedOperationId: "unfinished" } : {}),
      } });
      if (url.pathname === "/api/items" && request.method() === "GET") return route.fulfill({ json: {
        items: [{ id: "101", externalId: "101", name: "Synthetic item", description: "Synthetic new line", unitPrice: "10" }], total: 1, page: 1, pageSize: 25,
      } });
      if (url.pathname === "/api/quotations/7" && request.method() === "PATCH") {
        assert.equal(request.headers()["x-csrf-token"], "synthetic-csrf");
        const submitted = request.postDataJSON() as typeof submissions[number]; submissions.push(submitted);
        return route.fulfill({ json: { operationId: submitted.operationId, taskId: "7", quoteId: "1", version: 5, quoteVersion: 3,
          persistence: "zoho", ...(submissions.length > 1 ? { remoteVerified: true } : {}) } });
      }
      failures.push("Unexpected request: " + request.method() + " " + url.pathname); return route.abort();
    });
    for (const scenario of ["missing-rows", "blocked"]) {
      await page.goto(origin + "/?" + scenario);
      await page.waitForFunction(() => !document.body.textContent?.includes("Loading quotation access"));
      assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).isEnabled(), false);
    }
    await page.goto(origin);
    const save = page.getByRole("button", { name: "Save quotation", exact: true });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('button[aria-label="Save quotation"]')?.disabled);
    await page.getByRole("button", { name: "Remove item 1", exact: true }).click();
    assert.equal(await page.locator("tbody tr").count(), 1);
    assert.equal(await page.locator("tbody tr textarea").inputValue(), "Synthetic second line");
    await page.getByRole("button", { name: "Add Item", exact: true }).click();
    await page.getByRole("button", { name: "Item 2 product", exact: true }).click();
    await page.getByRole("combobox", { name: "Item 2 product search", exact: true }).fill("Synthetic");
    await page.getByRole("option", { name: "Synthetic item (101)", exact: true }).click();
    await save.click();
    await page.getByRole("alert").filter({ hasText: "could not be confirmed" }).waitFor();
    assert.equal(await page.getByText("Quotation updated successfully.", { exact: true }).isVisible(), false);
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0]!.remoteRowIds, ["502", null]);
    assert.deepEqual(submissions[0]!.quotation.items.map(row => row.productId), ["101", "101"]);
    assert.equal(submissions[0]!.quotation.notes, "Hub PDF note");
    await save.click();
    await page.getByText("Quotation updated successfully.", { exact: true }).waitFor();
    assert.equal(submissions.length, 2); assert.equal(submissions[0]!.operationId, submissions[1]!.operationId);
    assert.match(await page.getByRole("dialog").innerText(), /Saved in Zoho and verified/);
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
});
