import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { Script } from "node:vm";
import { build } from "esbuild";
import { chromium } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// Independent expected permissions: an operational management grant does not
// authorize its dashboard, and a dashboard grant does not authorize job reads.
const sections = [
  { key: "sales", grant: "sales_dashboard.view", label: "Sales", department: null, manage: null },
  { key: "electrical", grant: "electric_dashboard.view", label: "Electrical", department: "Electrical", manage: "electrical.manage" },
  { key: "civil", grant: "civil_dashboard.view", label: "Civil", department: "Civil", manage: "civil.manage" },
  { key: "pm", grant: "pm_dashboard.view", label: "Project Manager", department: "PM", manage: "project_manager.manage" },
  { key: "switchgear", grant: "switchgear_dashboard.view", label: "Switchgear", department: "Switchgear", manage: "switchgear.manage" },
  { key: "maintenance", grant: "maintenance_dashboard.view", label: "Maintenance", department: "Maintenance", manage: "maintenance.manage" },
] as const;
const userWith = (permissions: readonly string[]) => ({ localUserId: "999", externalUserId: "external-999", username: "Synthetic employee",
  email: "fixture@example.invalid", permissions: [...permissions] });

test("the server dashboard page authorizes each focused section with its exact view grant", async () => {
  const result = await build({ entryPoints: ["src/app/dashboard/page.tsx"], bundle: true, write: false, platform: "node", format: "cjs",
    jsx: "automatic", external: ["react", "react/jsx-runtime"], plugins: [{ name: "dashboard-page-context", setup(api) {
      api.onResolve({ filter: /^(?:next\/navigation|@\/server\/frontend-auth|@\/components\/crm\/(?:shell|dashboard))$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "next/navigation"
        ? "export function notFound(){throw new Error('FIXTURE_NOT_FOUND')};export function redirect(path){throw new Error('FIXTURE_REDIRECT:'+path)}"
        : args.path.endsWith("frontend-auth") ? "export async function currentUser(){return globalThis.fixtureUser}"
          : args.path.endsWith("shell") ? "export function CrmShell({children}){return children}"
            : "import React from 'react';export function Dashboard({user,section}){return React.createElement('output',{'data-user':user.localUserId,'data-section':section??'all'})}",
        loader: "js", resolveDir: process.cwd() }));
    } }] });
  const script = new Script(result.outputFiles[0]!.text, { filename: "dashboard-page-fixture.cjs" });
  async function render(permissions: readonly string[] | null, section?: string | string[]) {
    const module = { exports: {} as { default: (props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<ReactNode> } };
    script.runInNewContext({ exports: module.exports, module, require: createRequire(import.meta.url),
      fixtureUser: permissions === null ? null : userWith(permissions) });
    return renderToStaticMarkup(await module.exports.default({ searchParams: Promise.resolve({ section }) }));
  }
  assert.match(await render(["dashboard.view"]), /data-section="all"/);
  for (const section of sections) {
    const rendered = await render([section.grant], section.key);
    assert.match(rendered, new RegExp('data-section="' + section.key + '"'));
    assert.match(rendered, /data-user="999"/);
    assert.match(await render([section.grant]), /data-section="all"/, "A focused grant also retains the combined dashboard entry");
    await assert.rejects(render([], section.key), /FIXTURE_NOT_FOUND/);
    await assert.rejects(render(["dashboard.view"], section.key), /FIXTURE_NOT_FOUND/, "Global summary access does not imply a department dashboard grant");
    await assert.rejects(render(sections.filter(other => other.key !== section.key).map(other => other.grant), section.key), /FIXTURE_NOT_FOUND/);
    if (section.manage) await assert.rejects(render([section.manage], section.key), /FIXTURE_NOT_FOUND/);
  }
  const all = ["dashboard.view", ...sections.map(section => section.grant)];
  for (const invalid of ["unknown", "PM", "../jobs", "", ["pm", "maintenance"], ["pm", "pm"]]) {
    await assert.rejects(render(all, invalid), /FIXTURE_NOT_FOUND/, "Malformed or ambiguous section names cannot silently select a dashboard");
  }
  await assert.rejects(render(null, "pm"), /FIXTURE_REDIRECT:\/login/);
});

