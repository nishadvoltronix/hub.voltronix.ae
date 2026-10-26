import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

test("PHP Home, logo and successful login return to the guarded application root", { timeout: 60_000 }, async () => {
  const origin = "http://127.0.0.1:39986";
  const bundle = await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {CrmChrome} from './src/components/crm/chrome';import {LoginForm} from './src/components/login-form';const permissions=new URLSearchParams(location.search).get('grant');createRoot(document.getElementById('root')).render(location.pathname==='/login'?<LoginForm/>:<CrmChrome user={{localUserId:'999',username:'Synthetic user',email:'fixture@example.invalid',permissions:permissions?[permissions]:[]}}><h1>Fixture</h1></CrmChrome>);`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "next-stubs", setup(api) {
    api.onResolve({ filter: /^next\/(image|link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path.endsWith("navigation")
      ? "export function useRouter(){return{refresh(){},replace(path){document.documentElement.dataset.destination=path}}};export function usePathname(){return new URLSearchParams(location.search).get('path')||'/items'};export function useSearchParams(){return new URLSearchParams()}"
      : args.path.endsWith("image") ? "import React from'react';export default function Image({unoptimized,priority,...props}){return React.createElement('img',props)}"
        : "import React from'react';export default function Link(props){return React.createElement('a',props)}", loader: "js", resolveDir: process.cwd() }));
  } }] });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ serviceWorkers: "block" });
  const failures: string[] = [];
  const csrfToken = "a".repeat(43);
  let authStatus = 503, authRequests = 0;
  page.on("pageerror", () => failures.push("pageerror"));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { failures.push("unexpected origin"); return route.abort(); }
    if (url.pathname === "/api/auth/login" && request.method() === "POST") {
      authRequests++; assert.equal(request.headers()["x-csrf-token"], csrfToken);
      assert.deepEqual(request.postDataJSON(), { email: "fixture@example.invalid", password: "synthetic-password" });
      return route.fulfill({ status: authStatus, json: {} });
    }
    if (request.method() !== "GET") { failures.push("unexpected request"); return route.abort(); }
    if (["/", "/login"].includes(url.pathname)) return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/fixture.js"></script>' });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken } });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text });
    if (url.pathname === "/legacy/assets/images/logo-voltronix.png") return route.fulfill({ contentType: "image/png", body: await readFile("public" + url.pathname) });
    failures.push("unexpected route"); return route.abort();
  });
  try {
    for (const grant of ["dashboard.view", "electric_dashboard.view", ""]) {
      await page.goto(origin + "/?grant=" + grant);
      const home = page.getByRole("link", { name: "Home", exact: true }); await home.waitFor();
      assert.equal(await home.getAttribute("href"), "/");
      assert.equal(await page.locator("a.b-brand").getAttribute("href"), "/");
      assert.equal(await page.locator('nav a[href="/dashboard"]').count(), grant ? 1 : 0);
      assert.equal(await page.getByRole("link", { name: "Your account", exact: true }).getAttribute("href"), "/account");
    }
    await page.goto(origin + "/?path=/items/new");
    await page.getByRole("link", { name: "Home", exact: true }).waitFor();
    assert.equal(await page.locator(".page-header-title").textContent(), "Create Item");
    await page.goto(origin + "/login");
    await page.getByLabel("Email address", { exact: true }).fill("fixture@example.invalid");
    await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /temporarily unavailable/);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.destination), undefined);
    authStatus = 403;
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await page.getByText("Sign-in security check failed. Reload this page and use the configured CRM address.", { exact: true }).waitFor();
    assert.doesNotMatch(await page.getByRole("alert").innerText(), /email and password/);
    authStatus = 200;
    await page.getByRole("button", { name: "Login", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.destination !== undefined);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.destination), "/");
    assert.equal(authRequests, 3);
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
});
