import { preservedSource } from "./helpers/preserved-source";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("pipeline navigation labels follow original manager and agent entry names without changing access", { timeout: 60_000 }, async t => {
  const source = await readFile(preservedSource("application/views/layout/layout.php"), "utf8");
  const manager = source.indexOf("<?php if ($this->rbac->can('leads.manage')): ?>");
  const agent = source.indexOf("<?php if ($this->rbac->can('leads.manage.agents')): ?>");
  assert.ok(manager > -1 && source.slice(manager, agent).includes("Agents Pipelines"));
  assert.match(source.slice(agent, source.indexOf("<?php if ($this->rbac->can('deals.manage')", agent)), />\s*Pipelines\s*</);
  const origin = "http://127.0.0.1:39987", directory = resolve(".local-data/reports/navigation-source-" + randomUUID());
  await mkdir(directory, { recursive: true });
  const bundle = await build({ stdin: { contents: `import{createRoot}from'react-dom/client';import{CrmNavigation}from'./src/components/crm/navigation';const permissions=new URLSearchParams(location.search).getAll('grant');createRoot(document.getElementById('root')).render(<CrmNavigation user={{localUserId:'999',username:'Synthetic manager',email:'fixture@example.invalid',permissions}}/>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-fixture", setup(api) {
    api.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation") ? "export function usePathname(){return'/pipeline'};export function useSearchParams(){return new URLSearchParams()}" : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ serviceWorkers: "block" });
  const requests: string[] = [], failures: string[] = [], checks: string[] = []; let passed = false;
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); requests.push(request.method() + " " + url.pathname);
    if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected request"); return route.abort(); }
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/fixture.js"></script>' });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    failures.push("Unexpected route"); return route.abort();
  });
  try {
    for (const scenario of [
      { name: "Manager", grants: ["leads.view", "leads.manage"], label: "Agents Pipelines" },
      { name: "Agent", grants: ["leads.manage.agents"], label: "Pipelines" },
      { name: "Mixed grants retain forced own scope", grants: ["leads.view", "leads.manage", "leads.manage.agents"], label: "Pipelines" },
      { name: "Viewer retains existing route", grants: ["leads.view"], label: "Pipelines" },
      { name: "Write-only does not gain read route", grants: ["leads.manage"], label: null },
      { name: "Restrictive account", grants: [], label: null },
    ]) {
      const query = new URLSearchParams(); for (const grant of scenario.grants) query.append("grant", grant);
      await page.goto(origin + "/?" + query); await page.getByRole("navigation", { name: "CRM navigation" }).waitFor();
      const link = page.getByRole("link", { name: "Lead pipeline", exact: true });
      if (scenario.label) { assert.equal(await link.textContent(), scenario.label); assert.equal(await link.getAttribute("href"), "/pipeline"); }
      else assert.equal(await link.count(), 0);
      checks.push(scenario.name);
    }
    assert.deepEqual(failures, []); passed = true;
  } finally {
    await browser.close();
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ status: passed ? "PASS" : "FAIL", scope: "Actual navigation component; synthetic role grants and intercepted GET-only requests; zero auth/server/database writes.", checks, requests, failures }, null, 2), { flag: "wx" });
    t.diagnostic("Navigation source fixture evidence: " + directory);
  }
});
