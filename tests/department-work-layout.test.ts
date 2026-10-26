import { preservedSource } from "./helpers/preserved-source";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";
import { DEPARTMENTS, LOG_OPTIONS, type Department } from "../src/server/departments/contracts";

test("OFFLINE five department workspaces restore approved task-scoped source tabs, readonly histories and protected own forms", { timeout: 120_000 }, async t => {
  const origin = "http://127.0.0.1:39991", directory = resolve(".local-data", "reports", `department-work-layout-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const originalWorker = await readFile(preservedSource("application/views/Jobs/Job_Details_User.php"), "utf8");
  const statusFields = { Electrical: "Electric_Status", Civil: "Civil_Status", PM: "PM_Status", Switchgear: "Switchgear_Status", Maintenance: "Maintenance_Status" };
  const sourceOptions = Object.fromEntries(DEPARTMENTS.map(department => {
    const select = originalWorker.match(new RegExp(`<select[^>]*name="${statusFields[department]}"[^>]*>([\\s\\S]*?)<\\/select>`));
    assert.ok(select, `Missing original ${department} status control`);
    // PHP repeats SITE WORKS with identical value/label. Preserve the unique choices.
    const options = [...select[1]!.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(match => ({ value: match[1]!, label: match[2]! }));
    return [department, [...new Map(options.map(option => [option.value, option])).values()]];
  }));
  const initial = { id: "999", dealName: "Synthetic assigned job", accountName: "Synthetic customer", jobNumber: "TEST/999", salesStatus: "Closed Won", jobStatus: "Active", remarks: "Synthetic recorded remarks", version: 9, updatedAt: "2026-10-13T08:00:00Z", assignment: { id: "999", taskId: "999", department: "Civil", userId: "999", userName: "Synthetic worker", status: "Process", actorId: "999", assignedAt: "2026-10-13T07:00:00Z", version: 9 } };
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {DepartmentJob} from './src/components/crm/department-job';const department=new URLSearchParams(location.search).get('department');const job=${JSON.stringify(initial)};job.assignment.department=department;createRoot(document.getElementById('root')).render(<CrmChrome user={{localUserId:'999',username:'Synthetic worker',email:'fixture@example.invalid',permissions:[]}}><DepartmentJob initialJob={job} department={department}/></CrmChrome>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
      ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return '/departments/'+new URLSearchParams(location.search).get('department')+'/jobs/999'};export function useSearchParams(){return new URLSearchParams()}"
      : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
        : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const fonts = await Promise.all([["Phosphor", "public/legacy/assets/css/plugins/Phosphor.woff2"], ["tabler-icons", "public/legacy/assets/css/plugins/fonts/tabler-icons.woff2"]].map(async ([family, file]) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${(await readFile(file!)).toString("base64")}) format("woff2");font-weight:normal;font-style:normal;}`));
  const styles = ["src/app/globals.css", ...["plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css"].map(file => "public/legacy/assets/css/" + file)];
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "") + fonts.join("\n");
  const images = { Electrical: "electricgif.gif", Civil: "civilgif.gif", PM: "PM.gif", Switchgear: "switchgear.gif", Maintenance: "Maintenancemtn.gif" };
  const assetHashes = Object.fromEntries(await Promise.all(Object.values(images).map(async file => {
    const original = await readFile(preservedSource("include/dist/assets/images/" + file)), copy = await readFile("public/legacy/assets/images/" + file); assert.ok(original.equals(copy));
    return [file, createHash("sha256").update(copy).digest("hex")];
  })));
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const checks: string[] = [], failures: string[] = [], screenshots: string[] = [], requests: string[] = [], submissions: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let current: Department = "Electrical", pending: Route | undefined, passed = false;
  let job = { ...initial, assignment: { ...initial.assignment } };
  const check = async (name: string, action: () => Promise<void>) => { await action(); checks.push(name); };
  const waitPending = async () => { for (let attempts = 0; !pending && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(pending); };
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(request.method() + " " + url.pathname);
    if (url.origin !== origin) { failures.push("External request"); return route.abort(); }
    if (["POST", "PATCH"].includes(request.method()) && current === "Civil" && ["/api/departments/Civil/jobs/999/logs", "/api/departments/Civil/jobs/999/status"].includes(url.pathname)) {
      assert.equal(request.headers()["x-csrf-token"], "synthetic-token"); submissions.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() }); pending = route; return;
    }
    if (request.method() !== "GET") { failures.push("Unexpected mutation"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-theme="light" data-pc-direction="ltr" data-pc-preset="preset-1" data-pc-sidebar-caption="true"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    const logs = url.pathname.match(/^\/api\/departments\/(Electrical|Civil|PM|Switchgear|Maintenance)\/jobs\/999\/logs$/);
    if (logs) { const selected = logs[1]!, own = selected === current;
      return route.fulfill({ json: { items: [{ id: "999", taskId: "999", department: selected, assignmentId: "999", actorId: "999", actorName: "Synthetic worker", authority: ["Electrical", "Civil"].includes(selected) ? "DESIGN" : null, scope: ["Electrical", "Civil"].includes(selected) ? null : "Synthetic scope", status: "Process", comments: "Recorded comments", notes: own ? "Recorded work notes" : `Recorded ${selected} readonly notes`, createdAt: "2026-10-13T08:00:00Z", attachment: { id: own ? "999" : "readonly-" + selected, name: own ? "Synthetic file.pdf" : `Synthetic ${selected}.png`, mediaType: own ? "application/pdf" : "image/png", size: 100 } }], total: 1, page: 1, pageSize: Number(url.searchParams.get("pageSize")) || 25 } });
    }
    if (url.pathname === `/api/departments/${current}/jobs/999`) return route.fulfill({ json: job });
    if (url.pathname === "/api/leads/999/attachments") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25, canUpload: false, version: job.version } });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "synthetic-token" } });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    if (url.pathname === "/legacy/assets/images/" + images[current]) return route.fulfill({ contentType: "image/gif", body: await readFile("public" + url.pathname) });
    failures.push("Unexpected or foreign route " + url.pathname); return route.abort();
  });
  const capture = async (name: string) => { await page.evaluate(async () => { await document.fonts.ready; (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }); await page.screenshot({ path: join(directory, name), fullPage: true, animations: "disabled" }); screenshots.push(name); };
  try {
    for (const department of DEPARTMENTS) {
      current = department; job = { ...initial, assignment: { ...initial.assignment, department } };
      await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(origin + "/?department=" + department);
      const label = department === "PM" ? "Project Manager" : department;
      const tab = page.getByRole("tab", { name: label, exact: true }); await tab.waitFor();
      await check(`${department}: source Details default and all five approved department tabs`, async () => {
        assert.deepEqual(await page.getByRole("tablist").locator(".d-sm-inline").allTextContents(), ["Details", "Electrical", "Civil", "Project Manager", "Switchgear", "Maintenance"]);
        for (const name of ["Details", "Electrical", "Civil", "Project Manager", "Switchgear", "Maintenance"]) assert.equal(await page.getByRole("tab", { name, exact: true }).count(), 1);
        assert.equal(await page.getByRole("tab", { name: "Details", exact: true }).getAttribute("aria-selected"), "true");
        assert.equal(await page.locator(".legacy-detail-content .card-header .badge").textContent(), department + " · Process");
        assert.equal(await page.getByLabel("Work notes", { exact: true }).isVisible(), false); await tab.click();
      });
      const form = page.getByRole("region", { name: department + " work log", exact: true });
      const authority = department === "Electrical" || department === "Civil";
      await check(`${department}: original labels, choices, illustration and log columns`, async () => {
        const options = LOG_OPTIONS[department];
        assert.deepEqual(await page.getByLabel("Log status", { exact: true }).locator("option").evaluateAll(elements => elements.map(element => ({ value: (element as HTMLOptionElement).value, label: element.textContent }))), sourceOptions[department]);
        assert.deepEqual(await page.getByLabel(authority ? "Authority" : "Scope of work", { exact: true }).locator("option").evaluateAll(elements => elements.map(element => (element as HTMLOptionElement).value)), "authority" in options ? [...options.authority] : [...options.scope]);
        assert.equal(await form.getByRole("button", { name: "Add work log", exact: true }).textContent(), "Submit");
        assert.equal(await form.getByText(department === "Electrical" ? "Electrician Notes" : department + " Notes", { exact: true }).count(), 1);
        assert.equal(await form.locator("img").getAttribute("src"), "/legacy/assets/images/" + images[department]);
        await page.getByRole("region", { name: department + " logs table", exact: true }).getByText("Recorded work notes", { exact: true }).waitFor();
        assert.deepEqual(await page.locator(".crm-worker-logs thead th").allTextContents(), authority ? ["Date", "Authority", "Status", "Comments", "Notes", "File", "Assigned User"] : ["Date", "Scope of Work", "Status", "Notes", "File", "Assigned User"]);
        assert.equal(await page.getByRole("link", { name: "Download Synthetic file.pdf", exact: true }).getAttribute("href"), "/api/log-attachments/999");
        const extra = ["Switchgear", "Maintenance"].includes(department) ? ["xls", "xlsx", "csv"] : [];
        assert.deepEqual((await page.getByLabel("Work log attachment (optional)").getAttribute("accept"))!.split(",").sort(), ["gif", "jpg", "jpeg", "png", "pdf", ...extra].map(value => "." + value).sort());
        assert.ok(await form.getByText(new RegExp(`up to ${department === "PM" ? "16,000" : "51,200"} KB`)).isVisible());
      });
      await check(`${department}: tab round-trip preserves draft; Clear resets inputs/file without submission`, async () => {
        await page.getByLabel("Work notes", { exact: true }).fill("Unsaved worker draft");
        await page.getByRole("tab", { name: "Details", exact: true }).click(); await tab.click(); assert.equal(await page.getByLabel("Work notes", { exact: true }).inputValue(), "Unsaved worker draft");
        await page.getByLabel("Work log attachment (optional)").setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from("not-submitted-fixture") });
        await form.getByRole("button", { name: "Clear", exact: true }).click(); assert.equal(await page.getByLabel("Work notes", { exact: true }).inputValue(), "");
        assert.equal(await page.getByLabel("Work log attachment (optional)").inputValue(), ""); assert.equal(await page.getByLabel("Log status", { exact: true }).inputValue(), "-"); assert.equal(submissions.length, 0);
      });
      await check(`${department}: other department panes are read-only, keep own draft and use protected file routes`, async () => {
        await page.getByLabel("Work notes", { exact: true }).fill("Own unsaved draft survives readonly tabs");
        for (const target of DEPARTMENTS.filter(value => value !== department)) {
          await page.getByRole("tab", { name: target === "PM" ? "Project Manager" : target, exact: true }).click();
          const panel = page.getByRole("tabpanel");
          await panel.getByRole("region", { name: target + " recorded submission", exact: true }).getByText(`Recorded ${target} readonly notes`, { exact: true }).waitFor();
          const submission = panel.getByRole("region", { name: target + " recorded submission", exact: true });
          assert.equal(await submission.getByRole("heading", { name: target + " Department Submission", exact: true }).count(), 1);
          assert.equal(await submission.locator(".badge.bg-info").count(), 1); assert.equal(await submission.locator(".badge.bg-success").textContent(), "Process");
          assert.equal(await submission.locator(".border.rounded.bg-light").count(), ["Electrical", "Civil"].includes(target) ? 2 : 1);
          assert.equal(await submission.locator(".card-footer").textContent(), "Submitted on - 13 Oct 2026, 12:00 PM");
          assert.equal(await panel.getByRole("region", { name: target + " logs table", exact: true }).getByRole("cell", { name: "13 Oct 2026 12:00 PM", exact: true }).count(), 1);
          await panel.getByRole("region", { name: target + " logs table", exact: true }).waitFor();
          assert.equal(await panel.locator("form,input,textarea,select").count(), 0);
          assert.equal(await panel.getByRole("button", { name: /Submit|Save|Update Status|Add work log/ }).count(), 0);
          assert.equal(await panel.getByRole("link", { name: `Download Synthetic ${target}.png`, exact: true }).first().getAttribute("href"), "/api/log-attachments/readonly-" + target);
          assert.equal(await panel.getByRole("link", { name: `View Synthetic ${target}.png`, exact: true }).first().getAttribute("href"), "/api/log-attachments/readonly-" + target + "/preview");
          assert.equal(submissions.length, 0);
        }
        await tab.click(); assert.equal(await page.getByLabel("Work notes", { exact: true }).inputValue(), "Own unsaved draft survives readonly tabs");
        await form.getByRole("button", { name: "Clear", exact: true }).click();
      });
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await check(`${department}: ${width}px form and modal fit, close without write`, async () => {
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width); await capture(`worker-${department}-${width}.png`);
          await page.getByRole("button", { name: "Update Status", exact: true }).click();
          const dialog = page.getByRole("dialog", { name: department === "Electrical" ? "Update Status" : `Update ${department} Status`, exact: true }); await dialog.waitFor();
          const rect = await dialog.boundingBox(); assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width);
          assert.deepEqual(await page.getByLabel("Department status", { exact: true }).locator("option").allTextContents(), ["--Select--", "Under Process", "Completed"]);
          await page.getByLabel("Department status", { exact: true }).selectOption("Completed"); await capture(`worker-${department}-status-${width}.png`);
          await dialog.getByRole("button", { name: "Close", exact: true }).click(); assert.equal(submissions.length, 0); assert.equal(await form.locator(".card-header .badge").textContent(), "Process");
        });
        await check(`${department}: ${width}px readonly department submission and history fit`, async () => {
          const target = department === "Electrical" ? "Civil" : "Electrical";
          await page.getByRole("tab", { name: target, exact: true }).click();
          await page.getByRole("region", { name: target + " recorded submission", exact: true }).getByText(`Recorded ${target} readonly notes`, { exact: true }).waitFor();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
          const panel = page.getByRole("tabpanel"); assert.equal(await panel.locator("form,input,textarea,select").count(), 0);
          await capture(`worker-${department}-readonly-${width}.png`);
          await page.getByRole("tab", { name: "Details", exact: true }).focus(); await page.keyboard.press("End");
          assert.equal(await page.getByRole("tab", { name: "Maintenance", exact: true }).getAttribute("aria-selected"), "true");
          await page.keyboard.press("Home"); assert.equal(await page.getByRole("tab", { name: "Details", exact: true }).getAttribute("aria-selected"), "true");
          await tab.click();
        });
      }
    }
    current = "Civil"; job = { ...initial, assignment: { ...initial.assignment, department: "Civil" } }; await page.goto(origin + "/?department=Civil"); await page.getByRole("tab", { name: "Civil", exact: true }).click();
    await page.getByLabel("Authority", { exact: true }).selectOption("DCD"); await page.getByLabel("Log status", { exact: true }).selectOption("COMMENT"); await page.getByLabel("Authority comments", { exact: true }).fill("Synthetic comments"); await page.getByLabel("Work notes", { exact: true }).fill("Synthetic submitted notes");
    await page.getByRole("button", { name: "Add work log", exact: true }).click(); await waitPending();
    await check("Normal worker log payload/version/CSRF are retained; pending Clear is disabled", async () => {
      assert.deepEqual(submissions[0]!.body, { expectedVersion: 9, status: "COMMENT", authority: "DCD", comments: "Synthetic comments", notes: "Synthetic submitted notes" });
      assert.equal(await page.getByRole("button", { name: "Clear", exact: true }).isDisabled(), true);
    });
    job = { ...job, version: 10 }; await pending!.fulfill({ json: job }); pending = undefined; await page.getByText("Work log added.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Update Status", exact: true }).click(); await page.getByLabel("Department status", { exact: true }).selectOption("Completed"); await page.getByRole("button", { name: "Save department status", exact: true }).click(); await waitPending();
    await check("Status modal keeps version and pending protections", async () => { assert.deepEqual(submissions[1]!.body, { expectedVersion: 10, status: "Completed" }); await page.keyboard.press("Escape"); assert.equal(await page.getByRole("dialog").count(), 1); });
    await pending!.fulfill({ status: 409, json: { error: "Synthetic stale worker version" } }); pending = undefined; await page.getByRole("dialog").getByRole("alert").waitFor();
    await check("Stale status refusal retains draft and does not change recorded assignment", async () => { assert.equal(await page.getByLabel("Department status", { exact: true }).inputValue(), "Completed"); assert.equal(await page.locator(".crm-worker-form .card-header .badge").textContent(), "Process"); await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click(); });
    job = { ...job, jobStatus: "Hold" }; await page.getByRole("tab", { name: "Details", exact: true }).click(); await page.getByRole("button", { name: "Reload department job", exact: true }).click(); await page.getByRole("tab", { name: "Civil", exact: true }).click(); await page.getByText("This job is on hold or closed. Department changes are unavailable.").waitFor();
    await check("Hold disables status and log submission without widening assignment scope", async () => { assert.equal(await page.getByRole("button", { name: "Update Status", exact: true }).isDisabled(), true); assert.equal(await page.getByRole("button", { name: "Add work log", exact: true }).isDisabled(), true); });
    assert.deepEqual(failures, []); passed = true;
  } finally {
    if (pending) await pending.abort(); await browser.close(); await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Actual worker component with original theme/fonts/GIFs; all network intercepted. Approved cross-department GETs confined to synthetic own task999. Two synthetic own-department write responses; no credentials/server/database/application writes. Other-task/foreign write routes rejected by fixture.", checkCount: checks.length, checks, screenshots, originalAssetSha256: assetHashes, syntheticSubmissionCount: submissions.length, requests, failures }, null, 2), { flag: "wx" }); t.diagnostic("Worker source evidence: " + directory);
  }
});
