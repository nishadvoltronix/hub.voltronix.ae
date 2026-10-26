import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";

test("OFFLINE source lead status dialog preserves capability, cancel, CSRF, stale, retry and pending behavior", { timeout: 90_000 }, async t => {
  const origin = "http://127.0.0.1:39993";
  const directory = resolve(".local-data", "reports", `lead-stage-layout-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const actor = { localUserId: "999", username: "Synthetic owner", email: "layout@example.invalid", permissions: ["leads.view", "leads.manage"] };
  const bundle = await build({ stdin: { contents: `import {useState} from 'react';import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {LeadMutationControls} from './src/components/crm/lead-mutation-controls';function Fixture(){const [target,setTarget]=useState(null);return <CrmChrome user={${JSON.stringify(actor)}}><section className="card"><div className="card-header d-flex justify-content-between"><h1 className="h5">Deal Name: Synthetic deal</h1><div ref={setTarget}/></div><LeadMutationControls taskId="999" currentStatus="Site Visit" currentServiceCharge="200.00" stageActionTarget={target} onReload={()=>{}}/></section></CrmChrome>}createRoot(document.getElementById('root')).render(<Fixture/>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-component-stubs", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return '/leads/999'};export function useSearchParams(){return new URLSearchParams()}"
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  const css = (await Promise.all(["src/app/globals.css", "public/legacy/assets/css/hrms.css", "public/legacy/assets/css/style.css"].map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  let capabilities = { persistence: "local-demo", version: 4, canChangeStage: true, canWriteNotes: false, stages: ["Closed Won", "Closed Lost"], integrationAvailable: false, blockedOperationId: undefined as string | undefined };
  let writesAvailable = true, passed = false;
  const checks: string[] = [], failures: string[] = [], screenshots: string[] = [], submissions: { expectedVersion: number; stage: string; serviceCharge: string; operationId: string }[] = [];
  let pending: Route | undefined;
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { failures.push("External request"); return route.abort(); }
    if (request.method() === "PATCH" && url.pathname === "/api/leads/999/stage") {
      assert.equal(request.headers()["x-csrf-token"], "synthetic-token");
      submissions.push(request.postDataJSON()); pending = route; return;
    }
    if (request.method() !== "GET") { failures.push("Unexpected mutation"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-theme="light" data-pc-direction="ltr" data-pc-preset="preset-1" data-pc-sidebar-caption="true"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/leads/999/capabilities") return route.fulfill({ json: capabilities });
    if (url.pathname === "/api/capabilities") return route.fulfill({ json: { persistence: writesAvailable ? "local-demo" : "unavailable", localWorkflow: writesAvailable, leadNotes: false } });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "synthetic-token" } });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("Unexpected route " + url.pathname); return route.abort();
  });
  const check = async (label: string, action: () => Promise<void>) => { await action(); checks.push(label); };
  const waitPending = async () => { for (let attempts = 0; !pending && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(pending); };
  const trigger = page.getByRole("button", { name: "Update Status", exact: true });
  const dialog = page.getByRole("dialog", { name: "Update Status", exact: true });
  const selection = page.getByLabel("Next lead stage", { exact: true });
  const save = page.getByRole("button", { name: "Save lead stage", exact: true });
  try {
    await page.goto(origin);
    await trigger.waitFor(); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".card-header button")?.disabled);
    await check("Source header trigger opens a modal with original visible labels and restricted stages", async () => {
      assert.equal(await page.locator(".card-header").getByRole("button", { name: "Update Status" }).count(), 1);
      await trigger.click(); await dialog.waitFor();
      assert.equal(await save.textContent(), "Save changes");
      const closeStyle = await dialog.getByRole("button", { name: "Close status dialog" }).evaluate(element => ({ image: getComputedStyle(element).backgroundImage, color: getComputedStyle(element).backgroundColor }));
      assert.ok(closeStyle.image.startsWith("url(")); assert.equal(closeStyle.color, "rgba(0, 0, 0, 0)");
      assert.equal(await selection.locator("option[value='Proposal/Price Quote']").evaluate(option => (option as HTMLOptionElement).disabled), true);
      assert.equal(await save.isDisabled(), true);
    });
    await check("Close and Escape discard only local stage drafts and return focus without any submission", async () => {
      await selection.selectOption("Closed Won"); assert.equal(await page.getByLabel("Service charge (AED)").inputValue(), "200.00");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      assert.equal(await dialog.count(), 0); assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      await trigger.click(); assert.equal(await selection.inputValue(), ""); assert.equal(await page.getByLabel("Service charge (AED)").count(), 0);
      await page.keyboard.press("Escape"); assert.equal(await dialog.count(), 0); assert.equal(submissions.length, 0);
    });
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await trigger.click();
      await check(`Modal fits ${width}px without document overflow`, async () => {
        const rect = await dialog.boundingBox(); assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      });
      const filename = `lead-stage-${width}.png`; await page.screenshot({ path: join(directory, filename), fullPage: true, animations: "disabled" }); screenshots.push(filename);
      await page.keyboard.press("Escape");
    }
    await trigger.click(); await selection.selectOption("Closed Won"); await save.click(); await waitPending();
    await page.waitForFunction(() => document.querySelector<HTMLFieldSetElement>("dialog fieldset")?.disabled);
    await check("Pending submission blocks close, Escape and duplicate save, preserving CSRF and version", async () => {
      assert.equal(submissions.length, 1); assert.equal(submissions[0]!.expectedVersion, 4); assert.equal(submissions[0]!.serviceCharge, "200.00");
      assert.equal(await dialog.getByRole("button", { name: "Close", exact: true }).isDisabled(), true);
      await page.keyboard.press("Escape"); assert.equal(await dialog.count(), 1); assert.equal(await save.isDisabled(), true);
    });
    await pending!.fulfill({ status: 409, json: { error: "Synthetic stale version; reload before saving." } }); pending = undefined;
    await dialog.getByRole("alert").waitFor();
    await check("Stale refusal keeps the dialog draft visible and uses the same operation ID on identical retry", async () => {
      assert.equal(await selection.inputValue(), "Closed Won"); await save.click(); await waitPending();
      await page.waitForFunction(() => document.querySelector<HTMLFieldSetElement>("dialog fieldset")?.disabled);
      assert.equal(submissions.length, 2); assert.equal(submissions[1]!.operationId, submissions[0]!.operationId);
    });
    capabilities = { ...capabilities, version: 5, stages: [] };
    await pending!.fulfill({ json: { taskId: "999", version: 5, operationId: submissions[1]!.operationId, persistence: "local-demo" } }); pending = undefined;
    await page.getByText("Saved locally. Not synchronized with Zoho.", { exact: true }).waitFor();
    await check("Successful receipt closes the dialog, reloads capabilities and disables unsupported next transitions", async () => {
      assert.equal(await dialog.count(), 0); await trigger.waitFor(); assert.equal(await trigger.isDisabled(), true);
    });
    for (const [name, update] of [
      ["Reconciliation guard", () => { capabilities = { ...capabilities, stages: ["Closed Lost"], blockedOperationId: "synthetic-reconciliation" }; }],
      ["Unavailable write adapter", () => { capabilities = { ...capabilities, blockedOperationId: undefined }; writesAvailable = false; }],
    ] as const) {
      update(); await page.getByRole("button", { name: "Reload lead", exact: true }).click(); await trigger.waitFor();
      await check(name + " leaves the trigger disabled", async () => assert.equal(await trigger.isDisabled(), true));
    }
    capabilities = { ...capabilities, canChangeStage: false }; await page.getByRole("button", { name: "Reload lead", exact: true }).click();
    await page.getByText("Your account can read this lead but cannot change it.").waitFor();
    await check("Read-only capabilities expose no stage trigger or stage submit", async () => { assert.equal(await trigger.count(), 0); assert.equal(await save.count(), 0); });
    assert.deepEqual(failures, []); passed = true;
  } finally {
    if (pending) await pending.abort();
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Isolated source-theme React fixture. All GET/PATCH/CSRF requests intercepted; no credentials, local server, database or actual business writes. Synthetic responses do not establish live mutation acceptance.", checks, checkCount: checks.length, screenshots, syntheticSubmissionCount: submissions.length, failures }, null, 2), { flag: "wx" });
    t.diagnostic("Lead status layout evidence: " + directory);
  }
});