async function browserFixture() {
  const result = await build({ stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
    import {createRoot} from 'react-dom/client';
    import {useSearchParams} from 'next/navigation';
    import {CrmChrome} from './src/components/crm/chrome';
    import {Dashboard} from './src/components/crm/dashboard';
    function App(){const query=useSearchParams();return <CrmChrome user={window.fixtureUser}><Dashboard section={query.get('section')??undefined}/></CrmChrome>}
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-dashboard-route-context", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation") ? `
        import {useSyncExternalStore} from 'react';
        const subscribe=callback=>{window.addEventListener('fixture-route',callback);return()=>window.removeEventListener('fixture-route',callback)};
        const snapshot=()=>location.href;
        function url(){return new URL(useSyncExternalStore(subscribe,snapshot))}
        const router={refresh(){}};
        export function usePathname(){return url().pathname}
        export function useSearchParams(){return url().searchParams}
        export function useRouter(){return router}
      ` : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
        : `import React from'react';export default function Link({onClick,href,...props}){return React.createElement('a',{...props,href,onClick(event){onClick?.(event);event.preventDefault();history.pushState(null,'',href);window.dispatchEvent(new Event('fixture-route'))}})}`,
      loader: "js", resolveDir: process.cwd() }));
    } }] });
  const styles = ["src/app/globals.css", ...["jquery.dataTables.min.css", "plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css", "select2.min.css"]
    .map(file => "public/legacy/assets/css/" + file)];
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n")
    .replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const origin = "http://127.0.0.1:39984", state = { user: userWith([]), failures: [] as string[], reads: 0 };
  page.on("pageerror", error => state.failures.push(error.message));
  await page.routeWebSocket("**/*", socket => { state.failures.push("Unexpected websocket"); socket.close(); });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { state.failures.push("Unexpected origin or mutation"); return route.abort(); }
    if (url.pathname === "/dashboard") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-theme="light" data-pc-direction="ltr"><div id="root"></div><script>window.fixtureUser=${JSON.stringify(state.user)}</script><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: result.outputFiles[0]!.text });
    if (url.pathname === "/api/dashboard") {
      state.reads++;
      const has = (grant: string) => state.user.permissions.includes(grant);
      return route.fulfill({ json: {
        global: has("dashboard.view") ? { wonJobs: 2, pendingAssignmentJobs: 1, completedJobs: 0,
          accounts: { totalPending: "0.00", pendingJobs: 0, unknownServiceChargeJobs: 0 }, pipeline: [],
          employees: { items: [], total: 0, page: 1, pageSize: 25 }, departmentProgress: [], leadsToday: 6, leadsThisMonth: 6 } : null,
        sales: has("sales_dashboard.view") ? { total: 2, today: 1, thisMonth: 2, stages: [
          { key: "qualification", label: "Qualification", count: 1 }, { key: "site_visit", label: "Site Visit", count: 0 },
          { key: "proposal", label: "Proposal", count: 0 }, { key: "won", label: "Won", count: 1 }, { key: "lost", label: "Lost", count: 0 },
        ] } : null,
        departments: sections.filter(section => section.department && has(section.grant)).map(section => ({ department: section.department,
          total: 1, pending: 1, process: 0, completed: 0, hold: 0, assignedToday: 0, completedAssignedThisMonth: 0 })),
      } });
    }
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    state.failures.push("Unexpected route: " + url.pathname); return route.abort();
  });
  return { page, state, async goto(permissions: readonly string[], section?: string) {
    state.user = userWith(permissions);
    await page.goto(origin + "/dashboard" + (section ? "?section=" + section : ""));
    await page.getByRole("navigation", { name: "CRM navigation" }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.crm-dashboard [role="status"]'));
  }, async close() { await browser.close(); assert.deepEqual(state.failures, []); } };
}

