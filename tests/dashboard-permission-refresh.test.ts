import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";

type FixtureUser = { localUserId: string; externalUserId: string | null; username: string; email: string; permissions: string[] };
const initialUser = (): FixtureUser => ({ localUserId: "999", externalUserId: "external-999", username: "Synthetic employee",
  email: "fixture@example.invalid", permissions: ["dashboard.view", "sales_dashboard.view", "leads.view"] });
let fixtureBundle: Promise<string> | undefined;

function bundle() {
  return fixtureBundle ??= build({ stdin: { loader: "tsx", resolveDir: process.cwd(), contents: `
    import {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {CrmChrome} from './src/components/crm/chrome';
    import {Dashboard} from './src/components/crm/dashboard';
    window.fixtureRouter = { refresh() {} };
    function App() {
      const [user, setUser] = useState(window.fixtureInitialUser);
      const [draft, setDraft] = useState('');
      const [mounted, setMounted] = useState(true);
      window.fixtureRouter.refresh = () => {
        window.fixtureRefreshes++;
        fetch('/fixture-user').then(response => response.json()).then(result => setUser(result.user));
      };
      return <CrmChrome user={user}>
        <label>Unsaved fixture note<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
        <output aria-label="Current fixture binding">{user.externalUserId ?? 'unlinked'}</output>
        <button onClick={() => setMounted(false)}>Leave dashboard fixture</button>
        {mounted && <Dashboard user={location.search.includes('without-user') ? undefined : user} />}
      </CrmChrome>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  ` }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "next-component-stubs", setup(api) {
      api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
        ? "export function usePathname(){return '/dashboard'};export function useSearchParams(){return new URLSearchParams()};export function useRouter(){return window.fixtureRouter}"
        : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
          : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
    } }] }).then(result => result.outputFiles[0]!.text);
}

