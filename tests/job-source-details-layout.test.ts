import { preservedSource } from "./helpers/preserved-source";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("OFFLINE source manager and worker detail fields preserve saved values, escaping and responsive layout", { timeout: 60_000 }, async t => {
  const origin = "http://127.0.0.1:39991", directory = resolve(".local-data", "reports", `job-source-details-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const job = { id: "999", dealName: "Synthetic job", accountName: "Synthetic account", jobNumber: "JOB-SOURCE", salesStatus: "Closed Won", jobStatus: "Active", remarks: "Recorded remarks", holdByExternalId: null, version: 1, updatedAt: "2026-10-12T21:00:00Z", createdAt: "2026-10-11T20:00:00Z", qualificationNumber: "QUAL-SOURCE", quotationNumber: "QUOTE-STAGE", complaintDescription: "Saved <script>window.unexpectedScript=true</script>\nSecond line", enquiryDate: "2026-10-01", quotationDate: "2026-10-02", customerEmail: "source@example.invalid", customerContact: "+971 source", assignment: { id: "999", taskId: "999", department: "Electrical", userId: "999", userName: "Synthetic worker", status: "Process", actorId: "999", assignedAt: "2026-10-13T07:00:00Z", version: 1 } };
  const sourceFields = ["complaint_info", "qual_deal_number", "quote_deal_number", "created_at", "enq_deal_date", "quote_deal_date", "customer_email", "customer_contact"];
  for (const file of ["Job_Details.php", "Job_Details_User.php"]) {
    const source = await readFile(preservedSource("application/views/Jobs/" + file), "utf8");
    for (const field of sourceFields) assert.ok(source.includes(`$data['${field}']`), `${file}: ${field}`);
  }
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {JobDetails} from './src/components/crm/job-details';import {DepartmentJob} from './src/components/crm/department-job';const params=new URLSearchParams(location.search);const job=${JSON.stringify(job)};if(params.has('missing')){for(const key of ['complaintDescription','createdAt','qualificationNumber','quotationNumber','enquiryDate','quotationDate','customerEmail','customerContact'])delete job[key]};createRoot(document.getElementById('root')).render(<CrmChrome user={{localUserId:'999',username:'Synthetic user',email:'fixture@example.invalid',permissions:['dashboard.view']}}>{params.get('view')==='worker'?<DepartmentJob initialJob={job} department="Electrical"/>:<JobDetails initialJob={job}/>}</CrmChrome>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation") ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return new URLSearchParams(location.search).get('view')==='worker'?'/departments/Electrical/jobs/999':'/jobs/999'};export function useSearchParams(){return new URLSearchParams()}" : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}" : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const styles = ["src/app/globals.css", ...["plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css"].map(file => "public/legacy/assets/css/" + file)];
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const checks: string[] = [], requests: string[] = [], failures: string[] = [], screenshots: string[] = [];
  let passed = false;
  page.setDefaultTimeout(10_000); page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(request.method() + " " + url.pathname);
    if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected request"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-theme="light" data-pc-direction="ltr" data-pc-preset="preset-1" data-pc-sidebar-caption="true"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname.startsWith("/legacy/")) return route.fulfill({ status: 200, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") });
    if (url.pathname === "/api/jobs/999/assignments") return route.fulfill({ json: { taskId: "999", version: 1, assignments: [job.assignment], accounts: null } });
    if (url.pathname === "/api/leads/999/attachments") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25, version: 1, canUpload: false } });
    if (url.pathname.endsWith("/logs") || url.pathname.endsWith("/assignees")) return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } });
    failures.push("Unexpected path " + url.pathname); return route.abort();
  });
  try {
    for (const view of ["manager", "worker"]) {
      await page.goto(origin + "/?view=" + view); await page.getByText("Customer Email: " + job.customerEmail, { exact: true }).waitFor();
      for (const [label, value] of [["Deal No.", job.qualificationNumber], ["Quote No.", job.quotationNumber], ["Created", job.createdAt]] as const) {
        assert.equal(await page.locator("dl div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd").textContent(), value);
      }
      for (const value of [job.complaintDescription, "Contact Number: " + job.customerContact, "Inquiry Date: " + job.enquiryDate, "Quotation Date: " + job.quotationDate]) assert.equal(await page.getByText(value, { exact: true }).count(), 1);
      assert.equal(await page.locator(".legacy-detail-content script").count(), 0);
      assert.equal(await page.evaluate(() => "unexpectedScript" in window), false);
      checks.push(`${view}: original saved numbers, creation, description, contact and stage-date values render as escaped text`);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        await page.evaluate(() => window.scrollTo(0, 0)); const file = `${view}-source-details-${width}.png`;
        await page.screenshot({ path: join(directory, file), fullPage: true }); screenshots.push(file); checks.push(`${view}: ${width}px no document overflow`);
      }
      await page.goto(origin + "/?view=" + view + "&missing=1"); await page.getByText("Description:", { exact: true }).waitFor();
      assert.equal(await page.getByText("Customer Email: " + job.customerEmail, { exact: true }).count(), 0);
      assert.ok(await page.getByText("Not recorded", { exact: true }).count() >= 8);
      checks.push(`${view}: older providers display missing values without inventing a date or contact`);
    }
    assert.deepEqual(failures, []); passed = true;
  } finally {
    await browser.close(); await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Synthetic manager/worker components; original source field references and intercepted GET responses only. No credentials or application/database mutations; omitted source fonts are not pixel-parity evidence.", checkCount: checks.length, checks, requests, failures, screenshots }, null, 2), { flag: "wx" });
    t.diagnostic("Job source details evidence: " + directory);
  }
});
