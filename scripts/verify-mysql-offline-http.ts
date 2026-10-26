import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

async function main() {
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const address = listener.address(); assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  // Child is loopback-only and the real driver refuses any database socket in this mode.
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    windowsHide: true, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1",
      CRM_MYSQL_NETWORK_DISABLED: "1", APP_ORIGIN: base },
  });
  const exited = once(child, "exit");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const get = (path: string, options: RequestInit = {}) => fetch(base + path, {
    ...options, redirect: "manual", signal: AbortSignal.timeout(5000),
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error();
      try { if ((await get("/api/health/live")).status === 200) { ready = true; break; } } catch { /* only this loopback child */ }
      await delay(250);
    }
    assert(ready);
    const health = await get("/api/health/live"); assert.match(health.headers.get("cache-control") ?? "", /no-store/);
    const csrf = await get("/api/auth/csrf"); assert.equal(csrf.status, 200);
    assert.match(csrf.headers.get("cache-control") ?? "", /no-store/);
    const cookie = csrf.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const { csrfToken } = await csrf.json() as { csrfToken: string };
    assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
    const body = JSON.stringify({ email: "offline-fixture@example.test", password: "unpersisted-offline-test" });
    const noCsrf = await get("/api/auth/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body });
    assert.equal(noCsrf.status, 403);
    const crossSite = await get("/api/auth/login", { method: "POST", headers: { Origin: "https://unapproved.invalid",
      "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrfToken }, body });
    assert.equal(crossSite.status, 403);
    const unavailable = await get("/api/auth/login", { method: "POST", headers: { Origin: base,
      "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrfToken }, body });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "The service is temporarily unavailable." });
    assert.match(unavailable.headers.get("cache-control") ?? "", /no-store/);
    const protectedPage = await get("/account"); assert.equal(protectedPage.status, 307);
    assert.match(protectedPage.headers.get("location") ?? "", /\/login$/);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); await page.goto(base + "/login");
    await page.getByLabel("Email address").fill("offline-fixture@example.test");
    await page.getByLabel("Password", { exact: true }).fill("unpersisted-offline-test");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Sign-in is temporarily unavailable." }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/login");
    const reports = join(process.cwd(), ".local-data", "reports"); mkdirSync(reports, { recursive: true });
    const directory = mkdtempSync(join(reports, "mysql-offline-http-"));
    // No HAR, cookie, environment or request body recording.
    writeFileSync(join(directory, "result.json"), JSON.stringify({ at: new Date().toISOString(),
      status: "PASS", scope: "offline-current-MySQL-build", mysqlConnected: false,
      checks: ["loopback liveness", "anonymous CSRF challenge", "missing/cross-origin CSRF denied", "redacted no-store database-unavailable 503",
        "unauthenticated page redirect", "Chromium login remains signed out"],
      limitation: "No MySQL persistence, authenticated workflow, sandbox or target-host verification." }, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ status: "PASS", scope: "offline HTTP/Chromium only", mysqlConnected: false,
      evidence: relative(process.cwd(), directory) }));
  } finally {
    await browser?.close();
    if (child.exitCode === null) child.kill();
    await exited;
  }
}
main().catch(() => { console.error("Offline MySQL HTTP/Chromium verification failed; no credentials or response bodies were logged."); process.exitCode = 1; });