async function fixture(withoutUser = false) {
  const script = await bundle();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  page.setDefaultTimeout(10_000);
  const origin = "http://127.0.0.1:39983";
  const state: { user: FixtureUser; routeUser?: FixtureUser; authStatus: number; authBody?: unknown; nextAuthGate?: Promise<void>; authReads: number;
    dashboardReads: URL[]; serverReads: number; documentReads: number; failures: string[] } = {
      user: initialUser(), authStatus: 200, authReads: 0, dashboardReads: [], serverReads: 0, documentReads: 0, failures: [],
    };
  page.on("pageerror", error => state.failures.push(error.message));
  await page.routeWebSocket("**/*", socket => { state.failures.push("Unexpected websocket"); socket.close(); });
  await page.addInitScript("window.fixtureVisibility = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.fixtureVisibility });");
  await page.clock.install({ time: new Date("2026-10-26T08:00:00Z") });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") { state.failures.push("Unexpected origin or mutation"); return route.abort(); }
    if (url.pathname === "/dashboard") {
      state.documentReads++;
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><div id="root"></div><script>window.fixtureInitialUser=${JSON.stringify(state.user)};window.fixtureRefreshes=0;</script><script src="/fixture.js"></script></body></html>` });
    }
    if (url.pathname === "/login") return route.fulfill({ contentType: "text/html", body: "<h1>Sign in fixture</h1>" });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture-user") { state.serverReads++; return route.fulfill({ json: { user: state.routeUser ?? state.user } }); }
    if (url.pathname === "/api/auth/me") {
      state.authReads++;
      const status = state.authStatus, body = JSON.stringify(state.authBody ?? { user: state.user });
      const gate = state.nextAuthGate;
      state.nextAuthGate = undefined;
      if (gate) await gate;
      // A deliberately held response can finish after the hook aborts its request.
      try { return await route.fulfill({ status, contentType: "application/json", body }); }
      catch (error) { if (!gate) throw error; }
      return;
    }
    if (url.pathname === "/api/dashboard") {
      state.dashboardReads.push(url);
      const has = (grant: string) => state.user.permissions.includes(grant);
      return route.fulfill({ json: {
        global: has("dashboard.view") ? {
          wonJobs: 2, pendingAssignmentJobs: 1, completedJobs: 0,
          accounts: { totalPending: "0.00", pendingJobs: 0, unknownServiceChargeJobs: 0 },
          pipeline: [{ key: "qualification", label: "Qualification", count: 1, percentage: "100" }],
          employees: { items: [{ id: "999", name: "Synthetic workload row", electrical: 1, civil: 0, pm: 0 }],
            total: 51, page: Number(url.searchParams.get("employeePage")), pageSize: 25 },
          departmentProgress: [], leadsToday: 6, leadsThisMonth: 6,
        } : null,
        sales: has("sales_dashboard.view") ? { total: 2, today: 2, thisMonth: 2, stages: [
          { key: "qualification", label: "Qualification", count: 1 }, { key: "site_visit", label: "Site Visit", count: 0 },
          { key: "proposal", label: "Proposal", count: 0 }, { key: "won", label: "Won", count: 1 }, { key: "lost", label: "Lost", count: 0 },
        ] } : null,
        departments: [["pm_dashboard.view", "PM"], ["maintenance_dashboard.view", "Maintenance"]]
          .filter(([grant]) => has(grant!)).map(([, department]) => ({ department, total: 1, pending: 1, process: 0,
            completed: 0, hold: 0, assignedToday: 0, completedAssignedThisMonth: 0 })),
      } });
    }
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    state.failures.push("Unexpected route: " + url.pathname);
    return route.abort();
  });
  try {
    await page.goto(origin + "/dashboard" + (withoutUser ? "?without-user=1" : ""));
    await page.getByText("Synthetic workload row", { exact: true }).waitFor();
  } catch (error) { await browser.close(); throw error; }
  return { page, state, async close() { await browser.close(); assert.deepEqual(state.failures, []); } };
}

async function focus(page: Page) { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); }
async function visible(page: Page, value: "visible" | "hidden") {
  await page.evaluate(value => {
    (window as unknown as { fixtureVisibility: string }).fixtureVisibility = value;
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}
async function authCheck(page: Page, trigger = () => focus(page)) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/me");
  await trigger();
  await (await response).finished();
  await page.waitForTimeout(40);
}
async function refreshed(page: Page, count: number) {
  await page.waitForFunction(count => (window as unknown as { fixtureRefreshes: number }).fixtureRefreshes === count, count);
  await page.getByText("Synthetic workload row", { exact: true }).waitFor();
}

test("an open dashboard refreshes added and removed grants in its cards and navigation without resetting applied filters or unrelated drafts", { timeout: 90_000 }, async () => {
  const { page, state, close } = await fixture();
  try {
    assert.equal(state.authReads, 0, "The server-authorized initial page does not need a duplicate auth read");
    await page.getByLabel("Unsaved fixture note").fill("Keep my draft");
    const workload = page.getByRole("region", { name: "Employee workload" });
    await workload.getByLabel("Search employees").fill("Synthetic");
    await workload.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByText("Synthetic workload row", { exact: true }).waitFor();
    await workload.getByRole("button", { name: "Next page" }).click();
    await workload.getByText(/Page 2 of 3/).waitFor();
    const previousReads = state.dashboardReads.length;
    state.user = { ...state.user, permissions: [...state.user.permissions, "pm_dashboard.view", "maintenance_dashboard.view"] };
    await authCheck(page);
    await refreshed(page, 1);
    await page.getByRole("region", { name: "Your PM jobs", exact: true }).waitFor();
    await page.getByRole("region", { name: "Your Maintenance jobs", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).locator('a[href="/dashboard?section=pm"]').count(), 1);
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).locator('a[href="/dashboard?section=maintenance"]').count(), 1);
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).locator('a[href^="/departments/"]').count(), 0,
      "Dashboard grants add summary links without adding job-management access");
    assert.equal(state.dashboardReads.length, previousReads + 1, "Changed grants refresh the client dashboard GET as well as the server shell");
    assert.equal(state.serverReads, 1);
    assert.equal(state.documentReads, 1, "Same-account changes merge the route rather than navigating the document");
    assert.equal(state.dashboardReads.at(-1)!.searchParams.get("employeeSearch"), "Synthetic");
    assert.equal(state.dashboardReads.at(-1)!.searchParams.get("employeePage"), "2");
    assert.equal(await page.getByLabel("Unsaved fixture note").inputValue(), "Keep my draft");

    state.user = { ...state.user, permissions: [...state.user.permissions].reverse().concat("dashboard.view") };
    await page.clock.fastForward(1_100);
    await authCheck(page);
    assert.equal(state.serverReads, 1, "Ordering and duplicate grants do not trigger refreshes");
    assert.equal(state.dashboardReads.length, previousReads + 1);

    state.user = { ...state.user, permissions: initialUser().permissions };
    await page.clock.fastForward(1_100);
    await authCheck(page);
    await refreshed(page, 2);
    assert.equal(await page.getByRole("region", { name: "Your PM jobs", exact: true }).count(), 0);
    assert.equal(await page.getByRole("region", { name: "Your Maintenance jobs", exact: true }).count(), 0);
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).locator('a[href="/dashboard?section=pm"]').count(), 0);
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).locator('a[href="/dashboard?section=maintenance"]').count(), 0);

    state.user = { ...state.user, externalUserId: null };
    await page.clock.fastForward(1_100);
    await authCheck(page);
    await refreshed(page, 3);
    await page.getByRole("status", { name: "Current fixture binding" }).getByText("unlinked", { exact: true }).waitFor();
    assert.equal(state.documentReads, 1, "Rebinding the same account reloads its data without mixing in another account");
    assert.equal(await page.getByLabel("Unsaved fixture note").inputValue(), "Keep my draft");

    state.user = { ...state.user, permissions: [...state.user.permissions, "maintenance_dashboard.view"] };
    const readsBeforeManual = state.dashboardReads.length, authBeforeManual = state.authReads;
    await page.getByRole("button", { name: "Refresh dashboard", exact: true }).click();
    await refreshed(page, 4);
    await page.getByRole("region", { name: "Your Maintenance jobs", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).locator('a[href="/dashboard?section=maintenance"]').count(), 1);
    assert.equal(state.dashboardReads.length, readsBeforeManual + 1);
    assert.equal(state.authReads, authBeforeManual, "Manual refresh directly reauthorizes the route without an extra probe");
    assert.equal(state.dashboardReads.at(-1)!.searchParams.get("employeeSearch"), "Synthetic");
    assert.equal(state.dashboardReads.at(-1)!.searchParams.get("employeePage"), "2");
    assert.equal(await page.getByLabel("Unsaved fixture note").inputValue(), "Keep my draft");
  } finally { await close(); }
});

test("dashboard permission checks are bounded, visibility-aware and recover from temporary or malformed auth responses", { timeout: 90_000 }, async () => {
  const { page, state, close } = await fixture();
  let release: (() => void) | undefined;
  try {
    await visible(page, "hidden");
    await page.clock.fastForward(90_000);
    await focus(page);
    assert.equal(state.authReads, 0, "Hidden tabs do not poll or react to focus events");
    await authCheck(page, () => visible(page, "visible"));
    assert.equal(state.authReads, 1);
    assert.equal(state.serverReads, 0, "Unchanged grants keep the current dashboard");
    await page.clock.fastForward(1_100);

    state.nextAuthGate = new Promise<void>(resolve => { release = resolve; });
    const request = page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/me");
    await focus(page);
    await request;
    await focus(page);
    await visible(page, "visible");
    await page.clock.fastForward(2_000);
    await focus(page);
    assert.equal(state.authReads, 2, "Concurrent focus/visibility events share the pending check");
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/me");
    release!(); release = undefined;
    await (await completed).finished();
    await page.waitForTimeout(40);
    assert.equal(state.serverReads, 0);

    state.authStatus = 503;
    await authCheck(page);
    assert.equal(state.serverReads, 0, "A temporary service outage must not revoke or replace current grants");
    assert.equal(await page.getByRole("region", { name: "Job overview", exact: true }).count(), 1);
    state.authStatus = 200;
    for (const body of [{ user: null }, { user: { ...state.user, localUserId: "invalid" } }, { user: { ...state.user, permissions: ["dashboard.view", 1] } }]) {
      state.authBody = body;
      await page.clock.fastForward(1_100);
      await authCheck(page);
      assert.equal(state.serverReads, 0, "Malformed auth data must not become UI authority");
    }
    state.authBody = undefined;
    state.user = { ...state.user, permissions: [...state.user.permissions, "pm_dashboard.view"] };
    await authCheck(page, () => page.clock.fastForward(30_000));
    await refreshed(page, 1);
    await page.getByRole("region", { name: "Your PM jobs", exact: true }).waitFor();
    const readsAfterChange = state.authReads;
    await focus(page);
    await visible(page, "visible");
    await page.waitForTimeout(40);
    assert.ok(state.authReads <= readsAfterChange + 1, "Simultaneous events are coalesced even after a new server prop");
    assert.equal(state.serverReads, 1);

    await page.getByRole("button", { name: "Leave dashboard fixture" }).click();
    const readsAfterUnmount = state.authReads;
    await page.clock.fastForward(90_000);
    await focus(page);
    await visible(page, "visible");
    assert.equal(state.authReads, readsAfterUnmount, "Leaving the dashboard removes its timer and event listeners");
    assert.equal(await page.getByLabel("Unsaved fixture note").count(), 1);
  } finally { release?.(); await close(); }
});

test("expired and switched accounts navigate to fixed authorized routes, while standalone dashboards do not probe auth", { timeout: 90_000 }, async () => {
  const { page, state, close } = await fixture();
  try {
    await page.getByLabel("Unsaved fixture note").fill("Previous account draft");
    state.user = { ...state.user, localUserId: "1000", externalUserId: "external-1000", username: "Other synthetic employee" };
    const navigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
    await focus(page);
    await navigation;
    await page.getByRole("button", { name: "User menu" }).getByText("Hello! Other synthetic employee", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/dashboard");
    assert.equal(state.documentReads, 2);
    assert.equal(state.serverReads, 0, "A different local account must not merge into old client state");
    assert.equal(await page.getByLabel("Unsaved fixture note").inputValue(), "");
    state.authStatus = 401;
    await focus(page);
    await page.waitForURL("**/login");
    await page.getByRole("heading", { name: "Sign in fixture" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Job overview", exact: true }).count(), 0);
  } finally { await close(); }

  const standalone = await fixture(true);
  try {
    await standalone.page.clock.fastForward(90_000);
    await focus(standalone.page);
    await visible(standalone.page, "visible");
    assert.equal(standalone.state.authReads, 0);
    assert.equal(standalone.state.serverReads, 0);
    await standalone.page.getByRole("button", { name: "Refresh dashboard", exact: true }).click();
    await refreshed(standalone.page, 1);
    assert.equal(standalone.state.dashboardReads.length, 2, "The explicit refresh still works in isolated consumers");
  } finally { await standalone.close(); }
});

test("timed-out auth responses cannot restore stale grants and a delayed server refresh retries without an event storm", { timeout: 90_000 }, async () => {
  const { page, state, close } = await fixture();
  let release: (() => void) | undefined;
  try {
    state.user = { ...state.user, permissions: [...state.user.permissions, "pm_dashboard.view", "project_manager.manage"] };
    state.nextAuthGate = new Promise<void>(resolve => { release = resolve; });
    const request = page.waitForRequest(request => new URL(request.url()).pathname === "/api/auth/me");
    await focus(page);
    await request;
    const aborted = page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/auth/me");
    await page.clock.fastForward(5_100);
    await aborted;
    assert.equal(state.serverReads, 0, "A timed-out permission request does not replace the current UI");

    state.routeUser = initialUser();
    state.user = { ...initialUser(), permissions: [...initialUser().permissions, "maintenance_dashboard.view", "maintenance.manage"] };
    await authCheck(page);
    await refreshed(page, 1);
    assert.equal(state.authReads, 2, "Timeout releases the in-flight guard so a fresh check can recover");
    await page.getByRole("region", { name: "Your Maintenance jobs", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).getByRole("button", { name: "Maintenance", exact: true }).count(), 0,
      "The auth probe itself is not merged directly into navigation grants");
    release!(); release = undefined;
    await page.waitForTimeout(40);
    assert.equal(state.serverReads, 1, "Late timed-out data must not refresh the route again");
    assert.equal(await page.getByRole("region", { name: "Your PM jobs", exact: true }).count(), 0);

    await page.clock.fastForward(1_100);
    await authCheck(page);
    assert.equal(state.serverReads, 1, "Repeated change observations cannot cause a refresh storm while RSC catches up");
    state.routeUser = undefined;
    await page.clock.fastForward(5_100);
    await authCheck(page);
    await refreshed(page, 2);
    await page.getByRole("navigation", { name: "CRM navigation" }).getByRole("button", { name: "Maintenance", exact: true }).waitFor();
    assert.equal(state.documentReads, 1);
    assert.equal(await page.getByRole("navigation", { name: "CRM navigation" }).getByRole("button", { name: "Project Manager", exact: true }).count(), 0);
  } finally { release?.(); await close(); }
});
