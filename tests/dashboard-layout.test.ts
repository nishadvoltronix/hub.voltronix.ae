import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("dashboard cards align per row and department status labels remain readable across screen sizes", { timeout: 90_000 }, async t => {
  const directory = resolve(".local-data", "reports", `dashboard-layout-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const origin = "http://127.0.0.1:39981";
  const fixture = { global: {
    wonJobs: 2, pendingAssignmentJobs: 1, completedJobs: 0,
    accounts: { totalPending: "0.00", pendingJobs: 0, unknownServiceChargeJobs: 0 },
    pipeline: [{ key: "qualification", label: "Qualification", count: 1, percentage: "100" }],
    employees: { items: [{ id: "999", name: "Synthetic employee", electrical: 1, civil: 0, pm: 0 }], total: 1, page: 1, pageSize: 25 },
    departmentProgress: ["Electrical", "Civil", "PM"].map(department => ({ department, total: 1, pending: 1, process: 0, completed: 0, hold: 0 })),
    leadsToday: 6, leadsThisMonth: 6,
  }, sales: { total: 2, today: 2, thisMonth: 2, stages: [
    { label: "Qualification", count: 1 }, { label: "Site Visit", count: 0 }, { label: "Proposal", count: 0 },
    { label: "Won", count: 1 }, { label: "Lost / omitted", count: 0 },
  ] }, departments: [] };
  const snapshotFixture = { ...fixture, sourceCoverage: {
    mode: "local-zoho-snapshot", importedDeals: 1000, localDeals: 8, importedWonJobs: 846, localWonJobs: 2,
    importedAt: "2026-10-15T13:25:05.177Z", operationalHistory: "not-imported", users: "local-only",
  }, global: { ...fixture.global, wonJobs: 846, pendingAssignmentJobs: null, completedJobs: null,
    accounts: { totalPending: null, pendingJobs: null, unknownServiceChargeJobs: 0 },
    pipeline: ["qualification", "siteVisit", "proposal", "won", "lost", "other", "unmapped"].map((key, index) => ({
      key, label: index === 6 ? "Other / unmapped stages" : key, count: index === 3 ? 846 : index === 6 ? 154 : 0,
      percentage: index === 3 ? "84.60" : index === 6 ? "15.40" : "0.00",
    })),
  } };
  const unavailableFixture = { ...fixture, global: { ...fixture.global,
    pendingAssignmentJobs: null, completedJobs: null,
    accounts: { totalPending: null, pendingJobs: null, unknownServiceChargeJobs: 0 },
  } };
  const syncedFixture = { ...snapshotFixture, sourceCoverage: { ...snapshotFixture.sourceCoverage,
    mode: "zoho-sync", importedAt: null,
    localOperations: { pendingAssignmentJobs: 1, completedJobs: 1,
      accounts: { pendingJobs: 1, totalPending: "123.45", unknownServiceChargeJobs: 0 } },
  }, global: { ...snapshotFixture.global, wonJobs: 848 } };
  let responseFixture: unknown = fixture;
  let dashboardReads = 0;
  const entry = `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {Dashboard} from './src/components/crm/dashboard';createRoot(document.getElementById('root')).render(<CrmChrome user={{localUserId:'999',username:'Synthetic dashboard reviewer',email:'fixture@example.invalid',permissions:['dashboard.view']}}><Dashboard/></CrmChrome>);`;
  const bundle = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true,
    write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-component-stubs", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function usePathname(){return '/dashboard'};export function useSearchParams(){return new URLSearchParams()};export function useRouter(){return{refresh(){},replace(){}}}"
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  const styles = ["src/app/globals.css", ...["jquery.dataTables.min.css", "plugins/phosphor-icons.css", "plugins/tabler-icons.min.css",
    "hrms.css", "style.css", "select2.min.css"].map(file => "public/legacy/assets/css/" + file)];
  const fonts = await Promise.all([
    ["Phosphor", "public/legacy/assets/css/plugins/Phosphor.woff2"],
    ["tabler-icons", "public/legacy/assets/css/plugins/fonts/tabler-icons.woff2"],
  ].map(async ([family, file]) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${(await readFile(file!)).toString("base64")}) format("woff2");font-weight:normal;font-style:normal;}`));
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n")
    .replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "") + fonts.join("\n");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const failures: string[] = [], captures: string[] = [], metrics: object[] = [];
  page.on("pageerror", () => failures.push("pageerror"));
  await page.routeWebSocket("**/*", socket => { failures.push("Unexpected websocket"); socket.close(); });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected origin or mutation"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-theme="light" data-pc-direction="ltr"><div id="root"></div><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/dashboard") { dashboardReads++; return route.fulfill({ json: responseFixture }); }
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("Unexpected route"); return route.abort();
  });
  let passed = false;
  try {
    await page.goto(origin);
    await page.getByText("Synthetic employee", { exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Your sales leads", exact: true })
      .getByRole("link", { name: "View my assigned leads", exact: true }).getAttribute("href"), "/pipeline?scope=own");
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1280, 1440, 1907, 1025, 768, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      const values = await page.evaluate(() => {
        return { documentWidth: document.documentElement.scrollWidth,
          summary: [...document.querySelectorAll<HTMLElement>('[aria-label="Job overview"] .crm-kpi')].map(card => {
            const box = card.getBoundingClientRect(); return { y: box.top, height: box.height, bottom: box.bottom };
          }),
          departments: [...document.querySelectorAll<HTMLElement>('[aria-label="Department overview"] .Active-visitor')].map(card => {
            const box = card.getBoundingClientRect(); return { y: box.top, height: box.height, bottom: box.bottom };
          }),
          sales: [...document.querySelectorAll<HTMLElement>('[aria-label="Your sales leads"] .crm-kpi')].map(card => {
            const box = card.getBoundingClientRect(); return { y: box.top, height: box.height, bottom: box.bottom };
          }),
          captions: [...document.querySelectorAll<HTMLElement>(".crm-department-counts small")].map(label => {
            const range = document.createRange(); range.selectNodeContents(label);
            const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
            const cell = label.parentElement!.getBoundingClientRect();
            return { text: label.textContent, fontSize: parseFloat(getComputedStyle(label).fontSize),
              lines: new Set(rects.map(rect => Math.round(rect.top))).size,
              left: Math.min(...rects.map(rect => rect.left)), right: Math.max(...rects.map(rect => rect.right)),
              cellLeft: cell.left, cellRight: cell.right };
          }),
        };
      });
      metrics.push({ width, ...values });
      const screenshot = `dashboard-${width}.png`;
      await page.screenshot({ path: join(directory, screenshot), fullPage: true, animations: "disabled" }); captures.push(screenshot);
      assert.equal(values.documentWidth, width);
      assert.equal(values.summary.length, 4); assert.equal(values.departments.length, 3); assert.equal(values.sales.length, 8);
      for (const cards of [values.summary, values.departments, values.sales]) for (const card of cards) {
        for (const other of cards.filter(other => Math.abs(other.y - card.y) < 1)) {
          assert.ok(Math.abs(card.bottom - other.bottom) < 1, `${width}px cards sharing a row must share their bottom edge`);
        }
      }
      assert.equal(values.captions.length, 12);
      for (const caption of values.captions) {
        assert.equal(caption.lines, 1, `${width}px ${caption.text}: status words must not split`);
        assert.ok(caption.fontSize >= 11, "Status captions remain readable");
        assert.ok(caption.left >= caption.cellLeft - 1 && caption.right <= caption.cellRight + 1,
          `${width}px ${caption.text}: status label must fit within its own count column`);
      }
    }
    responseFixture = snapshotFixture;
    await page.reload();
    const coverage = page.getByRole("region", { name: "Dashboard data coverage" });
    await coverage.waitFor();
    assert.match(await coverage.innerText(), /1,000 imported Zoho deals/);
    assert.match(await coverage.innerText(), /8 local\/demo deals \(2 won\) are excluded/);
    assert.match(await coverage.innerText(), /unknown, not zero or pending work/);
    assert.equal(await coverage.locator("time").getAttribute("datetime"), "2026-10-15T13:25:05.177Z");
    const overview = page.getByRole("region", { name: "Job overview" });
    assert.deepEqual(await overview.locator("h2").allTextContents(), ["846", "Not imported", "Not imported", "Not imported"]);
    assert.equal(await overview.getByText(/Against .* jobs/).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Local User Workload", exact: true }).count(), 1);
    assert.match(await page.getByRole("region", { name: "Employee workload" }).innerText(), /not the live CRM employee list or workload/);
    assert.equal(await page.getByRole("heading", { name: "Local Department Progress", exact: true }).count(), 1);
    assert.equal(await page.getByText("Other / unmapped stages", { exact: true }).count(), 1);
    assert.equal(await page.getByRole("progressbar", { name: "Other / unmapped stages percentage" }).getAttribute("aria-valuenow"), "15.4");
    assert.equal(await page.getByRole("heading", { name: "Snapshot: Today's Leads", exact: true }).count(), 1);
    assert.match(await page.locator(".crm-dashboard-refresh").innerText(), /does not synchronize Zoho/);
    for (const width of [1907, 1440, 1280, 1025, 768, 390, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await overview.locator(".crm-kpi").evaluateAll(cards => cards.map(card => {
        const rect = card.getBoundingClientRect(), title = card.querySelector("h2")!, icon = card.querySelector("i")!;
        const textRange = document.createRange(); textRange.selectNodeContents(title);
        return { top: rect.top, bottom: rect.bottom, cardRight: rect.right, iconLeft: icon.getBoundingClientRect().left,
          textRight: Math.max(...[...textRange.getClientRects()].map(line => line.right)) };
      }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `Snapshot dashboard overflow at ${width}px`);
      for (const card of layout) {
        assert.ok(card.textRight <= card.iconLeft + 1, `Snapshot label must not overlap its icon at ${width}px`);
        for (const other of layout.filter(other => Math.abs(other.top - card.top) < 1)) assert.ok(Math.abs(other.bottom - card.bottom) < 1);
      }
      const screenshot = `dashboard-imported-${width}.png`;
      await page.screenshot({ path: join(directory, screenshot), fullPage: true, animations: "disabled" }); captures.push(screenshot);
    }
    const previousReads = dashboardReads;
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/dashboard");
    await page.getByRole("button", { name: "Refresh dashboard", exact: true }).click();
    await refreshed;
    await page.waitForFunction(() => !document.body.textContent?.includes("Loading dashboard"));
    assert.equal(dashboardReads, previousReads + 1, "Refresh reloads the saved dashboard through one GET only");
    responseFixture = syncedFixture;
    await page.reload();
    await page.getByRole("heading", { name: "Zoho records · operational history not imported", exact: true }).waitFor();
    assert.match(await coverage.innerText(), /1,000 imported Zoho deals \(846 won\) and 8 Hub deals \(2 won\)/);
    assert.doesNotMatch(await coverage.innerText(), /snapshot|excluded from those totals/);
    assert.equal(await coverage.locator("time").count(), 0, "No invented sync timestamp");
    assert.deepEqual(await overview.locator("h2").allTextContents(), ["848", "Not imported", "Not imported", "Not imported"]);
    assert.equal(await overview.getByText(/Against .* jobs/).count(), 0);
    const localTotals = page.getByRole("region", { name: "Hub-only operational totals" });
    assert.match(await localTotals.innerText(), /Pending assignment: 1\. Completed jobs: 1\. Pending accounts: 123\.45 against 1 jobs/);
    assert.equal(await page.getByRole("heading", { name: "Local User Workload", exact: true }).count(), 1);
    assert.match(await page.getByRole("region", { name: "Employee workload" }).innerText(), /not the live CRM employee list or workload/);
    assert.match(await page.locator(".crm-dashboard-refresh").innerText(), /does not start a sync/);
    responseFixture = { ...syncedFixture, sourceCoverage: { ...syncedFixture.sourceCoverage, localDeals: 0, localWonJobs: 0 },
      global: { ...syncedFixture.global, wonJobs: 846 } };
    await page.reload();
    await coverage.waitFor();
    assert.deepEqual(await overview.locator("h2").allTextContents(), ["846", "Not imported", "Not imported", "Not imported"]);
    assert.match(await overview.innerText(), /Imported Zoho deals only/);
    assert.equal(await localTotals.count(), 0, "No empty local subtotal is presented as legacy history");
    for (const width of [1907, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const screenshot = `dashboard-synced-${width}.png`;
      await page.screenshot({ path: join(directory, screenshot), fullPage: true, animations: "disabled" }); captures.push(screenshot);
    }
    responseFixture = unavailableFixture;
    await page.reload();
    await page.getByText("Synthetic employee", { exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Dashboard data coverage" }).count(), 0);
    assert.deepEqual(await overview.locator("h2").allTextContents(), ["2", "Unavailable", "Unavailable", "Unavailable"]);
    assert.match(await overview.innerText(), /Job count unavailable/);
    assert.doesNotMatch(await overview.innerText(), /Against null jobs/);
    assert.deepEqual(failures, []); passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL",
      scope: "Actual dashboard React and styles with intercepted synthetic GETs only; no server, real records or business writes.",
      metrics, captures, failures }, null, 2), { flag: "wx" });
    t.diagnostic("Dashboard layout evidence: " + directory);
  }
});
