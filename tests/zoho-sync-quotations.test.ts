import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("synchronized quotations preserve exact historical values and expose no write or invented PDF action", { timeout: 60_000 }, async () => {
  const origin = "http://127.0.0.1:39986";
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';
    import {SyncedQuotations} from './src/components/crm/synced-quotations';
    import {ZohoImportNotice} from './src/components/crm/zoho-import-notice';
    createRoot(document.getElementById('root')).render(<><ZohoImportNotice source={{provider:'zoho',readOnly:true,lastSyncedAt:'2026-10-19T08:00:00Z',conflict:true}}/><SyncedQuotations taskId="123"/></>);`,
    loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-link-stub", setup(api) { api.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "import React from 'react';export default function Link(props){return React.createElement('a',props)}", resolveDir: process.cwd() })); } }] });
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage();
  const failures: string[] = []; let reads = 0;
  page.on("pageerror", () => failures.push("page error"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected mutation or external request"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<main id="root"></main><script src="/bundle.js"></script>' });
    if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/capabilities") return route.fulfill({ json: { persistence: "zoho", zohoInbound: true } });
    if (url.pathname === "/api/zoho-sync/status") return route.fulfill({ json: { state: "failed", lastAttemptAt: "2026-10-19T08:05:00Z", lastSuccessAt: "2026-10-19T08:00:00Z" } });
    if (url.pathname === "/api/zoho-sync/quotations") {
      reads++; assert.equal(url.searchParams.get("taskId"), "123");
      return route.fulfill({ json: { total: 1, page: 1, pageSize: 10, items: [{ id: "71", taskId: "123", quoteNumber: "SOURCE-71", subject: "Recorded <script>unsafe</script>",
        dealName: "Source deal", accountName: null, createdAt: "2026-10-18T07:00:00Z", modifiedAt: "2026-10-19T07:00:00Z", lastSyncedAt: "2026-10-19T08:00:00Z", deleted: false, conflict: false,
        totals: { subtotal: "9007199254740993.123456789", discount: "7.2500", tax: null, adjustment: "0", grandTotal: "9007199254740985.873456789" }, header: { project: "<img src=x onerror=alert(1)>" },
        lines: [{ externalId: "811", productName: "Recorded product", description: "<script>unsafe</script>", uom: null, quantity: "1.000", unitPrice: "9007199254740993.123456789", itemDiscount: "7.2500", netTotal: null }] }] } });
    }
    failures.push("Unexpected request"); return route.abort();
  });
  try {
    await page.goto(origin);
    await page.getByText(/SOURCE-71/).click();
    assert.equal(await page.getByText("9007199254740985.873456789", { exact: true }).count(), 1);
    assert.equal(await page.getByText("9007199254740993.123456789", { exact: true }).count(), 2);
    assert.equal(await page.getByText(/synchronization needs review/).count(), 1);
    assert.equal(await page.getByText(/Previously synchronized values may be out of date/).count(), 1);
    assert.equal(await page.getByText("Not recorded", { exact: true }).count() > 0, true);
    assert.equal(await page.locator("main script, main img, form").count(), 0);
    assert.equal(await page.getByRole("link", { name: /edit|pdf|download/i }).count(), 0);
    const before = reads; await page.getByRole("button", { name: "Refresh synchronized quotations" }).click();
    await page.getByText(/SOURCE-71/).waitFor(); assert.equal(reads, before + 1);
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
});
