import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { calculateQuotation, parseQuotationInput } from "../src/server/commercial/quotations";

// Actual React editor with synthetic GET responses only; no credentials, database or saves.
const origin = "http://127.0.0.1:39995";
const longProductName = "Synthetic electrical installation and commissioning product with a deliberately long saved name";
const quotation = parseQuotationInput({ subject: "Synthetic saved quotation", kindAttention: "Fixture contact",
  discount: "0", adjustment: "0", items: [{ productId: "101", productName: longProductName, description: "Fixture description",
    uom: "NOS", quantity: "2", unitPrice: "100", itemDiscount: "0" }] });
const quote = { id: "1", taskId: "7", quoteNumber: "SYNTHETIC-1", externalId: null, version: 1, taskVersion: 3,
  persistence: "local-demo", calculationPolicy: "percentage-only-v2", createdAt: "2026-10-12T22:30:00Z", quotation, totals: calculateQuotation(quotation, "percentage"),
  task: { dealNumber: "SYNTHETIC-7" } };

test("source-layout quotation editor uses percentages and preserves historical discounts and edit guards", { timeout: 90_000 }, async t => {
  const directory = resolve(".local-data", "reports", `quotation-edit-preview-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const entry = `import {createRoot} from 'react-dom/client';import {QuotationForm} from './src/components/crm/quotation-form';
    import {CrmChrome} from './src/components/crm/chrome';
    import {QuotationDetails} from './src/components/crm/quotations';
    import {calculateSavedQuotation} from './src/server/commercial/quotations';
    const quote=${JSON.stringify(quote)};
    const scenario=new URLSearchParams(location.search).get('case');
    if(scenario==='discounted'||scenario==='historical-header'||scenario==='historical-zero'||scenario==='details-historical'||scenario==='details-historical-zero'){
      quote.calculationPolicy='percentage-create-v1';delete quote.quotation.discountType;
      if(scenario==='discounted')quote.quotation.items[0].itemDiscount='10';
      else if(!scenario.endsWith('zero')) quote.quotation.discount='10';
      quote.totals=calculateSavedQuotation(quote.quotation,quote.calculationPolicy);
    }
    if(scenario==='details-percentage'){quote.quotation.discount='10';quote.totals=calculateSavedQuotation(quote.quotation,quote.calculationPolicy);}
    createRoot(document.getElementById('root')).render(<CrmChrome user={{localUserId:'999',username:'Synthetic admin',email:'layout@example.invalid',permissions:['dashboard.view','leads.manage','items.view']}}>{scenario?.startsWith('details-')?<QuotationDetails quote={quote}/>:<QuotationForm quote={quote}/>}</CrmChrome>);`;
  const bundle = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
    format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-editor-stubs", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function useRouter(){return{refresh(){}}};export function usePathname(){return '/quotations/7/edit'};export function useSearchParams(){return new URLSearchParams()}"
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}",
      loader: "js", resolveDir: process.cwd() }));
    } }] });
  const styles = ["src/app/globals.css", ...["jquery.dataTables.min.css", "plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css", "select2.min.css"].map(file => "public/legacy/assets/css/" + file)];
  const iconFonts = await Promise.all([["Phosphor", "public/legacy/assets/css/plugins/Phosphor.woff2"], ["tabler-icons", "public/legacy/assets/css/plugins/fonts/tabler-icons.woff2"]]
    .map(async ([family, file]) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${(await readFile(file!)).toString("base64")}) format("woff2");font-weight:normal;font-style:normal;}`));
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "") + iconFonts.join("\n");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1592, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const failures: string[] = [], checks: string[] = [];
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { failures.push("unexpected method or origin"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html",
      body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-sidebar-caption="true" data-pc-theme="light" data-pc-direction="ltr"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    const scenario = new URL(page.url()).searchParams.get("case");
    if (url.pathname === "/api/capabilities") return route.fulfill({ json: { persistence: "local-demo", localWorkflow: scenario !== "unavailable" } });
    if (url.pathname === "/api/quotations/7/capabilities") return route.fulfill({ json: {
      taskVersion: scenario === "stale" ? 4 : 3, quoteVersion: 1, canCreate: false, canEdit: scenario !== "discounted",
      integrationAvailable: false, discountedEditBlocked: scenario === "discounted" || scenario === "details-historical-zero", persistence: "local-demo" } });
    if (url.pathname === "/api/items") return route.fulfill({ json: { items: [{ id: "102", externalId: "102", name: "Additional fixture item", description: "Synthetic", unitPrice: "50" }], total: 1, page: 1, pageSize: 25 } });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("unexpected route"); return route.abort();
  });
  let passed = false;
  try {
    await page.goto(origin + "/");
    await page.getByLabel("Item 1 quantity", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLFieldSetElement>("fieldset")?.disabled);
    assert.equal(await page.getByLabel("Preview subtotal (AED)", { exact: true }).inputValue(), "200.00");
    assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "210.00");
    assert.equal(await page.getByRole("button", { name: "Calculate preview totals" }).count(), 0);
    assert.equal(await page.getByLabel("Recorded creation date (Dubai)", { exact: true }).inputValue(), "2026-10-13");
    assert.equal(await page.getByLabel("Recorded creation date (Dubai)", { exact: true }).evaluate((input: HTMLInputElement) => input.readOnly), true);
    assert.equal(await page.getByLabel("Quotation Date", { exact: true }).count(), 0);
    checks.push("saved creation metadata displays the Dubai date across UTC midnight without inventing an editable quotation date");
    checks.push("saved canonical totals visible before editing without a manual calculate action");

    assert.deepEqual(await page.locator(".crm-quotation-edit-items th").allTextContents(), ["#", "Product Name", "Description", "UOM", "Qty", "Unit Price", "Discount %", "Total", "Action"]);
    await page.waitForFunction(() => {
      const add = document.querySelector(".quotation-edit-form .btn-purple");
      return add && getComputedStyle(add).backgroundColor === "rgb(163, 137, 212)";
    });
    assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).textContent(), "Update Quotation");
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1592, 834, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const picker = page.getByRole("button", { name: "Item 1 product", exact: true });
      const bounds = await picker.evaluate(element => {
        const region = element.closest(".table-responsive")!;
        region.scrollLeft = 0;
        const rect = element.getBoundingClientRect(), container = region.getBoundingClientRect();
        const clear = element.parentElement!.querySelector(".crm-product-clear")!.getBoundingClientRect();
        const caret = element.querySelector(".crm-product-caret")!.getBoundingClientRect();
        const label = element.querySelector("span")!;
        return { left: rect.left, right: rect.right, width: rect.width, regionLeft: container.left, regionRight: container.right,
          clearRight: clear.right, caretRight: caret.right, labelClipped: label.scrollWidth > label.clientWidth };
      });
      assert.ok(bounds.width <= 230.5, `long product picker remains bounded at ${width}px: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.left >= bounds.regionLeft && bounds.right <= bounds.regionRight + 1, `picker fits the visible table at ${width}px`);
      assert.ok(bounds.clearRight <= bounds.regionRight && bounds.caretRight <= bounds.regionRight, "clear and dropdown controls remain visible");
      assert.equal(bounds.labelClipped, true, "long product name is visually truncated");
      assert.equal(await picker.getAttribute("title"), longProductName);
      assert.equal(await picker.evaluate(element => document.getElementById(element.getAttribute("aria-describedby")!)?.textContent), longProductName);
      if (width === 360) {
        await picker.click();
        const search = page.getByRole("combobox", { name: "Item 1 product search" });
        await search.fill("Additional");
        await page.getByRole("option", { name: "Additional fixture item (102)", exact: true }).waitFor();
        const popup = await page.locator(".crm-product-dropdown").boundingBox();
        assert.ok(popup && popup.x >= 0 && popup.x + popup.width <= width, "mobile picker results remain in the viewport");
        await search.press("Escape");
        assert.equal(await picker.getAttribute("aria-expanded"), "false");
        assert.equal(await picker.evaluate(element => element === document.activeElement), true);
      }
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({ path: join(directory, `quotation-edit-${width}.png`), fullPage: true, animations: "disabled" });
    }
    await page.setViewportSize({ width: 1592, height: 1000 });
    checks.push("original edit card, separate product/description columns, source purple Add Item and Update Quotation; desktop/tablet/phone have no page overflow");
    checks.push("long product label truncates without hiding clear/caret; full accessible description and mobile search/Escape remain available");

    await page.getByLabel("Item 1 quantity", { exact: true }).fill("3");
    assert.equal(await page.getByLabel("Preview subtotal (AED)", { exact: true }).inputValue(), "300.00");
    await page.getByLabel("Discount (%)", { exact: true }).fill("5");
    await page.getByLabel("Adjustment (AED)", { exact: true }).fill("-1");
    assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "298.25");
    await page.getByLabel("Quotation subject", { exact: true }).fill("");
    assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "298.25");
    await page.getByLabel("Quotation subject", { exact: true }).fill("Synthetic draft");
    checks.push("quantity, header discount and adjustment update immediately; empty metadata does not erase arithmetic");
    await page.getByLabel("Kind attention", { exact: true }).fill("");
    assert.equal(await page.getByLabel("Kind attention", { exact: true }).evaluate((element: HTMLInputElement) => element.required), false);
    assert.equal(await page.locator("form.crm-quotation-form").evaluate((element: HTMLFormElement) => element.checkValidity()), true);
    assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).isEnabled(), true);
    checks.push("explicit local editor accepts blank attention without creating a replacement name");

    await page.getByLabel("Item 1 unit price", { exact: true }).fill("invalid");
    assert.equal(await page.getByLabel("Preview subtotal (AED)", { exact: true }).inputValue(), "");
    await page.getByText("Enter valid quantities and amounts, with discounts from 0 to 100%, to preview totals.", { exact: true }).waitFor();
    await page.getByLabel("Item 1 unit price", { exact: true }).fill("100");
    assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "298.25");
    checks.push("invalid numeric draft clears stale totals and recovers when corrected");

    await page.getByRole("button", { name: "Add Item", exact: true }).click();
    await page.getByLabel("Item 2 quantity", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Item 2 product", exact: true }).click();
    await page.getByRole("combobox", { name: "Item 2 product search" }).fill("Additional");
    await page.getByRole("option", { name: "Additional fixture item (102)", exact: true }).click();
    assert.equal(await page.getByLabel("Preview subtotal (AED)", { exact: true }).inputValue(), "350.00");
    await page.getByRole("button", { name: "Remove item 2", exact: true }).click();
    assert.equal(await page.getByLabel("Preview subtotal (AED)", { exact: true }).inputValue(), "300.00");
    checks.push("adding and removing a saved product immediately refreshes totals");

    await page.getByLabel("Item 1 discount (%)", { exact: true }).fill("10");
    assert.equal(await page.getByLabel("Preview subtotal (AED)", { exact: true }).inputValue(), "270.00");
    assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "268.33");
    assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).isEnabled(), true);
    checks.push("proven percentage-policy line discount 10 and header discount 5 enable an authorized local edit with exact totals");
    for (const label of ["Item 1 discount (%)", "Discount (%)"]) {
      for (const value of ["-1", "100.01"]) {
        await page.getByLabel(label, { exact: true }).fill(value);
        assert.equal(await page.getByLabel("Preview subtotal (AED)", { exact: true }).inputValue(), "");
        assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).isDisabled(), true);
        assert.equal(await page.locator("form.crm-quotation-form").evaluate((form: HTMLFormElement) => form.checkValidity()), false);
      }
      await page.getByLabel(label, { exact: true }).fill("100");
      assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "-1.00");
      await page.getByLabel(label, { exact: true }).fill(label.startsWith("Item") ? "10" : "5");
    }
    checks.push("line and header percentage bounds reject negative/over-100 values and accept the 100% boundary");

    for (const scenario of ["discounted", "historical-header", "historical-zero", "stale", "unavailable"]) {
      await page.goto(origin + "/?case=" + scenario);
      const alert = ["discounted", "historical-header", "historical-zero"].includes(scenario) ? "This saved quotation uses an earlier calculation policy" : scenario === "stale" ? "The saved quotation changed" : "It is not synchronized with Zoho.";
      if (scenario !== "unavailable") await page.getByRole(scenario === "stale" ? "alert" : "status").filter({ hasText: alert }).waitFor();
      else await page.getByText("Saving is unavailable for this record until an approved Zoho connection is verified. Previewing does not save changes.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Save quotation", exact: true }).isDisabled(), true);
      if (scenario !== "unavailable") assert.equal(await page.getByLabel("Item 1 quantity", { exact: true }).isDisabled(), true);
      if (scenario === "discounted") assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "189.00");
      if (scenario === "historical-header") {
        assert.equal(await page.getByLabel("Saved header discount (AED)", { exact: true }).inputValue(), "10");
        assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "199.50");
      }
      if (scenario === "historical-zero") {
        assert.equal(await page.getByLabel("Saved header discount (AED)", { exact: true }).inputValue(), "0");
        assert.equal(await page.getByLabel("Preview grand total (AED)", { exact: true }).inputValue(), "210.00");
        assert.equal(await page.getByRole("button", { name: "Item 1 product", exact: true }).isDisabled(), true);
        assert.equal(await page.getByLabel("Discount (%)", { exact: true }).count(), 0);
      }
      checks.push(scenario + " edit guard remains enforced");
    }
    await page.goto(origin + "/?case=details-percentage");
    const amount = (label: string) => page.locator(".record-fields > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
    await amount("Discount (%)").waitFor();
    assert.equal(await amount("Discount (%)").textContent(), "10");
    assert.equal(await amount("Discount amount (AED)").textContent(), "20");
    assert.equal(await amount("Grand total (AED)").textContent(), "189.00");
    await page.goto(origin + "/?case=details-historical");
    await amount("Saved header discount (AED)").waitFor();
    assert.equal(await amount("Saved header discount (AED)").textContent(), "10");
    assert.equal(await amount("Grand total (AED)").textContent(), "199.50");
    assert.equal(await page.getByText("Discount (%)", { exact: true }).count(), 1); // Existing line-percent column only.
    assert.equal(await amount("Discount (%)").count(), 0);
    checks.push("saved detail displays new percentage and deduction separately; historical header remains AED with its original total");
    await page.goto(origin + "/?case=details-historical-zero");
    await page.getByRole("status").filter({ hasText: "uses an earlier calculation policy" }).waitFor();
    assert.equal(await amount("Saved header discount (AED)").textContent(), "0");
    assert.equal(await amount("Grand total (AED)").textContent(), "210.00");
    assert.equal(await page.getByText("has historical discounts", { exact: false }).count(), 0);
    checks.push("historical zero-discount provenance remains readonly and never claims nonexistent discounts or percentage header units");
    assert.deepEqual(failures, []);
    passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL",
      scope: "Synthetic React/browser source edit layout, percentage live preview, range and historical guards. No authentication, database access or saves.",
      screenshots: ["quotation-edit-1592.png", "quotation-edit-834.png", "quotation-edit-390.png", "quotation-edit-360.png"], checks, failures }, null, 2), { flag: "wx" });
    t.diagnostic("Quotation edit preview evidence: " + directory);
  }
});
