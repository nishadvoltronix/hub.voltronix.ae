import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("quotation product search preserves the selected line until an explicit result or clear", { timeout: 90_000 }, async t => {
  const directory = resolve(".local-data", "reports", `product-search-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const origin = "http://127.0.0.1:39984";
  const entry = `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {ProductSearch} from './src/components/crm/product-search';
    function Fixture(){const[item,setItem]=useState({productId:'101',productName:'Saved product',description:'Preserved custom description',unitPrice:'123.45'});const[disabled,setDisabled]=useState(false);
      return <main className="crm-page"><button onClick={()=>setDisabled(true)}>Disable picker</button><form onSubmit={e=>{e.preventDefault();window.submissions=(window.submissions||0)+1}}>
        <div style={{maxWidth:'100%',overflowX:'auto'}}><table style={{minWidth:900,width:'100%'}}><tbody><tr><td style={{width:300}}><ProductSearch index={0} selectedProductId={item.productId} initialProductName={item.productName} disabled={disabled} onChange={patch=>setItem(old=>({...old,...patch}))}/></td><td>Unchanged next column</td></tr></tbody></table></div>
        <label>Description<input value={item.description} onChange={e=>setItem({...item,description:e.target.value})}/></label><label>Price<input value={item.unitPrice} readOnly/></label>
        <output id="selected-id">{item.productId}</output><button type="submit">Save fixture</button></form></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const bundle = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
    format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const css = (await Promise.all(["src/app/globals.css", "public/legacy/assets/css/style.css", "public/legacy/assets/css/select2.min.css"]
    .map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const requests: { query: string; page: string }[] = [], failures: string[] = [], checks: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== "GET") { failures.push("Unexpected request"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style></head><body data-pc-direction="ltr"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/items") {
      const query = url.searchParams.get("query")!, number = url.searchParams.get("page")!;
      requests.push({ query, page: number });
      if (query === "refused") return route.fulfill({ status: 403, json: { error: "Product access unavailable." } });
      if (query === "slow") await new Promise(resolve => setTimeout(resolve, 500));
      const product = (id: string, name = "Matching product") => ({ id, externalId: id, name, description: "Selected description " + id, unitPrice: "50" });
      const items = query === "none" ? [] : query === "broken" ? [product("102"), product("102")]
        : number === "2" ? [product("103", "Second-page product")] : [product("102"), product("104")];
      try { return await route.fulfill({ json: { items, total: query === "none" ? 0 : query === "pages" ? 26 : items.length, page: Number(number), pageSize: 25 } }); }
      catch { return; } // A superseded search may have been aborted normally.
    }
    failures.push("Unexpected route"); return route.abort();
  });
  const trigger = () => page.getByRole("button", { name: "Item 1 product", exact: true });
  const search = () => page.getByRole("combobox", { name: "Item 1 product search", exact: true });
  const selected = () => page.locator("#selected-id").textContent();
  let passed = false;
  try {
    await page.goto(origin);
    assert.deepEqual(await trigger().evaluate(element => { const style = getComputedStyle(element); return { background: style.backgroundColor, height: style.height, fontSize: style.fontSize }; }),
      { background: "rgb(255, 255, 255)", height: "31px", fontSize: "13px" });
    checks.push("source Select2 white31px control and13px text override the generic action-button styling");
    assert.equal(await selected(), "101");
    assert.equal(requests.length, 0);
    await trigger().press("ArrowDown");
    assert.equal(await search().evaluate(element => document.activeElement === element), true);
    await page.getByText("Please enter 2 or more characters.", { exact: true }).waitFor();
    await search().fill("m");
    await page.waitForTimeout(250);
    assert.equal(requests.length, 0);
    await search().fill("match");
    await page.getByRole("option", { name: "Matching product (102)", exact: true }).waitFor();
    assert.equal(await selected(), "101");
    assert.equal(await page.getByLabel("Description", { exact: true }).inputValue(), "Preserved custom description");
    assert.equal(await page.getByLabel("Price", { exact: true }).inputValue(), "123.45");
    await search().press("Escape");
    assert.equal(await page.getByRole("listbox").count(), 0);
    assert.equal(await trigger().evaluate(element => document.activeElement === element), true);
    checks.push("two-character search and Escape preserve saved product, custom description, price and focus");

    await trigger().click(); await search().fill("match");
    await page.getByRole("option", { name: "Matching product (102)", exact: true }).waitFor();
    await search().press("ArrowDown");
    assert.equal(await page.getByRole("option", { name: "Matching product (104)", exact: true }).getAttribute("aria-selected"), "true");
    await search().press("Enter");
    assert.equal(await selected(), "104");
    assert.equal(await page.getByLabel("Description", { exact: true }).inputValue(), "Selected description 104");
    assert.equal(await page.getByLabel("Price", { exact: true }).inputValue(), "50");
    assert.equal(await page.evaluate(() => (window as Window & { submissions?: number }).submissions ?? 0), 0);
    checks.push("keyboard selection distinguishes duplicate names by stable IDs and synchronizes only the committed result without form submit");

    await trigger().click(); await search().fill("pages");
    await page.getByRole("button", { name: "Next item 1 product results" }).press("Enter");
    await page.getByRole("option", { name: "Second-page product (103)", exact: true }).click();
    assert.equal(await selected(), "103");
    assert.ok(requests.some(request => request.query === "pages" && request.page === "2"));
    checks.push("authorized result pagination permits explicit selection beyond the first25 records");

    for (const query of ["none", "refused", "broken"]) {
      await trigger().click(); await search().fill(query);
      await page.getByText(query === "none" ? "No results found." : query === "refused" ? "Product access unavailable." : "Some product results could not be identified. Refine your search.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("option").count(), 0);
      await search().press("Enter");
      assert.equal(await selected(), "103");
      await search().press("Escape");
    }
    checks.push("empty, refused and duplicate-ID results cannot change or erase a saved line");

    await trigger().click();
    const pendingSearch = page.waitForRequest(request => new URL(request.url()).searchParams.get("query") === "slow");
    await search().fill("slow");
    await pendingSearch;
    await search().fill("none");
    await page.getByText("No results found.", { exact: true }).waitFor();
    await page.waitForTimeout(550);
    assert.equal(await page.getByRole("option").count(), 0);
    assert.equal(await selected(), "103");
    await page.getByLabel("Description", { exact: true }).click();
    assert.equal(await page.getByRole("listbox").count(), 0);
    checks.push("a superseded lookup cannot install stale choices; outside dismissal preserves the selected line");

    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await trigger().click(); await search().fill("match");
      await page.getByRole("option", { name: "Matching product (102)", exact: true }).waitFor();
      const bounds = await page.locator(".crm-product-dropdown").boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 900);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: join(directory, `product-search-${width}.png`), fullPage: true });
      await search().press("Escape");
    }
    checks.push("source-sized popup escapes the table scroller and fits desktop/tablet/phone without page overflow");

    await trigger().click(); await search().press("Tab");
    assert.equal(await page.getByRole("listbox").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Clear item 1 product" }).evaluate(element => document.activeElement === element), true);
    await page.getByRole("button", { name: "Clear item 1 product" }).click();
    assert.equal(await selected(), "");
    assert.equal(await page.getByLabel("Description", { exact: true }).inputValue(), "");
    assert.equal(await page.getByLabel("Price", { exact: true }).inputValue(), "0");
    checks.push("Tab follows the original control order; explicit Clear resets identity, description and price");

    await trigger().click(); await page.getByRole("button", { name: "Disable picker" }).click();
    assert.equal(await trigger().isDisabled(), true);
    assert.equal(await page.getByRole("listbox").count(), 0);
    assert.equal(await page.evaluate(() => (window as Window & { submissions?: number }).submissions ?? 0), 0);
    assert.deepEqual(failures, []);
    checks.push("disabled authorization state closes results and prevents selection; zero business requests or fixture submissions");
    passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", checks, failures, requests,
      scope: "Actual product picker with synthetic intercepted GET results only; no credentials, database, application service or writes." }, null, 2), { flag: "wx" });
    t.diagnostic("Product search evidence: " + directory);
  }
});
