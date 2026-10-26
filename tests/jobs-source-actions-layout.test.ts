import { preservedSource } from "./helpers/preserved-source";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";

test("OFFLINE source job-list status and assignment remarks preserve modal placement, drafts, CSRF and shared versions", { timeout: 90_000 }, async t => {
  const origin = "http://127.0.0.1:39991", directory = resolve(".local-data", "reports", `jobs-source-actions-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const original = await readFile(preservedSource("application/views/Jobs/View_Jobs.php"), "utf8");
  assert.match(original, /id="holdModal"/); assert.match(original, /id="assign_admin_remarks"/); assert.match(original, /id="save_admin_remarks"/);
  const sourceStatus = original.match(/<select\b[^>]*id="hold_job_status"[^>]*>([\s\S]*?)<\/select>/)![1]!;
  const choices = [...sourceStatus.matchAll(/<option value="([^"]*)">\s*([^<]*?)\s*<\/option>/g)].map(match => ({ value: match[1]!, label: match[2]!.trim() }));
  let job = { id: "999", dealName: "Synthetic source job", accountName: "Synthetic customer", jobNumber: "JOB-999", salesStatus: "Closed Won", jobStatus: "Active", remarks: "Recorded remarks", complaintDescription: "Saved complaint", holdByExternalId: null, version: 11, updatedAt: "2026-10-13T08:00:00Z", jobDate: "2026-10-13", assignedName: "Synthetic agent", serviceCharge: "10.00", departments: [] };
  const bundle = await build({ stdin: { contents: "import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {Jobs} from './src/components/crm/jobs';createRoot(document.getElementById('root')).render(<CrmChrome user={{localUserId:'999',username:'Synthetic manager',email:'fixture@example.invalid',permissions:['dashboard.view']}}><Jobs/></CrmChrome>);", loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation") ? "export function useRouter(){return{refresh(){},push(){}}};export function usePathname(){return '/jobs'};export function useSearchParams(){return new URLSearchParams()}" : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}" : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const styles = ["src/app/globals.css", ...["plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css"].map(file => "public/legacy/assets/css/" + file)];
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const checks: string[] = [], failures: string[] = [], screenshots: string[] = [], submissions: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let pending: Route | undefined, passed = false;
  const waitPending = async () => { for (let i = 0; !pending && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(pending); };
  page.on("pageerror", error => failures.push("pageerror: " + error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { failures.push("External request"); return route.abort(); }
    if ((request.method() === "PATCH" && ["/api/jobs/999/status", "/api/jobs/999/remarks"].includes(url.pathname)) || (request.method() === "POST" && url.pathname === "/api/jobs/999/assignments")) {
      assert.equal(request.headers()["x-csrf-token"], "synthetic-csrf"); submissions.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() }); pending = route; return;
    }
    if (request.method() !== "GET") { failures.push("Unexpected mutation"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-theme="light" data-pc-direction="ltr" data-pc-preset="preset-1"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname.startsWith("/legacy/")) return route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") });
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { items: [job], total: 1, page: 1, pageSize: 25 } });
    if (url.pathname === "/api/jobs/999") return route.fulfill({ json: job });
    if (url.pathname === "/api/jobs/999/assignments") return route.fulfill({ json: { taskId: "999", version: job.version, assignments: [], accounts: null } });
    if (url.pathname.endsWith("/assignees")) return route.fulfill({ json: { items: [{ id: "999", name: "Synthetic assignee" }], total: 1, page: 1, pageSize: 25 } });
    if (url.pathname === "/api/capabilities") return route.fulfill({ json: { persistence: "local-demo" } });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "synthetic-csrf" } });
    failures.push("Unexpected path " + url.pathname); return route.abort();
  });
  const statusButton = page.getByRole("button", { name: "Update status for Synthetic source job", exact: true });
  const assignmentButton = page.getByRole("button", { name: "Assign departments for Synthetic source job", exact: true });
  const statusDialog = page.getByRole("dialog", { name: "Are you sure you want to update this project?", exact: true });
  const assignmentDialog = page.getByRole("dialog", { name: "Assign Departments", exact: true });
  try {
    await page.goto(origin); await statusButton.waitFor();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await statusButton.click();
      await page.getByLabel("Project Status", { exact: true }).selectOption("Hold");
      assert.deepEqual(await page.getByLabel("Project Status", { exact: true }).locator("option").evaluateAll(nodes => nodes.map(node => ({ value: (node as HTMLOptionElement).value, label: node.textContent }))), choices);
      const bounds = await statusDialog.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      const file = `job-status-${width}.png`; await page.screenshot({ path: join(directory, file), fullPage: true }); screenshots.push(file);
      await statusDialog.getByRole("button", { name: "Close", exact: true }).click(); assert.equal(submissions.length, 0);
      assert.equal(await statusButton.evaluate(node => node === document.activeElement), true);
      await assignmentButton.click(); await page.getByLabel("Admin Remarks", { exact: true }).fill("Unsaved remarks");
      const assignmentBounds = await assignmentDialog.boundingBox(); assert.ok(assignmentBounds && assignmentBounds.x >= 0 && assignmentBounds.x + assignmentBounds.width <= width);
      const remarksFile = `assignment-remarks-${width}.png`; await page.screenshot({ path: join(directory, remarksFile), fullPage: true }); screenshots.push(remarksFile);
      await assignmentDialog.getByRole("button", { name: "Close", exact: true }).click(); assert.equal(submissions.length, 0);
      checks.push(`${width}px source status and assignment remarks dialogs fit; closing discards only unsaved drafts without a request`);
    }
    await statusButton.click(); assert.equal(await page.getByLabel("Project Status", { exact: true }).inputValue(), "Active");
    await page.getByLabel("Project Status", { exact: true }).selectOption("Hold"); await statusDialog.getByRole("button", { name: "Save", exact: true }).click(); await waitPending();
    assert.deepEqual(submissions[0]!.body, { expectedVersion: 11, jobStatus: "Hold" }); await page.keyboard.press("Escape"); assert.equal(await statusDialog.count(), 1);
    assert.equal(await statusDialog.getByRole("button", { name: "Close", exact: true }).isDisabled(), true);
    await pending!.fulfill({ status: 409, json: { error: "Synthetic stale version" } }); pending = undefined; await statusDialog.getByRole("alert").waitFor();
    assert.equal(await page.getByLabel("Project Status", { exact: true }).inputValue(), "Hold"); checks.push("Status save uses fresh version and CSRF; pending dismissal refused; stale draft preserved");
    job = { ...job, version: 12 }; await statusDialog.getByRole("button", { name: "Refresh job", exact: true }).click(); await page.getByLabel("Project Status", { exact: true }).selectOption("Hold");
    await statusDialog.getByRole("button", { name: "Save", exact: true }).click(); await waitPending(); assert.deepEqual(submissions[1]!.body, { expectedVersion: 12, jobStatus: "Hold" });
    job = { ...job, version: 13, jobStatus: "Hold" }; await pending!.fulfill({ json: job }); pending = undefined; await statusDialog.waitFor({ state: "hidden" }); checks.push("Fresh status retry closes modal and reloads job list after success");
    await assignmentButton.click(); await page.getByLabel("Admin Remarks", { exact: true }).fill("Draft remarks after failure"); await page.getByRole("button", { name: "Save Remarks", exact: true }).click(); await waitPending();
    assert.deepEqual(submissions[2]!.body, { expectedVersion: 13, remarks: "Draft remarks after failure" }); await page.keyboard.press("Escape"); assert.equal(await assignmentDialog.count(), 1);
    assert.equal(await page.getByRole("button", { name: "Save Assignments", exact: true }).isDisabled(), true); assert.equal(await assignmentDialog.getByRole("button", { name: "Close", exact: true }).isDisabled(), true);
    await pending!.fulfill({ status: 409, json: { error: "Synthetic stale remarks" } }); pending = undefined; await assignmentDialog.getByRole("alert").waitFor();
    assert.equal(await page.getByLabel("Admin Remarks", { exact: true }).inputValue(), "Draft remarks after failure"); checks.push("Remarks saves independently with CSRF/version and blocks assignment/close while pending; failure preserves textarea");
    job = { ...job, version: 14 }; await assignmentDialog.getByRole("button", { name: "Refresh assignments", exact: true }).click(); await page.getByLabel("Admin Remarks", { exact: true }).fill("Saved source remarks");
    await page.getByRole("button", { name: "Save Remarks", exact: true }).click(); await waitPending(); assert.deepEqual(submissions[3]!.body, { expectedVersion: 14, remarks: "Saved source remarks" });
    job = { ...job, version: 15, remarks: "Saved source remarks" }; await pending!.fulfill({ json: job }); pending = undefined; await page.getByText("Remarks updated successfully.", { exact: true }).waitFor();
    await page.getByLabel("Electrical user", { exact: true }).selectOption("999"); await page.getByRole("button", { name: "Save Assignments", exact: true }).click(); await waitPending();
    assert.deepEqual(submissions[4]!.body, { assignments: [{ department: "Electrical", userId: "999" }], expectedVersion: 15 });
    job = { ...job, version: 16 }; await pending!.fulfill({ json: { taskId: "999", version: 16, assignments: [], accounts: null } }); pending = undefined; await page.getByText("Assignment saved. Reload other job forms before saving further changes.", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Admin Remarks", { exact: true }).inputValue(), "Saved source remarks"); checks.push("Successful remarks refreshes shared assignment version; subsequent assignment uses version 15 and preserves saved remarks");
    assert.deepEqual(failures, []); passed = true;
  } finally {
    if (pending) await pending.abort(); await browser.close(); await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Source-rendered job list/status/assignment dialogs; intercepted fixture only; no credentials/live account or business mutation.", checkCount: checks.length, checks, screenshots, syntheticSubmissions: submissions, failures }, null, 2), { flag: "wx" }); t.diagnostic("Job source actions evidence: " + directory);
  }
});
