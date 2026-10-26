import { preservedSource } from "./helpers/preserved-source";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { pipelineEntry } from "../src/components/crm/pipeline-entry";

test("pipeline page entry recognizes only the source own and agent views", () => {
  assert.deepEqual(pipelineEntry({}), { own: false, agents: false });
  assert.deepEqual(pipelineEntry({ scope: "own", view: "agents" }), { own: true, agents: true });
  assert.deepEqual(pipelineEntry({ scope: "all", view: "arbitrary" }), { own: false, agents: false });
  assert.deepEqual(pipelineEntry({ scope: ["own", "default"], view: ["agents", "agents"] }), { own: false, agents: false });
});

test("source own and Search Agent navigation retain URL state, scoped reads and responsive filters", { timeout: 90_000 }, async t => {
  const source = await readFile(preservedSource("application/controllers/Admincrm.php"), "utf8");
  assert.match(source, /public function Admin_Pipeline_Dashboard\(\)[\s\S]*?view_pipeline_dashboard_agent\(\$zoho_user_id\)/);
  assert.match(source, /public function Search_Agent_Pipeline\(\)[\s\S]*?Search_Agent_Pipeline.php/);
  const originalSearch = await readFile(preservedSource("application/views/Leads_Pipeline/Search_Agent_Pipeline.php"), "utf8");
  assert.ok(originalSearch.includes('id="agentFilter"'));
  const origin = "http://127.0.0.1:39988", directory = resolve(".local-data/reports/pipeline-entry-" + randomUUID());
  await mkdir(directory, { recursive: true });
  const bundle = await build({ stdin: { contents: `import{createRoot}from'react-dom/client';import{CrmChrome}from'./src/components/crm/chrome';import{Pipeline}from'./src/components/crm/pipeline';import{pipelineEntry}from'./src/components/crm/pipeline-entry';const query=new URLSearchParams(location.search),values=key=>query.getAll(key).length===1?query.get(key):query.getAll(key),entry=pipelineEntry({scope:values('scope'),view:values('view')}),permissions=window.__fixtureGrants;createRoot(document.getElementById('root')).render(<CrmChrome user={{localUserId:'999',username:'Synthetic manager',email:'fixture@example.invalid',permissions}}><Pipeline forcedOwn={permissions.includes('leads.manage.agents')} initialOwn={entry.own} showAgentFilter={entry.agents}/></CrmChrome>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-fixture", setup(api) {
    api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation") ? "export function usePathname(){return location.pathname};export function useSearchParams(){return new URLSearchParams(location.search)};export function useRouter(){return{refresh(){},replace(){}}}" : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}" : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const styles = ["src/app/globals.css", ...["jquery.dataTables.min.css", "plugins/phosphor-icons.css", "plugins/tabler-icons.min.css", "hrms.css", "style.css", "select2.min.css"].map(file => "public/legacy/assets/css/" + file)];
  const fonts = await Promise.all([["Phosphor", "public/legacy/assets/css/plugins/Phosphor.woff2"], ["tabler-icons", "public/legacy/assets/css/plugins/fonts/tabler-icons.woff2"]].map(async ([family, file]) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${(await readFile(file!)).toString("base64")}) format("woff2");font-weight:normal;font-style:normal;}`));
  const css = (await Promise.all(styles.map(file => readFile(file, "utf8")))).join("\n").replace(/@font-face\s*\{[^}]*\}/g, "").replace(/@import[^;]+;/g, "") + fonts.join("\n");
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  let grants = ["leads.view", "leads.manage"], passed = false;
  const requests: string[] = [], failures: string[] = [], checks: string[] = [], screenshots: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(request.method() + " " + url.pathname + url.search);
    if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected request"); return route.abort(); }
    if (url.pathname === "/pipeline") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>${css}</style></head><body data-pc-preset="preset-1" data-pc-theme="light" data-pc-direction="ltr" data-pc-sidebar-caption="true"><div id="root"></div><script>window.__fixtureGrants=${JSON.stringify(grants)}</script><script src="/fixture.js"></script></body></html>` });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    if (url.pathname === "/api/pipeline") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25, scope: url.searchParams.get("scope") === "own" ? "own" : "all", counts: { qualification: 0, siteVisit: 0, proposal: 0, won: 0, lost: 0, other: 0 } } });
    if (url.pathname === "/api/pipeline/agents") return route.fulfill({ json: { items: [{ externalId: "fixture-agent", name: "Synthetic permitted agent" }], total: 1, page: 1, pageSize: 25 } });
    failures.push("Unexpected route"); return route.abort();
  });
  const ready = () => page.getByRole("region", { name: "Lead pipeline board", exact: true }).waitFor();
  const scope = async (expected: string) => {
    await ready();
    const query = new URL(requests.filter(request => request.startsWith("GET /api/pipeline?")).at(-1)!.slice(4), origin).searchParams;
    assert.equal(query.get("scope"), expected);
  };
  try {
    await page.goto(origin + "/pipeline"); await scope("default");
    assert.equal(await page.getByRole("link", { name: "Your pipeline", exact: true }).textContent(), "Synthetic manager Pipeline");
    await page.getByRole("link", { name: "Your pipeline", exact: true }).click(); await scope("own");
    assert.equal(new URL(page.url()).search, "?scope=own");
    assert.equal(await page.getByRole("checkbox", { name: "Only my assigned leads", exact: true, includeHidden: true }).isChecked(), true);
    assert.equal(await page.getByRole("link", { name: "Your pipeline", exact: true }).getAttribute("aria-current"), "page");
    await page.reload(); await scope("own");
    await page.goBack(); await scope("default");
    await page.goForward(); await scope("own"); checks.push("Manager own entry and reload/Back/Forward use own API scope");
    await page.getByRole("link", { name: "Search agent pipeline", exact: true }).click(); await scope("default");
    assert.equal(new URL(page.url()).search, "?view=agents");
    assert.equal(await page.locator(".page-header-title").textContent(), "Search Agent Pipeline");
    const select = page.getByLabel("Assigned agent", { exact: true }); await select.waitFor({ state: "visible" });
    assert.equal(await select.locator("option").first().textContent(), "All Agents");
    assert.equal(await select.locator('option[value="unassigned"]').textContent(), "Not Assigned");
    assert.equal(await page.locator(".pipeline-agent-search-options").getAttribute("open"), null);
    assert.equal(await page.locator(".pipeline-filter-options").getAttribute("open"), null);
    assert.equal(await page.getByRole("link", { name: "Search agent pipeline", exact: true }).getAttribute("aria-current"), "page");
    const agentResponse = page.waitForResponse(response => response.url().includes("/api/pipeline?") && new URL(response.url()).searchParams.get("agentId") === "fixture-agent");
    await select.selectOption("fixture-agent"); await agentResponse; await ready();
    await page.reload(); await scope("default"); await select.waitFor({ state: "visible" }); checks.push("Search Agent entry places the original native agent selector beside search and survives reload");
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const bounds = await select.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      const search = await page.locator(".pipeline-search-form").boundingBox(); assert.ok(search);
      if (width >= 768) { assert.ok(Math.abs(search.y - bounds.y) < 3); assert.ok(bounds.x + bounds.width <= search.x); assert.ok(bounds.width <= 220); }
      else { assert.ok(search.y > bounds.y); assert.ok(Math.abs(search.x - bounds.x) < 2); }
      await page.evaluate(async () => { await document.fonts.ready; });
      const name = `agent-search-${width}.png`; await page.screenshot({ path: join(directory, name), fullPage: true, animations: "disabled" }); screenshots.push(name);
      checks.push(`${width}px source agent/search toolbar contained; narrow controls stack`);
    }
    await page.locator(".pipeline-agent-search-options summary").click();
    const agentQuery = page.getByRole("searchbox", { name: "Find an agent", exact: true });
    await agentQuery.waitFor({ state: "visible" });
    const filteredAgents = page.waitForResponse(response => response.url().includes("/api/pipeline/agents?") && new URL(response.url()).searchParams.get("query") === "Synthetic");
    await agentQuery.fill("Synthetic"); await filteredAgents;
    assert.equal(await page.locator(".pipeline-agent-search-options").getByRole("button", { name: "Next page", exact: true }).count(), 1);
    checks.push("Expandable bounded agent search and pagination remain available without replacing the source selector");
    for (const role of [["leads.manage.agents"], ["leads.view", "leads.manage", "leads.manage.agents"]]) {
      grants = role;
      for (const query of ["?scope=default&view=agents", "?scope=own", "?scope=all&view=agents"]) {
        await page.goto(origin + "/pipeline" + query); await scope("own");
        const own = page.getByRole("checkbox", { name: "Only my assigned leads", exact: true, includeHidden: true });
        assert.equal(await own.isChecked(), true); assert.equal(await own.isDisabled(), true);
      }
    }
    checks.push("Agent and mixed grants cannot widen their forced own filter through any entry URL");
    assert.deepEqual(failures, []); assert.ok(requests.every(request => request.startsWith("GET "))); passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Actual components with original CSS and synthetic intercepted GETs; no current credentials/session/server/database writes. API authorization is verified separately by retained service tests.", checks, checkCount: checks.length, screenshots, requests, failures }, null, 2), { flag: "wx" });
    t.diagnostic("Pipeline entry fixture evidence: " + directory);
  }
});
