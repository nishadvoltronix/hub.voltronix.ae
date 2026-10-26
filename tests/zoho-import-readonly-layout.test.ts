import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("OFFLINE Zoho import views show snapshot provenance and hide mutation forms only on imported records", { timeout: 60_000 }, async () => {
  const origin = "http://127.0.0.1:39987", marker = { provider: "zoho", readOnly: true };
  const assignment = { id: "91", taskId: "999", department: "Electrical", userId: "1", userName: "Synthetic worker", status: "Assigned", actorId: "1", assignedAt: "2026-10-15", version: 1 };
  const job = { id: "999", dealName: "Synthetic job", accountName: "Synthetic account", jobNumber: "JOB-999", salesStatus: "Closed Won", jobStatus: "Active", remarks: "Saved remarks", holdByExternalId: null, version: 1, updatedAt: "2026-10-15T08:00:00Z", complaintDescription: "Saved description", assignment, jobDate: "2026-10-15", assignedName: "Synthetic owner", serviceCharge: "42.50", departments: [] };
  const lead = { id: "999", dealName: "Synthetic deal", status: "Site Visit", stage: "siteVisit", accountName: "Synthetic account", assignedExternalId: "901", assignedName: "Synthetic owner", serviceCharge: "42.50", displayNumber: "DEAL-999", createdAt: "2026-10-15T08:00:00Z", updatedAt: "2026-10-15T08:00:00Z", externalId: "9002", customerName: "Synthetic customer", customerEmail: "synthetic@example.invalid", customerContact: null, address: null, description: "Saved <script>synthetic</script> description", remark: null, notes: null, assignmentNotes: null, ownerExternalId: null, createdByLocalId: null, jobStatus: null, dealNumber: "DEAL-999", enquiryNumber: null, qualificationNumber: null, siteNumber: null, quotationNumber: null, jobNumber: null, lostNumber: null, quoteId: null, enquiryDate: null, qualificationDate: null, siteDate: null, quotationDate: null, jobDate: null, lostDate: null };
  const bundle = await build({ stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {LeadDetails} from './src/components/crm/lead-details';
    import {JobDetails} from './src/components/crm/job-details';
    import {DepartmentJob} from './src/components/crm/department-job';
    import {Jobs} from './src/components/crm/jobs';
    import {JobStatusDialog} from './src/components/crm/job-status-dialog';
    import {JobAssignmentDialog} from './src/components/crm/job-assignment-dialog';
    const p=new URLSearchParams(location.search),view=p.get('view'),mode=p.get('mode');
    const job=${JSON.stringify(job)},lead=${JSON.stringify(lead)};
    if(mode==='imported'||mode==='initial-only'){job.sourceImport=${JSON.stringify(marker)};job.jobStatus=null;lead.sourceImport=${JSON.stringify(marker)}}
    createRoot(document.getElementById('root')).render(view==='lead'?<LeadDetails lead={lead}/>:view==='manager'?<JobDetails initialJob={job}/>:view==='worker'?<DepartmentJob initialJob={job} department="Electrical"/>:view==='status'?<JobStatusDialog initialJob={job} onClose={()=>{}} onSaved={()=>{}}/>:view==='assign'?<JobAssignmentDialog initialJob={job} onClose={()=>{}} onSaved={()=>{}}/>:<Jobs/>);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "offline-next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
      ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return '/jobs'};export function useSearchParams(){return new URLSearchParams()}"
      : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
        : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const css = (await Promise.all(["src/app/globals.css", "public/legacy/assets/css/hrms.css", "public/legacy/assets/css/style.css"].map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const failures: string[] = [], requests: string[] = [];
  let mode = "normal";
  page.setDefaultTimeout(7000); page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(request.method() + " " + url.pathname);
    if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected external request or mutation"); return route.abort(); }
    const imported = mode !== "normal", fromCaps = mode === "imported" || mode === "capabilities-only";
    const source = imported ? { sourceImport: marker } : {}, currentJob = { ...job, ...source, ...(imported ? { jobStatus: null } : {}) };
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body><main class="container-fluid py-3"><div id="root"></div></main><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname.startsWith("/legacy/")) return route.fulfill({ contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") });
    if (url.pathname === "/api/capabilities") return route.fulfill({ json: { persistence: "local-demo", localWorkflow: true, leadNotes: true, jobCohorts: true, integrationAvailable: false } });
    if (url.pathname === "/api/leads/999/capabilities") return route.fulfill({ json: { persistence: "local-demo", version: 1, canChangeStage: !fromCaps, canWriteNotes: !fromCaps, stages: fromCaps ? [] : ["Closed Won", "Closed Lost"], integrationAvailable: false, ...(fromCaps ? { sourceImport: marker } : {}) } });
    if (url.pathname === "/api/quotations/999/capabilities") return route.fulfill({ json: { taskVersion: 1, quoteVersion: null, canCreate: !imported, canEdit: false, integrationAvailable: false, discountedEditBlocked: false, ...source } });
    if (url.pathname === "/api/jobs/999") return route.fulfill({ json: currentJob });
    if (url.pathname === "/api/jobs/999/assignments") return route.fulfill({ json: { taskId: "999", version: 1, assignments: [assignment], accounts: null, ...source } });
    if (url.pathname === "/api/jobs") return route.fulfill({ json: { items: [currentJob], total: 1, page: 1, pageSize: 25 } });
    if (url.pathname === "/api/leads/999/attachments") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25, version: 1, canUpload: !imported, ...source } });
    if (url.pathname === "/api/leads/999/notes") return route.fulfill({ json: { items: [{ id: "1", title: "Saved note", content: "Saved source content", externalNoteId: "6001", createdAt: "2026-10-15", updatedAt: "2026-10-15" }], total: 1, page: 1, pageSize: 25 } });
    if (url.pathname.endsWith("/logs") || url.pathname.endsWith("/history") || url.pathname.endsWith("/assignees")) return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } });
    failures.push("Unexpected path " + url.pathname); return route.abort();
  });
  try {
    for (mode of ["normal", "imported"]) {
      const readonly = mode === "imported";
      for (const view of ["lead", "manager", "worker", "list", "status", "assign"]) {
        await page.goto(`${origin}/?view=${view}&mode=${mode}`);
        if (view === "lead") {
          await page.getByText("Saved source content", { exact: true }).waitFor();
          const controls = page.getByRole("region", { name: "Lead changes" });
          if (readonly) await controls.getByText(/Read-only Zoho import/).waitFor();
          else await page.getByRole("button", { name: "Add Note", exact: true }).waitFor();
          assert.equal(await page.getByRole("button", { name: "Add Note", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByRole("button", { name: "Update Status", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByRole("button", { name: "Edit note: Saved note" }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByText("Your account can read this lead but cannot change it.", { exact: true }).count(), 0);
          assert.equal(await page.locator(".legacy-detail-content script").count(), 0);
          assert.equal(await page.getByRole("link", { name: "Create quotation", exact: true }).count(), readonly ? 0 : 1);
        } else if (view === "manager") {
          await page.locator(".legacy-assignment-grid").waitFor();
          assert.match(await page.locator(".legacy-assignment-grid").innerText(), /Synthetic worker/);
          assert.equal(await page.getByRole("button", { name: "Save job status", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByRole("button", { name: "Save remarks", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByRole("button", { name: "Assign department", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByRole("button", { name: "Assign accounts", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByRole("button", { name: "Unassign Electrical", exact: true }).count(), readonly ? 0 : 1);
        } else if (view === "worker") {
          assert.equal(await page.locator("dl div").filter({ has: page.getByText("Job status", { exact: true }) }).locator("dd").innerText(), readonly ? "Not imported" : "Active");
          await page.getByRole("tab", { name: /Electrical/ }).click();
          assert.equal(await page.getByRole("button", { name: "Add work log", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByRole("button", { name: "Update Status", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByLabel("Work log attachment (optional)").count(), readonly ? 0 : 1);
        } else if (view === "list") {
          await page.getByRole("link", { name: "View job Synthetic job", exact: true }).waitFor();
          assert.match(await page.getByRole("region", { name: "Job search" }).innerText(), /Imported Zoho jobs with missing operational history are not counted as Active or Pending Assigning/);
          assert.match(await page.getByRole("region", { name: "Job search" }).innerText(), /if present/);
          assert.equal(await page.getByRole("button", { name: "Assign departments for Synthetic job", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByRole("button", { name: "Update status for Synthetic job", exact: true }).count(), readonly ? 0 : 1);
          assert.equal(await page.getByText("Zoho · read-only", { exact: true }).count(), readonly ? 1 : 0);
          assert.equal(await page.locator(".crm-status-box").innerText(), readonly ? "Not imported" : "Active");
          if (readonly) assert.equal(await page.locator(".crm-status-active").count(), 0);
          assert.deepEqual((await page.locator(".crm-central-jobs tbody td .badge").allTextContents()).slice(0, 5), Array(5).fill(readonly ? "Not imported" : "Not Assigned"));
        } else {
          const dialog = page.getByRole("dialog"); await dialog.waitFor();
          if (readonly) await dialog.getByText(/Read-only Zoho import/).waitFor();
          else await dialog.getByRole("button", { name: view === "status" ? "Save" : "Save Assignments", exact: true }).waitFor();
          assert.equal(await dialog.locator("form").count(), readonly ? 0 : 1);
          if (readonly) assert.equal(await dialog.locator("input,select,textarea").count(), 0);
        }
        if (readonly && ["lead", "manager", "worker"].includes(view)) {
          assert.equal(await page.getByRole("button", { name: "Upload attachment", exact: true }).count(), 0);
          for (const width of [1440, 768, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${view}: overflow at ${width}px`);
          }
          await page.setViewportSize({ width: 1440, height: 1000 });
        }
      }
    }
    for (mode of ["initial-only", "capabilities-only"]) {
      await page.goto(`${origin}/?view=lead&mode=${mode}`);
      await page.getByRole("region", { name: "Lead changes" }).getByText(/Read-only Zoho import/).waitFor();
      assert.equal(await page.getByRole("button", { name: "Add Note", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Update Status", exact: true }).count(), 0);
      assert.equal(await page.getByText("Your account can read this lead but cannot change it.", { exact: true }).count(), 0);
    }
    assert.deepEqual(failures, []); assert.ok(requests.length > 0); assert.ok(requests.every(request => request.startsWith("GET ")));
  } finally { await browser.close(); }
});
