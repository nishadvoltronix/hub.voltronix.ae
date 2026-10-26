import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("quotation picker stays anchored and confines result scrolling in a long responsive form", { timeout: 90_000 }, async t => {
  const directory = resolve(".local-data", "reports", `product-search-viewport-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const origin = "http://127.0.0.1:39983";
  const entry = `import {createRoot} from 'react-dom/client';import {useState} from 'react';import {ProductSearch} from './src/components/crm/product-search';
    function Fixture(){const[item,setItem]=useState({productId:'saved',productName:'Saved product',description:'Historical custom text',unitPrice:'123.45'});
      return <main className="crm-app crm-page" style={{padding:16}}><div style={{height:1000}}>Synthetic quotation header</div>
        <form onSubmit={event=>{event.preventDefault();window.submissions=(window.submissions||0)+1}}>
          <button type="button" id="before-picker">Previous quotation control</button>
          <div id="table-scroll" style={{maxWidth:'100%',overflowX:'auto'}}><table style={{tableLayout:'fixed',width:2200}}><colgroup><col style={{width:40}}/><col style={{width:300}}/><col/></colgroup>
            <tbody><tr><td>Line 1</td><td><ProductSearch index={0} selectedProductId={item.productId} initialProductName={item.productName} onChange={patch=>setItem(old=>({...old,...patch}))}/></td><td>Quotation columns</td></tr></tbody></table></div>
          <label>Description<input id="description" value={item.description} readOnly/></label><label>Price<input id="price" value={item.unitPrice} readOnly/></label>
          <output id="selected-id">{item.productId}</output><button type="submit">Save synthetic quotation</button>
        </form><div style={{height:1000}}>Synthetic quotation footer</div>
        <button type="button" id="outside-picker" style={{position:'fixed',right:16,bottom:12}}>Outside picker</button>
      </main>};createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const bundle = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true,
    write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  // Keep the source theme's smooth document scrolling: disabling it would mask the regression.
  const css = (await Promise.all(["src/app/globals.css", "public/legacy/assets/css/style.css", "public/legacy/assets/css/select2.min.css"]
    .map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync",
      "--no-default-browser-check", "--no-first-run", "--disable-features=MediaRouter,OptimizationHints"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  page.setDefaultTimeout(7_000);
  const failures: string[] = [], checks: string[] = [], requests: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  page.on("console", message => { if (message.type() === "error") failures.push("Browser console error"); });
  page.on("requestfailed", () => failures.push("Failed browser request"));
  await page.routeWebSocket("**/*", socket => { failures.push("Unexpected websocket"); socket.close(); });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== "GET") { failures.push("Unexpected origin or method"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style></head><body data-pc-direction="ltr"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/items" && url.searchParams.get("query") === "match" && url.searchParams.get("page") === "1" && url.searchParams.get("pageSize") === "25") {
      requests.push("synthetic product search GET");
      return route.fulfill({ json: { items: Array.from({ length: 25 }, (_, index) => ({ id: String(index + 1), externalId: String(index + 1),
        name: `Synthetic product ${String(index + 1).padStart(2, "0")}`, description: `Synthetic description ${index + 1}`, unitPrice: "50" })), total: 25, page: 1, pageSize: 25 } });
    }
    failures.push("Unexpected route"); return route.abort();
  });
  const trigger = page.getByRole("button", { name: "Item 1 product", exact: true });
  const search = page.getByRole("combobox", { name: "Item 1 product search", exact: true });
  const list = page.getByRole("listbox"), popup = page.locator(".crm-product-dropdown");
  const selected = () => page.locator("#selected-id").textContent();
  const scrollState = () => page.evaluate(() => ({ x: window.scrollX, y: window.scrollY,
    table: document.querySelector("#table-scroll")!.scrollLeft }));
  async function align(top: number) {
    await trigger.evaluate((element, target) => window.scrollBy({ top: element.getBoundingClientRect().top - target, behavior: "instant" }), top);
    await page.waitForFunction(target => Math.abs(document.querySelector('[aria-label="Item 1 product"]')!.getBoundingClientRect().top - target) < 2, top);
  }
  async function openResults() {
    await trigger.click(); await search.fill("match");
    await page.getByRole("option", { name: "Synthetic product 25 (25)", exact: true }).waitFor();
    assert.equal(await search.evaluate(element => element === document.activeElement), true);
  }
  async function containedAndAnchored() {
    await page.waitForFunction(() => {
      const anchor = document.querySelector('[aria-label="Item 1 product"]')!.getBoundingClientRect();
      const box = document.querySelector(".crm-product-dropdown")?.getBoundingClientRect();
      return box && box.width > 0 && box.height > 0 && box.x >= 11 && box.right <= innerWidth - 11 && box.y >= 11 && box.bottom <= innerHeight - 11
        && (Math.abs(box.top - anchor.bottom) < 2 || Math.abs(box.bottom - anchor.top) < 2);
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), page.viewportSize()!.width);
  }
  async function closed() { await popup.waitFor({ state: "detached" }); }
  let passed = false;
  try {
    await page.goto(origin);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), "smooth");
    const dimensions = [{ width: 1440, height: 900 }, { width: 768, height: 900 }, { width: 390, height: 844 }, { width: 667, height: 320 }];
    for (const size of dimensions) {
      const label = `${size.width}x${size.height}`;
      await page.setViewportSize(size);
      await page.locator("#table-scroll").evaluate(element => { element.scrollLeft = 0; });
      await align(size.height - 70);
      const priorId = await selected(), priorDescription = await page.locator("#description").inputValue(), priorPrice = await page.locator("#price").inputValue();
      const before = await scrollState();
      await openResults(); await containedAndAnchored();
      assert.deepEqual(await scrollState(), before);
      assert.equal(await selected(), priorId);
      assert.equal(await page.locator("#description").inputValue(), priorDescription);
      assert.equal(await page.locator("#price").inputValue(), priorPrice);
      assert.equal(await list.evaluate(element => element.scrollTop), 0);
      checks.push(`${label}: lower-edge opening, initial results and saved draft do not scroll the quotation`);

      if (size.width === 1440) {
        await list.hover();
        for (let index = 0; index < 24; index++) await search.press("ArrowUp");
        await page.mouse.wheel(0, 1200);
        await page.waitForFunction(() => document.querySelector('[role="listbox"]')!.scrollTop > 0);
        await search.press("ArrowUp");
        assert.equal(await list.evaluate(element => element.scrollTop), 0);
        assert.deepEqual(await scrollState(), before);
        checks.push("Boundary ArrowUp re-reveals the first active option after manual list scrolling without moving the quotation");
      }

      for (let index = 0; index < 24; index++) await search.press("ArrowDown");
      assert.equal(await page.getByRole("option", { name: "Synthetic product 25 (25)", exact: true }).getAttribute("aria-selected"), "true");
      assert.ok(await list.evaluate(element => element.scrollTop > 0));
      assert.deepEqual(await scrollState(), before);
      if (size.width === 1440) {
        await page.mouse.wheel(0, -1200);
        await page.waitForFunction(() => document.querySelector('[role="listbox"]')!.scrollTop === 0);
        await search.press("ArrowDown");
        assert.ok(await list.evaluate(element => element.scrollTop > 0));
        assert.deepEqual(await scrollState(), before);
        checks.push("Boundary ArrowDown re-reveals the last active option after manual list scrolling without moving the quotation");
      }
      await search.press("ArrowUp");
      assert.equal(await page.getByRole("option", { name: "Synthetic product 24 (24)", exact: true }).getAttribute("aria-selected"), "true");
      await search.press("Enter"); await closed();
      assert.equal(await selected(), "24");
      assert.equal(await page.locator("#description").inputValue(), "Synthetic description 24");
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      assert.deepEqual(await scrollState(), before);
      checks.push(`${label}: ArrowDown/ArrowUp scroll only the results, Enter selects and restores focus without form submit`);

      await openResults(); await containedAndAnchored();
      await list.hover(); await page.mouse.wheel(0, 600);
      await page.waitForFunction(() => document.querySelector('[role="listbox"]')!.scrollTop > 0);
      assert.deepEqual(await scrollState(), before);
      const last = page.getByRole("option", { name: "Synthetic product 25 (25)", exact: true });
      await last.click(); await closed();
      assert.equal(await selected(), "25");
      assert.deepEqual(await scrollState(), before);
      checks.push(`${label}: wheel scrolling and ordinary last-result mouse selection stay inside the popup`);

      await openResults(); await search.press("Escape"); await closed();
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      await trigger.press("ArrowDown"); await search.press("Tab"); await closed();
      assert.equal(await page.getByRole("button", { name: "Clear item 1 product" }).evaluate(element => element === document.activeElement), true);
      await trigger.press("ArrowUp"); await search.press("Shift+Tab"); await closed();
      assert.equal(await page.locator("#before-picker").evaluate(element => element === document.activeElement), true);
      await align(size.height - 70);
      await openResults(); await page.locator("#outside-picker").click(); await closed();
      assert.equal(await selected(), "25");
      checks.push(`${label}: repeated reopening, Escape, outside dismissal and forward/reverse Tab preserve selection and control order`);

      await align(70); await openResults(); await containedAndAnchored();
      const bounds = await popup.boundingBox(), anchor = await trigger.boundingBox();
      assert.ok(bounds && anchor && Math.abs(bounds.y - anchor.y - anchor.height) < 2);
      await page.locator("#table-scroll").evaluate(element => { element.scrollLeft = 70; });
      await containedAndAnchored();
      await page.evaluate(() => window.scrollBy({ top: 20, behavior: "instant" }));
      await containedAndAnchored();
      await page.screenshot({ path: join(directory, `picker-${label}.png`) });
      await page.locator("#table-scroll").evaluate(element => { element.scrollLeft = 600; });
      await closed();
      assert.equal(await selected(), "25");
      checks.push(`${label}: upper-edge placement follows document/table scrolling and closes when its anchor leaves view`);
    }

    await page.setViewportSize({ width: 768, height: 900 });
    await page.locator("#table-scroll").evaluate(element => { element.scrollLeft = 0; });
    await align(70); await openResults(); await containedAndAnchored();
    await page.setViewportSize({ width: 390, height: 500 });
    await containedAndAnchored();
    await page.getByRole("option", { name: "Synthetic product 01 (1)", exact: true }).click(); await closed();
    assert.equal(await selected(), "1");
    checks.push("Open popup repositions on viewport resize from tablet to narrow phone and remains ordinarily clickable");
    assert.equal(await page.evaluate(() => (window as Window & { submissions?: number }).submissions ?? 0), 0);
    assert.deepEqual(failures, []);
    checks.push("Only intercepted synthetic GETs; no websocket, external request, browser error or form submission");
    passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", checks, failures, requests,
      scope: "Actual ProductSearch and current theme in synthetic long quotation fixture. Desktop Chromium viewport emulation, not physical-device acceptance; no running application, credentials, database or business writes." }, null, 2), { flag: "wx" });
    t.diagnostic("Product picker viewport evidence: " + directory);
  }
});
