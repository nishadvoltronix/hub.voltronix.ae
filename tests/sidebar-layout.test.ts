import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";

// Actual React chrome/report and unchanged PHP theme; all requests are intercepted.
// Synthetic component coverage does not establish authenticated demo acceptance.
const origin = "http://127.0.0.1:39997";
const user = { localUserId: "999", username: "Synthetic layout account", email: "layout@example.invalid", permissions: [
  "dashboard.view", "leads.view", "deals.manage", "deals.view", "leads.manage", "items.view", "items.write",
  "electrical.manage", "civil.manage", "project_manager.manage", "switchgear.manage", "maintenance.manage", "permissions.manage", "users.write",
] };
const report = {
  dateFrom: "2026-10-01", dateTo: "2026-10-12",
  summary: { activeEmployees: 1, totalDeals: 7, wonJobs: 2, wonAmount: "1200.00", unknownAmounts: 0, active: 7, hold: 0, closed: 0 },
  stages: { qualification: 1, siteVisit: 0, proposal: 3, won: 2, lost: 1, omitted: 0, proposalOmitted: 0 },
  wonJobStatuses: { active: 2, hold: 0, closed: 0 }, monthly: [{ month: "2026-10", wonAmount: "1200.00", unknownAmounts: 0 }], monthlySince: "2026-05",
  employees: { items: [{ id: "999", name: "Synthetic employee", departmentRole: null, totalDeals: 2, qualification: 0, siteVisit: 0, proposal: 1, won: 1,
    lost: 0, omitted: 0, proposalOmitted: 0, wonAmount: "200.00", electrical: 0, civil: 0, pm: 0, accounts: 1, assigned: 0, process: 0, completed: 0, active: 1, hold: 0, closed: 0 }], total: 1, page: 1, pageSize: 25 },
};

async function geometry(page: Page) {
  return page.evaluate(() => {
    const boxes = [".pc-sidebar", ".pc-header", ".pc-container", ".crm-report"].map(selector => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { x: rect.x, right: rect.right, width: rect.width, marginLeft: style.marginLeft, visibility: style.visibility, transition: style.transition, inert: element.inert };
    });
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollX,
      sidebar: boxes[0]!, header: boxes[1]!, main: boxes[2]!, report: boxes[3]!,
      shellAnimations: document.getAnimations().filter(animation => (animation.effect as KeyframeEffect | null)?.target instanceof HTMLElement
        && (animation.effect as KeyframeEffect).target!.matches(".pc-sidebar,.pc-header,.pc-container")).length };
  });
}

async function reportReadability(page: Page) {
  return page.locator(".crm-report-summary").evaluate(summary => ({
    columns: getComputedStyle(summary).gridTemplateColumns.split(" ").length,
    phoneBreakpoint: matchMedia("(max-width: 767.98px)").matches,
    tabletBreakpoint: matchMedia("(min-width: 768px) and (max-width: 1024px)").matches,
    cards: [...summary.querySelectorAll<HTMLElement>(".report-card")].map(card => {
      const bounds = card.getBoundingClientRect(), styles = getComputedStyle(card);
      const icon = card.querySelector<HTMLElement>(".report-icon")?.getBoundingClientRect();
      const words: { text: string; lines: number; left: number; right: number }[] = [];
      for (const element of card.querySelectorAll(".report-label,.report-value,small")) {
        const nodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (nodes.nextNode()) for (const match of nodes.currentNode.textContent!.matchAll(/\S+/g)) {
          const range = document.createRange(); range.setStart(nodes.currentNode, match.index!); range.setEnd(nodes.currentNode, match.index! + match[0].length);
          const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
          words.push({ text: match[0], lines: new Set(rects.map(rect => Math.round(rect.top))).size,
            left: Math.min(...rects.map(rect => rect.left)), right: Math.max(...rects.map(rect => rect.right)) });
        }
      }
      return { label: card.querySelector(".report-label")!.textContent, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        contentLeft: bounds.left + parseFloat(styles.paddingLeft), contentRight: bounds.right - parseFloat(styles.paddingRight),
        icon: icon ? { width: icon.width, height: icon.height } : null, words };
    }),
  }));
}

