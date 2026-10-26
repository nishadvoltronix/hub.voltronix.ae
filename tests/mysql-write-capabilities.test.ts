import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { isLocalPersistence } from "@voltronix/crm-contracts";

test("local persistence discriminator accepts only explicit demo and MySQL provenance", () => {
  assert.equal(isLocalPersistence("local-mysql"), true);
  assert.equal(isLocalPersistence("local-demo"), true);
  for (const value of [undefined, null, "mysql", "unavailable", "zoho", true]) assert.equal(isLocalPersistence(value), false);
});

test("OFFLINE MySQL and SQLite write controls retain explicit capabilities and no-sync notices", { timeout: 30_000 }, async () => {
  const origin = "http://127.0.0.1:39992";
  const bundle = await build({ stdin: {
    contents: "import {createRoot} from 'react-dom/client';import {DealForm} from './src/components/crm/deal-form';import {ProductCreate} from './src/components/crm/products';createRoot(document.getElementById('root')).render(<><DealForm/><ProductCreate/></>);",
    loader: "tsx", resolveDir: process.cwd(),
  }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
      ? "export function useRouter(){return{refresh(){},push(){}}}"
      : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mode of ["unavailable", "local-mysql", "local-demo", "revoked", "zoho", "zoho-unverified", "zoho-read-only", "zoho-denied"] as const) {
      const page = await browser.newPage({ serviceWorkers: "block" }), failures: string[] = [];
      let allowDealWrite = false;
      const dealWrites: Record<string, unknown>[] = [];
      page.on("pageerror", error => failures.push(error.message));
      await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { failures.push("Unexpected request"); return route.abort(); }
        if (allowDealWrite && url.pathname === "/api/deals" && request.method() === "POST") {
          const payload = request.postDataJSON() as Record<string, unknown>;
          dealWrites.push(payload);
          return route.fulfill({ json: { operationId: payload.operationId, taskId: "501", version: 1, persistence: "zoho", remoteVerified: true } });
        }
        if (request.method() !== "GET") { failures.push("Unexpected request"); return route.abort(); }
        if (allowDealWrite && url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "offline-csrf-token" } });
        if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!DOCTYPE html><html><body><div id='root'></div><script src='/component.js'></script></body></html>" });
        if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
        if (url.pathname === "/api/capabilities") return route.fulfill({ json: {
          persistence: mode.startsWith("zoho") ? "zoho" : mode === "revoked" ? "local-mysql" : mode, localWorkflow: true,
          productCreate: mode !== "revoked" && mode !== "zoho-denied", dealCreate: mode !== "revoked" && mode !== "zoho-denied", leadNotes: false,
          remoteWorkflow: mode !== "zoho-read-only", integrationAvailable: mode.startsWith("zoho") && mode !== "zoho-unverified",
        } });
        failures.push("Unexpected path"); return route.abort();
      });
      await page.goto(origin);
      await page.waitForFunction(() => !document.body.textContent?.includes("Loading available"));
      const enabled = mode === "local-mysql" || mode === "local-demo" || mode === "zoho";
      assert.equal(await page.getByRole("button", { name: "Save Deal", exact: true }).isEnabled(), enabled);
      assert.equal(await page.getByRole("button", { name: "Save Item", exact: true }).isEnabled(), enabled);
      if (mode === "local-mysql" || mode === "local-demo") {
        assert.match(await page.locator("body").innerText(), /not synchronized with Zoho/);
        assert.equal(await page.getByLabel("Expected closing date").count(), 0);
      }
      if (mode === "zoho") {
        assert.match(await page.locator("body").innerText(), /saved in Zoho/);
        for (const [name, maximum] of Object.entries({ firstName: 40, lastName: 80, email: 100, phone: 30, mobile: 30, address: 250 })) {
          assert.equal(await page.locator(`[name="${name}"]`).getAttribute("maxlength"), String(maximum));
        }
        for (const [name, value] of Object.entries({ firstName: "A".repeat(40), lastName: "B".repeat(80), companyName: "Synthetic company",
          email: "fixture@example.invalid", mobile: "0000000000", phone: "0000000000" })) await page.locator(`input[name="${name}"]`).fill(value);
        await page.locator('select[name="department"]').selectOption({ label: "VOLTRONIX CONTRACTING LLC" });
        const closingDate = page.getByLabel("Expected closing date");
        assert.equal(await closingDate.getAttribute("type"), "date");
        assert.equal(await closingDate.getAttribute("required"), "");
        await page.getByRole("button", { name: "Save Deal", exact: true }).click();
        assert.equal(await closingDate.evaluate((input: HTMLInputElement) => input.validity.valueMissing), true);
        await closingDate.fill("2026-10-31");
        await page.getByRole("button", { name: "Save Deal", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "combined first and last name" }).waitFor();
        assert.equal(dealWrites.length, 0);
        await page.locator('input[name="firstName"]').fill("Test");
        await page.locator('input[name="lastName"]').fill("Customer");
        allowDealWrite = true;
        await page.getByRole("button", { name: "Save Deal", exact: true }).click();
        await page.getByRole("status").filter({ hasText: "Saved in Zoho and verified." }).waitFor();
        assert.equal(dealWrites.length, 1);
        assert.equal(dealWrites[0]!.closingDate, "2026-10-31");
      }
      assert.deepEqual(failures, []); await page.close();
    }
  } finally { await browser.close(); }
});
