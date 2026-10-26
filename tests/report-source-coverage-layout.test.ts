import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("OFFLINE employee report identifies snapshot and synced coverage without implying missing history is zero", { timeout: 60_000 }, async () => {
  const origin = "http://127.0.0.1:39989";
  const stages = { qualification: 1, siteVisit: 0, proposal: 0, won: 2, lost: 0, omitted: 0, proposalOmitted: 0 };
  const states = { active: 1, hold: 0, closed: 0 };
  const fixture = { dateFrom: "2026-10-01", dateTo: "2026-10-16", timeZone: "Asia/Dubai",
    summary: { ...states, activeEmployees: 2, totalDeals: 1008, wonJobs: 848, wonAmount: "15835220.50", unknownAmounts: 0 },
    stages, wonJobStatuses: states, monthlySince: "2026-01-01", monthly: [{ month: "2026-10", wonAmount: "15835220.50", unknownAmounts: 0 }],
    employees: { items: [{ ...stages, ...states, id: "999", name: "Synthetic local employee", departmentRole: null,
      totalDeals: 3, wonAmount: "12.50", unknownAmounts: 0, electrical: 1, civil: 0, pm: 0, accounts: 0, assigned: 1, process: 0, completed: 0 }], total: 1, page: 1, pageSize: 25 },
  };
  const coverage = { mode: "local-zoho-snapshot", importedDeals: 1000, importedWonJobs: 846, operationalHistory: "not-imported", users: "local-only" };
  const syncedCoverage = { ...coverage, mode: "zoho-sync", importedDeals: 0, importedWonJobs: 0, lastSyncedAt: "2026-10-14T08:30:00.000Z" };
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {EmployeeReport} from './src/components/crm/employee-report';createRoot(document.getElementById('root')).render(<CrmChrome user={{localUserId:'999',username:'Synthetic reviewer',email:'fixture@example.invalid',permissions:['dashboard.view']}}><EmployeeReport/></CrmChrome>);`, loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "offline-next-stubs", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function usePathname(){return '/reports/employee-performance'};export function useSearchParams(){return new URLSearchParams()};export function useRouter(){return{refresh(){},replace(){}}}"
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  const css = (await Promise.all(["src/app/globals.css", "public/legacy/assets/css/hrms.css", "public/legacy/assets/css/style.css"].map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const failures: string[] = [];
  let mode: "native" | "snapshot" | "synced" = "native";
  page.setDefaultTimeout(7000); page.on("pageerror", () => failures.push("pageerror"));
  await page.routeWebSocket("**/*", socket => { failures.push("Unexpected websocket"); socket.close(); });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected origin or mutation"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-theme="light" data-pc-direction="ltr"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/reports/employee-performance") return route.fulfill({ json: { ...fixture,
      ...(mode === "native" ? {} : { sourceCoverage: mode === "snapshot" ? coverage : syncedCoverage }) } });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("Unexpected route"); return route.abort();
  });
  try {
    for (mode of ["native", "snapshot", "synced"] as const) {
      const snapshot = mode === "snapshot", synced = mode === "synced";
      await page.goto(origin);
      await page.getByText("Synthetic local employee", { exact: true }).waitFor();
      const sourceNotice = page.getByRole("region", { name: "Report data coverage" });
      assert.equal(await sourceNotice.count(), mode === "native" ? 0 : 1);
      assert.equal(await page.getByText(snapshot ? "Local Employees" : synced ? "Hub Employees" : "Total Employees", { exact: true }).count(), 1);
      assert.equal(await page.getByRole("heading", { name: snapshot ? "Local Job Status Overview" : synced ? "Recorded Job Status Overview" : "Job Status Overview", exact: true }).count(), 1);
      assert.equal(await page.getByRole("heading", { name: snapshot ? "Local Employee Performance Details" : "Employee Performance Details", exact: true }).count(), 1);
      if (snapshot) {
        assert.match(await sourceNotice.innerText(), /1,000 imported deals \(846 won\)/);
        assert.match(await sourceNotice.innerText(), /not the live CRM employee list/);
        assert.match(await page.getByRole("region", { name: "Report summary" }).innerText(), /Local \+ imported won deals; not payments/);
        assert.match(await page.getByRole("region", { name: "Won job states" }).innerText(), /Imported job statuses are not available/);
        assert.match(await page.getByRole("region", { name: "Monthly won amounts" }).innerText(), /own date range/);
        assert.equal(await page.getByRole("img", { name: "Won job states", exact: true }).count(), 1);
      }
      if (synced) {
        assert.match(await sourceNotice.innerText(), /0 imported deals \(0 won\)/);
        assert.match(await sourceNotice.innerText(), /missing imported states are excluded, not counted as zero or active work/);
        assert.match(await sourceNotice.innerText(), /active Hub accounts, including linked Zoho users/);
        assert.doesNotMatch(await sourceNotice.innerText(), /demo|snapshot/);
        assert.equal(await sourceNotice.locator("time").getAttribute("datetime"), syncedCoverage.lastSyncedAt);
        assert.match(await sourceNotice.innerText(), /12:30/);
        assert.equal(await page.getByText("Recorded Active Jobs", { exact: true }).count(), 1);
        assert.equal(await page.getByText("Recorded Hold Jobs", { exact: true }).count(), 1);
        assert.match(await page.getByRole("region", { name: "Won job states" }).innerText(), /Missing imported job statuses are excluded/);
        assert.match(await page.getByRole("region", { name: "Monthly won amounts" }).innerText(), /own date range/);
        assert.match(await page.getByRole("region", { name: "Employee results" }).innerText(), /Hub employee accounts and exact user mappings only/);
      }
      for (const width of [1907, 1440, 768, 390, 360]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${mode} report overflow at ${width}px`);
      }
    }
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
});