test("OFFLINE source-theme report preserves sidebar geometry and readable laptop/tablet KPI words, amounts and icons", { timeout: 90_000 }, async t => {
  const directory = resolve(".local-data", "reports", `sidebar-layout-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  // Next emits imported globals before the literal PHP-theme stylesheet links.
  // Keep that production cascade order: compatibility rules must win by specificity.
  const styles = ["src/app/globals.css", ...["jquery.dataTables.min.css", "plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css", "select2.min.css"]
    .map(file => "public/legacy/assets/css/" + file)];
  const sources = [...styles, "src/components/crm/chrome.tsx", "src/components/crm/navigation.tsx", "src/components/crm/employee-report.tsx", "tests/sidebar-layout.test.ts"];
  const hashes = Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  const entry = `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {EmployeeReport} from './src/components/crm/employee-report';createRoot(document.getElementById('root')).render(<CrmChrome user={${JSON.stringify(user)}}><EmployeeReport/></CrmChrome>);`;
  const bundle = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-component-stubs", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function useRouter(){return{refresh(){},replace(){}}};export function usePathname(){return '/reports/employee-performance'};export function useSearchParams(){return new URLSearchParams()}"
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] });
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8"))))
    .join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const metrics: object[] = [], images: object[] = [], readability: object[] = [], failures: string[] = [];
  const reportQueries: string[] = [];
  let passed = false;
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { failures.push("unexpected request"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-sidebar-caption="true" data-pc-theme="light" data-pc-direction="ltr"><div id="root"></div><script src="/component.js"></script></body></html>` });
    if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/api/reports/employee-performance") { reportQueries.push(url.search); return route.fulfill({ json: { ...report, dateFrom: url.searchParams.get("dateFrom") || report.dateFrom, dateTo: url.searchParams.get("dateTo") || report.dateTo } }); }
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("unexpected route"); return route.abort();
  });
  const record = async (state: string, width: number, offset: number) => {
    const current = await geometry(page);
    metrics.push({ state, ...current });
    assert.equal(current.viewport, width); assert.equal(current.documentWidth, width); assert.equal(current.scrollX, 0);
    assert.equal(current.header.x, offset, state + " header offset"); assert.equal(current.main.x, offset, state + " content offset");
    assert.equal(current.report.x, offset + (width > 1024 ? 40 : 15), state + " original content padding");
    assert.equal(current.main.right, width); assert.equal(current.shellAnimations, 0, state + " shell offsets must agree in the same frame");
    return current;
  };
  const settleDrawer = () => page.waitForFunction(() => !document.getAnimations().some(animation => (animation.effect as KeyframeEffect | null)?.target instanceof HTMLElement
    && (animation.effect as KeyframeEffect).target!.matches(".pc-sidebar,.pc-header,.pc-container")));
  try {
    await page.goto(origin + "/"); await page.getByText("Synthetic employee", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("From date", { exact: true }).inputValue(), report.dateFrom);
    assert.equal(await page.getByLabel("To date", { exact: true }).inputValue(), report.dateTo);
    assert.equal(await page.getByRole("button", { name: "Apply dates", exact: true }).textContent(), "Filter");
    await page.getByLabel("From date", { exact: true }).fill("2026-09-01"); await page.getByLabel("To date", { exact: true }).fill("2026-09-30");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click(); await page.getByText(/Task creation dates: 2026-09-01 to 2026-09-30/).waitFor();
    assert.equal(await page.getByLabel("From date", { exact: true }).inputValue(), "2026-09-01");
    assert.equal(await page.getByLabel("To date", { exact: true }).inputValue(), "2026-09-30");
    assert.ok(reportQueries.some(query => query.includes("dateFrom=2026-09-01") && query.includes("dateTo=2026-09-30")));
    await page.getByLabel("From date", { exact: true }).fill("2026-10-01"); await page.getByLabel("To date", { exact: true }).fill("2026-10-12");
    await page.getByRole("button", { name: "Apply dates", exact: true }).click(); await page.waitForLoadState("networkidle");
    for (const width of [1440, 1280, 1025, 767, 390, 360, 768, 820, 991, 1024, 1600, 1907]) {
      await page.setViewportSize({ width, height: 1000 });
      const desktop = width > 1024, offset = desktop ? 264 : 0;
      // Preserve the original mobile drawer animation; desktop offsets are immediate.
      if (!desktop) await settleDrawer();
      const current = await record("expanded desktop or closed mobile", width, offset);
      assert.equal(current.sidebar.visibility, desktop ? "visible" : "hidden");
      if (desktop) assert.ok(current.report.x >= current.sidebar.right);
      // Shell geometry above must agree immediately. Let unrelated button hover
      // colors settle before comparing natural and animation-disabled images.
      await page.mouse.move(0, 0);
      await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.effect?.getComputedTiming().endTime === Infinity));
      const natural = await page.screenshot({ fullPage: true });
      await record("after natural full-page screenshot", width, offset);
      const settled = await page.screenshot({ fullPage: true, animations: "disabled" });
      if (desktop) assert.ok(natural.equals(settled), "desktop natural capture must equal settled capture, without a transient sidebar overlap");
      const filename = `report-${width}.png`; await writeFile(join(directory, filename), natural, { flag: "wx" });
      images.push({ filename, sha256: createHash("sha256").update(natural).digest("hex") });
      const readable = await reportReadability(page); readability.push({ width, ...readable });
      assert.deepEqual(readable.cards.map(card => card.label), ["Total Employees", "Total Deals", "Won Jobs", "Total Won Amount", "Active", "Hold Jobs"]);
      assert.equal(readable.phoneBreakpoint, width < 768); assert.equal(readable.tabletBreakpoint, width >= 768 && width <= 1024);
      for (const card of readable.cards) {
        if (card.icon) assert.deepEqual(card.icon, { width: 54, height: 54 }, `${width}px ${card.label}: icons retain their circular dimensions`);
        for (const word of card.words) {
          assert.equal(word.lines, 1, `${width}px ${card.label}: ${word.text} must not split across lines`);
          assert.ok(word.left >= card.contentLeft - 1 && word.right <= card.contentRight + 1, `${width}px ${card.label}: ${word.text} must fit inside its card`);
        }
      }
      if (width >= 768 && width < 1600) {
        assert.equal(readable.columns, 3); assert.equal(new Set(readable.cards.map(card => Math.round(card.y))).size, 2);
      } else assert.equal(readable.columns, width < 768 ? 1 : 6, "wide desktop and phone retain their original KPI column counts");
      if (desktop) {
        await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
        assert.equal((await record("immediately collapsed", width, 0)).sidebar.visibility, "hidden");
        await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
        const expanded = await record("immediately expanded", width, 264); assert.ok(expanded.report.x >= expanded.sidebar.right);
      } else {
        await page.getByRole("button", { name: "Open navigation", exact: true }).click();
        await settleDrawer();
        const open = await record("mobile drawer open", width, 0);
        assert.equal(open.sidebar.x, 0); assert.equal(open.sidebar.width, 264); assert.equal(open.sidebar.visibility, "visible");
        assert.equal(open.main.inert, true); assert.equal(open.header.inert, true);
        assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
        assert.equal(await page.getByRole("button", { name: "Close navigation", exact: true }).evaluate(element => element === document.activeElement), true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.getByRole("link", { name: "Voltronix CRM", exact: true }).evaluate(element => element === document.activeElement), true, await page.evaluate(() => document.activeElement?.outerHTML));
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.getByRole("link", { name: "Your account", exact: true }).evaluate(element => element === document.activeElement), true);
        await page.keyboard.press("Tab");
        assert.equal(await page.getByRole("link", { name: "Voltronix CRM", exact: true }).evaluate(element => element === document.activeElement), true);
        await page.keyboard.press("Tab");
        assert.equal(await page.getByRole("button", { name: "Close navigation", exact: true }).evaluate(element => element === document.activeElement), true);
        await page.keyboard.press("Escape");
        await settleDrawer();
        assert.equal((await record("mobile Escape closed", width, 0)).sidebar.visibility, "hidden");
        assert.equal(await page.getByRole("button", { name: "Open navigation", exact: true }).evaluate(element => element === document.activeElement), true);
        assert.equal(await page.evaluate(() => document.body.style.overflow), "");
        assert.equal((await geometry(page)).main.inert, false);
      }
    }
    assert.deepEqual(failures, []); passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", verifiedAt: new Date().toISOString(),
      scope: "Actual React chrome/report with intercepted synthetic GETs and original PHP theme; Next navigation/link/image adapters stubbed, fonts/imports omitted. No server, authentication, credentials, database or business writes. Not live CRM acceptance.",
      stylesheetOrder: styles, sourceSha256: hashes, reportQueries, metrics, readability, images, failures }, null, 2), { flag: "wx" });
    t.diagnostic("Sidebar component evidence: " + directory);
  }
});
