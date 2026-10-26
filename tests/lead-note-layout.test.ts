import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";

test("OFFLINE source lead note modals preserve header/row actions, drafts, CSRF, version and retries", { timeout: 90_000 }, async t => {
  const origin = "http://127.0.0.1:39992", directory = resolve(".local-data", "reports", `lead-note-layout-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const actor = { localUserId: "999", username: "Synthetic owner", email: "layout@example.invalid", permissions: ["leads.view", "leads.manage"] };
  const lead = { id: "999", dealName: "Synthetic modal lead", status: "Qualification", persistence: "local-demo", assignedName: "Synthetic owner", createdAt: "2026-10-13T08:00:00Z", updatedAt: "2026-10-13T08:00:00Z" };
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {LeadDetails} from './src/components/crm/lead-details';createRoot(document.getElementById('root')).render(<CrmChrome user={${JSON.stringify(actor)}}><LeadDetails lead={${JSON.stringify(lead)}}/></CrmChrome>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
      ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return '/leads/999'};export function useSearchParams(){return new URLSearchParams()}"
      : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
        : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const styles = ["src/app/globals.css", ...["plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css"].map(file => "public/legacy/assets/css/" + file)];
  const fonts = await Promise.all([["Phosphor", "public/legacy/assets/css/plugins/Phosphor.woff2"], ["tabler-icons", "public/legacy/assets/css/plugins/fonts/tabler-icons.woff2"]].map(async ([family, file]) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${(await readFile(file!)).toString("base64")}) format("woff2");font-weight:normal;font-style:normal;}`));
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "") + fonts.join("\n");
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const checks: string[] = [], failures: string[] = [], screenshots: string[] = [], submissions: { method: string; path: string; body: { title: string; content: string; expectedVersion: number; operationId: string } }[] = [];
  let notes: { id: string; title: string; content: string; updatedAt: string }[] = [], version = 4, writable = true, blockedOperationId: string | undefined, adapter = true, pending: Route | undefined, passed = false;
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { failures.push("External request"); return route.abort(); }
    if (["POST", "PATCH"].includes(request.method()) && /^\/api\/leads\/999\/notes(?:\/42)?$/.test(url.pathname)) {
      assert.equal(request.headers()["x-csrf-token"], "synthetic-token"); submissions.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() }); pending = route; return;
    }
    if (request.method() !== "GET") { failures.push("Unexpected mutation"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-theme="light" data-pc-direction="ltr" data-pc-preset="preset-1" data-pc-sidebar-caption="true"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/leads/999/capabilities") return route.fulfill({ json: { persistence: "local-demo", version, canChangeStage: false, canWriteNotes: writable, stages: [], integrationAvailable: false, blockedOperationId } });
    if (url.pathname === "/api/capabilities") return route.fulfill({ json: { persistence: adapter ? "local-demo" : "unavailable", leadNotes: adapter, localWorkflow: false } });
    if (url.pathname === "/api/leads/999/notes") return route.fulfill({ json: { items: notes, total: notes.length, page: 1, pageSize: 25 } });
    if (/^\/api\/leads\/999\/(?:history|attachments)$/.test(url.pathname)) return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25, canUpload: false, version } });
    if (url.pathname === "/api/quotations/999/capabilities") return route.fulfill({ json: { persistence: "local-demo", quoteVersion: null, canCreate: false } });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "synthetic-token" } });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("Unexpected route " + url.pathname); return route.abort();
  });
  const check = async (name: string, action: () => Promise<void>) => { await action(); checks.push(name); };
  const waitPending = async () => { for (let attempts = 0; !pending && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(pending); };
  const add = page.getByRole("button", { name: "Add Note", exact: true }), addDialog = page.getByRole("dialog", { name: "Add Notes", exact: true });
  const edit = () => page.getByRole("button", { name: /^Edit note:/ }), editDialog = page.getByRole("dialog", { name: "Edit Your Notes", exact: true });
  const noteRegion = page.getByRole("region", { name: "Lead notes", exact: true });
  const capture = async (name: string) => { await page.evaluate(async () => { await document.fonts.ready; (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }); await page.screenshot({ path: join(directory, name), fullPage: true, animations: "disabled" }); screenshots.push(name); };
  try {
    await page.goto(origin); await add.waitFor();
    await check("Source Add Note action is placed in the actual notes header and opens Add Notes", async () => {
      assert.equal(await noteRegion.locator(".card-header").getByRole("button", { name: "Add Note", exact: true }).count(), 1);
      await add.click(); await addDialog.waitFor(); assert.equal((await addDialog.getByRole("button", { name: "Add lead note", exact: true }).textContent())!.trim(), "Save Note");
      assert.equal(await page.getByLabel("New note title", { exact: true }).inputValue(), "");
    });
    await check("Empty required draft cannot submit and Close discards only unsaved fields", async () => {
      await addDialog.getByRole("button", { name: "Add lead note", exact: true }).click(); assert.equal(submissions.length, 0);
      await page.getByLabel("New note title", { exact: true }).fill("Discard this"); await page.getByLabel("New note content", { exact: true }).fill("Unsubmitted text");
      await addDialog.getByRole("button", { name: "Close", exact: true }).click(); assert.equal(await addDialog.count(), 0);
      assert.equal(await add.evaluate(element => element === document.activeElement), true); await add.click();
      assert.equal(await page.getByLabel("New note title", { exact: true }).inputValue(), ""); assert.equal(submissions.length, 0);
    });
    await page.getByLabel("New note title", { exact: true }).fill("Synthetic saved note"); await page.getByLabel("New note content", { exact: true }).fill("Synthetic original content");
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await check(`Add modal fits ${width}px`, async () => { const box = await addDialog.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width); });
      await capture(`lead-note-add-${width}.png`);
    }
    await addDialog.getByRole("button", { name: "Add lead note", exact: true }).click(); await waitPending();
    await check("Pending note creation carries CSRF/version and blocks Close, Escape and duplicate submit", async () => {
      assert.equal(submissions.length, 1); assert.equal(submissions[0]!.body.expectedVersion, 4); assert.equal(submissions[0]!.method, "POST");
      assert.equal(await addDialog.getByRole("button", { name: "Close", exact: true }).isDisabled(), true); await page.keyboard.press("Escape"); assert.equal(await addDialog.count(), 1);
      assert.equal(await addDialog.getByRole("button", { name: "Add lead note", exact: true }).isDisabled(), true);
    });
    await pending!.fulfill({ status: 503, json: { error: "Synthetic temporary write refusal" } }); pending = undefined; await addDialog.getByRole("alert").waitFor();
    await check("Failed creation retains draft and retries with the same operation identifier", async () => {
      assert.equal(await page.getByLabel("New note content", { exact: true }).inputValue(), "Synthetic original content");
      await addDialog.getByRole("button", { name: "Add lead note", exact: true }).click(); await waitPending();
      assert.equal(submissions[1]!.body.operationId, submissions[0]!.body.operationId);
    });
    notes = [{ id: "42", title: submissions[1]!.body.title, content: submissions[1]!.body.content, updatedAt: "2026-10-13T08:01:00Z" }]; version = 5;
    await pending!.fulfill({ status: 201, json: { taskId: "999", noteId: "42", version, operationId: submissions[1]!.body.operationId } }); pending = undefined; await edit().waitFor();
    await check("Successful receipt closes Add Notes and places original Edit Note action beside saved content", async () => {
      assert.equal(await addDialog.count(), 0); assert.equal(await noteRegion.locator("article").getByRole("button", { name: "Edit note: Synthetic saved note", exact: true }).count(), 1);
      await edit().click(); await editDialog.waitFor(); assert.equal(await page.getByLabel("Edit note title", { exact: true }).inputValue(), "Synthetic saved note");
      assert.equal(await page.getByLabel("Edit note title", { exact: true }).evaluate(element => (element as HTMLInputElement).readOnly), true);
      assert.equal(await page.getByLabel("Edit note content", { exact: true }).inputValue(), "Synthetic original content");
      assert.equal(await editDialog.getByRole("button", { name: "Save lead note", exact: true }).textContent(), "Save changes");
    });
    for (const width of [1440, 768, 390]) { await page.setViewportSize({ width, height: 1000 }); await check(`Edit modal fits ${width}px`, async () => { const box = await editDialog.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width); }); await capture(`lead-note-edit-${width}.png`); }
    await check("Escape from edited draft leaves saved content untouched", async () => {
      await page.getByLabel("Edit note content", { exact: true }).fill("Unsaved edit"); await page.keyboard.press("Escape"); assert.equal(await editDialog.count(), 0);
      assert.equal(await noteRegion.locator("article .preserve-lines").textContent(), "Synthetic original content"); assert.equal(submissions.length, 2);
    });
    await edit().click(); await page.getByLabel("Edit note content", { exact: true }).fill("Synthetic updated content"); await editDialog.getByRole("button", { name: "Save lead note", exact: true }).click(); await waitPending();
    assert.equal(submissions[2]!.method, "PATCH"); assert.equal(submissions[2]!.path, "/api/leads/999/notes/42"); assert.equal(submissions[2]!.body.expectedVersion, 5); assert.equal(submissions[2]!.body.title, "Synthetic saved note");
    await pending!.fulfill({ status: 409, json: { error: "Synthetic stale version; reload before editing." } }); pending = undefined; await editDialog.getByRole("alert").waitFor();
    await check("Stale note edit keeps draft and recorded text separate without reporting success", async () => {
      assert.equal(await page.getByLabel("Edit note content", { exact: true }).inputValue(), "Synthetic updated content"); assert.equal(await noteRegion.locator("article .preserve-lines").textContent(), "Synthetic original content");
      await editDialog.getByRole("button", { name: "Close", exact: true }).click();
    });
    // Explicit reload obtains the fresh capability version before the next edit.
    version = 6; await page.getByRole("button", { name: "Reload lead", exact: true }).click(); await edit().waitFor(); await edit().click();
    await page.getByLabel("Edit note content", { exact: true }).fill("Synthetic updated content"); await editDialog.getByRole("button", { name: "Save lead note", exact: true }).click(); await waitPending();
    assert.equal(submissions[3]!.body.expectedVersion, 6); assert.equal(submissions[3]!.body.title, "Synthetic saved note"); assert.notEqual(submissions[3]!.body.operationId, submissions[2]!.body.operationId);
    notes = [{ ...notes[0]!, content: "Synthetic updated content" }]; version = 7;
    await pending!.fulfill({ json: { taskId: "999", noteId: "42", version, operationId: submissions[3]!.body.operationId } }); pending = undefined;
    await noteRegion.getByText("Synthetic updated content", { exact: true }).waitFor();
    await check("Fresh-version edit closes modal and refreshes the saved note", async () => assert.equal(await editDialog.count(), 0));
    for (const [name, change] of [["reconciliation", () => { blockedOperationId = "synthetic-blocked"; }], ["unavailable adapter", () => { blockedOperationId = undefined; adapter = false; }]] as const) {
      change(); await page.getByRole("button", { name: "Reload lead", exact: true }).click(); await add.waitFor();
      await check(name + " disables both note actions", async () => { assert.equal(await add.isDisabled(), true); assert.equal(await edit().isDisabled(), true); });
    }
    writable = false; await page.getByRole("button", { name: "Reload lead", exact: true }).click(); await page.getByText("Your account can read this lead but cannot change it.").waitFor();
    await check("Readonly lead capabilities expose no add or edit actions", async () => { assert.equal(await add.count(), 0); assert.equal(await edit().count(), 0); });
    assert.deepEqual(failures, []); passed = true;
  } finally {
    if (pending) await pending.abort(); await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Actual LeadDetails and mutation controls with source theme/fonts. All requests intercepted; four synthetic submission responses, no actual server/credentials/database/business writes. Not live acceptance.", checkCount: checks.length, checks, screenshots, syntheticSubmissionCount: submissions.length, failures }, null, 2), { flag: "wx" });
    t.diagnostic("Lead notes source evidence: " + directory);
  }
});
