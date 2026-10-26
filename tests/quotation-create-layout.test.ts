import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

// Synthetic component browser only: intercepted saves, no CRM credentials, database, or application writes.
const origin = "http://127.0.0.1:39996";
const user = { localUserId: "999", username: "Synthetic admin", email: "layout@example.invalid",
  permissions: ["dashboard.view", "leads.manage", "items.view"] };
const candidate = { id: "7", taskId: "7", dealName: "Synthetic Deal", dealNumber: "DEMO-7", accountName: "Synthetic Account", version: 1 };
const product = { id: "101", externalId: "101", name: "Synthetic Item", description: "Fixture description", unitPrice: "100",
  version: 1, createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z" };

test("original create-quotation form is visible without an eligible deal and keeps the guarded selection flow", { timeout: 90_000 }, async t => {
  const directory = resolve(".local-data", "reports", `quotation-create-layout-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const styles = ["src/app/globals.css", ...["jquery.dataTables.min.css", "plugins/phosphor-icons.css", "plugins/tabler-icons.min.css",
    "hrms.css", "style.css", "select2.min.css"].map((file) => "public/legacy/assets/css/" + file)];
  const entry = `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {QuotationCreateForm} from './src/components/crm/quotation-create-form';createRoot(document.getElementById('root')).render(<CrmChrome user={${JSON.stringify(user)}}><QuotationCreateForm/></CrmChrome>);`;
  const bundle = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false,
    format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-component-stubs", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return '/quotations/new'};export function useSearchParams(){return new URLSearchParams()}"
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  // Embed the unchanged local icon fonts so the source-theme capture includes
  // actual icons while retaining an entirely intercepted, offline browser.
  const iconFonts = await Promise.all([
    ["Phosphor", "public/legacy/assets/css/plugins/Phosphor.woff2"],
    ["tabler-icons", "public/legacy/assets/css/plugins/fonts/tabler-icons.woff2"],
  ].map(async ([family, file]) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${(await readFile(file!)).toString("base64")}) format("woff2");font-weight:normal;font-style:normal;}`));
  const css = (await Promise.all(styles.map((file) => readFile(file, "utf8"))))
    .join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "") + iconFonts.join("\n");
  const browser = await chromium.launch({ headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-domain-reliability", "--disable-sync",
      "--no-first-run", "--safebrowsing-disable-auto-update", "--disable-default-apps", "--metrics-recording-only",
      "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication"] });
  const page = await browser.newPage({ viewport: { width: 1592, height: 1100 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const failures: string[] = [];
  let syntheticSaves = 0;
  await page.routeWebSocket("**/*", socket => { failures.push("unexpected websocket"); socket.close(); });
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { failures.push("unexpected origin"); return route.abort(); }
    if (url.pathname === "/api/quotations" && request.method() === "POST") {
      const submitted = request.postDataJSON() as { taskId: string; quotation: { discountType: string } };
      assert.equal(submitted.taskId, "7");
      assert.equal(submitted.quotation.discountType, "percentage");
      syntheticSaves++;
      return route.fulfill({ json: { taskId: "7", version: 2 } });
    }
    if (request.method() !== "GET") { failures.push("unexpected method"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-sidebar-caption="true" data-pc-theme="light" data-pc-direction="ltr"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/capabilities") return route.fulfill({ json: { persistence: "local-demo", localWorkflow: true,
      productCreate: false, leadNotes: false, integrationAvailable: false } });
    if (url.pathname === "/api/quotations/candidates") {
      const query = url.searchParams.get("query") ?? "";
      const items = /DEMO/i.test(query) ? [candidate] : query === "DUP"
        ? [{ ...candidate, dealNumber: "DUP" }, { ...candidate, id: "8", taskId: "8", dealNumber: "DUP" }] : [];
      return route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 25 } });
    }
    if (url.pathname === "/api/quotations/7/capabilities") return route.fulfill({ json: { taskVersion: 1, quoteVersion: null,
      canCreate: true, canEdit: false, integrationAvailable: false, discountedEditBlocked: false, persistence: "local-demo" } });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "synthetic-component-challenge" } });
    if (url.pathname === "/api/quotations/7") return route.fulfill({ json: { id: "1", taskId: "7", quoteNumber: "SYNTHETIC-1", pdfAvailable: false } });
    if (url.pathname === "/api/items") {
      const query = url.searchParams.get("query") ?? "";
      const items = /Synt/i.test(query) ? [product] : [];
      return route.fulfill({ json: { items, total: items.length, page: 1, pageSize: 25 } });
    }
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("unexpected route"); return route.abort();
  });
  let passed = false;
  try {
    await page.goto(origin + "/");
    await page.getByRole("heading", { name: "Deal Information" }).waitFor();
    for (const title of ["Proposal Items", "Calculation Summary", "Additional Details"]) {
      assert.equal(await page.getByRole("heading", { name: title, exact: true }).count(), 1);
    }
    assert.equal(await page.getByRole("link", { name: "Quotations", exact: true }).count() > 0, true);
    assert.equal(await page.getByRole("button", { name: "Add Item" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
    assert.equal(await page.getByLabel("Sub Total", { exact: true }).inputValue(), "0.00");
    assert.equal(await page.getByLabel("Valid Until").getAttribute("min"), new Date().toISOString().slice(0, 10));
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.fonts.check('14px "Phosphor"') && document.fonts.check('14px "tabler-icons"')), true);
    await page.screenshot({ path: join(directory, "original-create-layout-1592.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 834, height: 1112 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 834);
    await page.screenshot({ path: join(directory, "original-create-layout-834.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.screenshot({ path: join(directory, "original-create-layout-390.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 1592, height: 1100 });
    await page.getByRole("button", { name: "Add Item" }).click();
    assert.equal(await page.getByRole("row").count(), 3);
    await page.getByRole("button", { name: "Remove item 2" }).click();
    assert.equal(await page.getByRole("row").count(), 2);
    await page.getByLabel("Deal Number").fill("DEMO");
    await page.locator("datalist option[value='DEMO-7 — Synthetic Deal (7)']").waitFor({ state: "attached" });
    await page.getByLabel("Deal Number").fill("DEMO-7 — Synthetic Deal (7)");
    await page.getByLabel("Subject").fill("Synthetic proposal");
    await page.locator('label:has-text("Kind Attention") input:not([required])').waitFor();
    assert.equal(await page.getByLabel("Kind Attention").inputValue(), "");
    await page.getByLabel("Kind Attention").fill("Fixture contact");
    await page.getByRole("button", { name: "Item 1 product", exact: true }).click();
    await page.getByRole("combobox", { name: "Item 1 product search" }).fill("Synt");
    await page.getByRole("option", { name: "Synthetic Item (101)", exact: true }).click();
    await page.getByLabel("Item 1 quantity").fill("2");
    await page.getByLabel("Item 1 discount percent").fill("10");
    await page.getByLabel("Item 1 total").waitFor();
    assert.equal(await page.getByLabel("Item 1 total").inputValue(), "180.00");
    assert.equal(await page.getByLabel("Grand Total").inputValue(), "189.00");
    assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isEnabled(), true);
    await page.getByLabel("Discount (%)", { exact: true }).fill("10");
    assert.equal(await page.getByLabel("Grand Total").inputValue(), "170.10");
    for (const label of ["Item 1 discount percent", "Discount (%)"]) {
      await page.getByLabel(label, { exact: true }).fill("100.01");
      assert.equal(await page.getByLabel("Grand Total").inputValue(), "");
      assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
      assert.match(await page.getByRole("alert").innerText(), /Use decimal numbers.*discounts from 0 to 100%/);
      await page.getByLabel(label, { exact: true }).fill("-1");
      assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
      await page.getByLabel(label, { exact: true }).fill("100");
      assert.equal(await page.getByLabel("Grand Total").inputValue(), "0.00");
      await page.getByLabel(label, { exact: true }).fill("10");
    }
    for (const [label, invalid, restored] of [["Item 1 quantity", "0", "2"], ["Item 1 price", "invalid", "100"], ["Adjustment", "", "0"]]) {
      await page.getByLabel(label!, { exact: true }).fill(invalid!);
      assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
      assert.match(await page.getByRole("alert").innerText(), /Check the quotation fields/);
      await page.getByLabel(label!, { exact: true }).fill(restored!);
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isEnabled(), true);
    }
    assert.equal(await page.getByLabel("Grand Total").inputValue(), "170.10");
    await page.getByLabel("Deal Number").fill("DEMO-7");
    await page.locator("button[type=submit]:enabled").waitFor();
    assert.equal(await page.getByLabel("Deal Number").inputValue(), "DEMO-7");
    await page.getByLabel("Deal Number").fill("UNKNOWN");
    await page.getByText("No eligible deal matches this number.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
    await page.getByLabel("Deal Number").fill("DUP");
    await page.locator("datalist option[value^='DUP']").first().waitFor({ state: "attached" });
    assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
    await page.getByLabel("Deal Number").fill("DEMO-7");
    await page.locator("button[type=submit]:enabled").waitFor();
    await page.getByRole("button", { name: "Clear item 1 product", exact: true }).click();
    assert.equal(await page.getByLabel("Item 1 description").inputValue(), "");
    assert.equal(await page.getByLabel("Item 1 price", { exact: true }).inputValue(), "0");
    assert.equal(await page.getByLabel("Item 1 total").inputValue(), "0.00");
    assert.equal(await page.getByLabel("Grand Total").inputValue(), "0.00");
    assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
    await page.getByRole("button", { name: "Remove item 1" }).click();
    await page.getByRole("alert").filter({ hasText: "Add at least one item before saving the proposal." }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
    await page.getByRole("button", { name: "Add Item" }).click();
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.getByRole("button", { name: "Item 1 product", exact: true }).click();
    await page.getByRole("combobox", { name: "Item 1 product search" }).fill("Synt");
    await page.getByRole("option", { name: "Synthetic Item (101)", exact: true }).click();
    await page.getByRole("button", { name: "Save Proposal" }).click();
    await page.getByRole("heading", { name: "Quote Created Successfully" }).waitFor();
    await page.getByRole("button", { name: "OK", exact: true }).click();
    for (const label of ["Deal Number", "Subject", "Item 1 quantity", "Adjustment"]) {
      assert.equal(await page.getByLabel(label).isDisabled(), true);
    }
    assert.equal(await page.getByRole("button", { name: "Add Item" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Remove item 1" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Save Proposal" }).isDisabled(), true);
    assert.equal(syntheticSaves, 1);
    assert.deepEqual(failures, []);
    passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Synthetic React/browser source-theme create layout, guarded deal/product selection, live preview, validation and simulated save; no authentication or application writes.",
      screenshots: ["original-create-layout-1592.png", "original-create-layout-834.png", "original-create-layout-390.png"], failures }, null, 2), { flag: "wx" });
    t.diagnostic("Quotation create layout evidence: " + directory);
  }
});
