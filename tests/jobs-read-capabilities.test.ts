import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("OFFLINE job cohort controls follow read capability independently of writes and retain demo fallback", { timeout: 30_000 }, async () => {
  const origin = "http://127.0.0.1:39991";
  const bundle = await build({ stdin: {
    contents: "import {createRoot} from 'react-dom/client';import {Jobs} from './src/components/crm/jobs';createRoot(document.getElementById('root')).render(<Jobs initialCohort='pending'/>);",
    loader: "tsx", resolveDir: process.cwd(),
  }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
      ? "export function useRouter(){return{refresh(){},push(path){globalThis.pushedPath=path}}}"
      : "import React from'react';export default function Link(props){return React.createElement('a',props)}",
    loader: "js", resolveDir: process.cwd() }));
  } }] });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const mode of ["unavailable", "mysql-reads", "demo"] as const) {
      const page = await browser.newPage({ serviceWorkers: "block" });
      const failures: string[] = [];
      page.on("pageerror", error => failures.push(error.message));
      await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== "GET") { failures.push("Unexpected request"); return route.abort(); }
        if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!DOCTYPE html><html><body><div id='root'></div><script src='/component.js'></script></body></html>" });
        if (url.pathname === "/component.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
        if (url.pathname === "/api/capabilities") return route.fulfill({ json: {
          persistence: mode === "demo" ? "local-demo" : "unavailable", productCreate: false, leadNotes: false,
          integrationAvailable: false, ...(mode === "mysql-reads" ? { jobCohorts: true } : {}),
        } });
        if (url.pathname === "/api/jobs") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 25 } });
        failures.push("Unexpected path"); return route.abort();
      });
      await page.goto(origin); await page.getByText("No jobs match the current filters.", { exact: true }).waitFor();
      const groups = page.getByRole("combobox", { name: "Job group", exact: true });
      if (mode === "unavailable") {
        assert.equal(await groups.isDisabled(), true);
        assert.equal(await page.getByRole("button", { name: "Export jobs (XLSX)" }).isDisabled(), true);
      } else {
        await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>("select")?.disabled);
        assert.equal(await groups.isEnabled(), true);
        const download = page.getByRole("link", { name: "Export jobs (XLSX)" });
        assert.match(await download.getAttribute("href") ?? "", /cohort=pending/);
        await groups.selectOption("completed");
        assert.equal(await page.evaluate(() => (globalThis as typeof globalThis & { pushedPath?: string }).pushedPath), "/jobs?cohort=completed&jobStatus=all");
      }
      assert.deepEqual(failures, []); await page.close();
    }
  } finally { await browser.close(); }
});