test("view-only grants expose sidebar dashboards without job links and combined grants reuse their management group", { timeout: 90_000 }, async () => {
  const { page, goto, close } = await browserFixture();
  try {
    const nav = page.getByRole("navigation", { name: "CRM navigation" });
    for (const section of sections) {
      await goto([section.grant]);
      const link = nav.locator('a[href="/dashboard?section=' + section.key + '"]');
      assert.equal(await link.count(), 1, section.key + " view permission must expose exactly one dashboard link");
      assert.match(await link.innerText(), new RegExp(section.label, "i"));
      assert.equal(await nav.locator('a[href^="/departments/"]').count(), 0, "A summary permission does not add management links");
      assert.equal(await nav.locator('a[href^="/jobs"]').count(), 0);
      for (const other of sections.filter(other => other.key !== section.key)) assert.equal(await nav.locator('a[href="/dashboard?section=' + other.key + '"]').count(), 0);
      if (!section.manage) continue;
      await goto([section.manage]);
      assert.equal(await nav.locator('a[href^="/dashboard?section="]').count(), 0, "Management alone does not add summary access");
      await nav.getByRole("button", { name: section.label, exact: true }).click();
      assert.equal(await nav.getByRole("link", { name: section.department + " jobs", exact: true }).getAttribute("href"), "/departments/" + section.department + "/jobs");
      assert.equal(await nav.locator('a[href^="/departments/' + section.department + '/jobs"]').count(), 5);
      await goto([section.manage, section.grant]);
      assert.equal(await nav.getByRole("button", { name: section.label, exact: true }).count(), 1, "Combined grants reuse the existing department group");
      await nav.getByRole("button", { name: section.label, exact: true }).click();
      assert.equal(await link.count(), 1);
      assert.equal(await nav.locator('a[href^="/departments/' + section.department + '/jobs"]').count(), 5);
    }
    await goto([]);
    assert.equal(await nav.locator('a[href^="/dashboard"]').count(), 0);
  } finally { await close(); }
});

test("focused sidebar destinations show only their authorized section, mark the selected link, and close the mobile drawer", { timeout: 90_000 }, async () => {
  const { page, goto, state, close } = await browserFixture();
  try {
    const all = ["dashboard.view", ...sections.map(section => section.grant)];
    await goto(all);
    await page.getByRole("region", { name: "Job overview", exact: true }).waitFor();
    for (const section of sections.filter(section => section.department)) assert.equal(await page.getByRole("region", { name: "Your " + section.department + " jobs", exact: true }).count(), 1);
    const nav = page.getByRole("navigation", { name: "CRM navigation" });
    for (const section of sections) {
      await nav.locator('a[href="/dashboard?section=' + section.key + '"]').click();
      await page.waitForURL("**/dashboard?section=" + section.key);
      await page.waitForFunction(() => !document.querySelector('.crm-dashboard [role="status"]'));
      assert.equal(await page.getByRole("region", { name: "Job overview", exact: true }).count(), 0, "A focused view does not include the global overview");
      assert.equal(await page.getByRole("region", { name: "Employee workload", exact: true }).count(), 0);
      for (const department of sections.filter(item => item.department)) assert.equal(await page.getByRole("region", { name: "Your " + department.department + " jobs", exact: true }).count(), department.key === section.key ? 1 : 0);
      assert.equal(await page.getByRole("region", { name: "Your sales leads", exact: true }).count(), section.key === "sales" ? 1 : 0);
      assert.equal(await nav.locator('a[aria-current="page"]').count(), 1, "Only the selected dashboard entry is active");
      assert.equal(await nav.locator('a[aria-current="page"]').getAttribute("href"), "/dashboard?section=" + section.key);
      assert.match(await page.locator(".page-header-title").innerText(), new RegExp(section.label, "i"));
    }
    assert.equal(state.reads, 1, "Switching focused sections reuses the already-authorized combined dashboard response");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Open navigation", exact: true, includeHidden: true }).getAttribute("aria-expanded"), "true");
    await nav.locator('a[href="/dashboard?section=pm"]').click();
    await page.waitForURL("**/dashboard?section=pm");
    await page.getByRole("region", { name: "Your PM jobs", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Open navigation", exact: true }).getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByRole("button", { name: "Dismiss navigation", exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    assert.equal(await page.locator(".pc-sidebar").getAttribute("class"), "pc-sidebar");
  } finally { await close(); }
});
