import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { allowedPageRequest, refusal, snapshot } from "./approved-role-browser.js";
import { acknowledgement, access, backendRoot, demoConfiguration, privateDirectory, writePrivateNew } from "./storage.js";
import { captureChildEnvironment } from "./ui-capture.js";

const frontend = "http://127.0.0.1:3001";
const express = "http://127.0.0.1:3002";
const departments = ["Electrical", "Civil", "PM", "Switchgear", "Maintenance"] as const;
const identities = [
  { id: "7", department: "Civil" }, { id: "8", department: "PM" },
  { id: "9", department: "Switchgear" }, { id: "10", department: "Maintenance" },
] as const;

async function run(): Promise<{ status: "PASS" | "FAIL"; receipt: string; passed: number; failed: number }> {
  demoConfiguration(process.env);
  const fixture = access().fixture;
  assert.equal(fixture.identities.switchgear.id, "5");
  for (const identity of identities) assert.equal(fixture.identities.workers[identity.department].id, identity.id);
  const directory = privateDirectory(["evidence", "approved-role-foreign-log-" + randomUUID()], true);
  const before = snapshot();
  assert.equal(before.ownerSessionUnexpired, true);
  assert.equal(before.logFiles.length, 3);
  const checks: { name: string; status: "PASS" | "FAIL"; detail?: string }[] = [];
  const observations = { loginAttempts: 0, logouts: 0, pageErrors: 0, blockedRequests: 0, applicationWrites: 0 };
  const browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string>,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"] });
  let signedIn = false;
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof context>["newPage"]>> | undefined;
  let stage = "Preflight";
  try {
    for (const identity of [...identities, { id: "5", department: "restrictive" } as const]) {
      stage = "User " + identity.id + " foreign Electrical log and role menu refusals";
      context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
      context.setDefaultTimeout(20_000);
      await context.route("**/*", route => {
        if (allowedPageRequest(route.request().url(), route.request().method())) return route.continue();
        observations.blockedRequests++; return route.abort("blockedbyclient");
      });
      await context.routeWebSocket("**/*", socket => { observations.blockedRequests++; socket.close(); });
      page = await context.newPage();
      page.on("pageerror", () => { observations.pageErrors++; });
      const savedIdentity = identity.department === "restrictive"
        ? fixture.identities.switchgear : fixture.identities.workers[identity.department];
      assert.equal((await page.goto(frontend + "/login"))?.status(), 200);
      await page.getByLabel("Email address", { exact: true }).fill(savedIdentity.email);
      await page.getByLabel("Password", { exact: true }).fill(savedIdentity.password);
      observations.loginAttempts++;
      await page.getByRole("button", { name: /^(Login|Sign in)$/ }).click();
      await page.waitForURL(url => url.origin === frontend && ["/account", "/dashboard"].includes(url.pathname));
      signedIn = true;
      const me = await page.evaluate(async () => {
        const response = await fetch("/api/auth/me", { credentials: "same-origin" });
        return { status: response.status, body: await response.json() as { user: { localUserId: string } } };
      });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.localUserId, identity.id);
      for (const department of departments) {
        if (department === identity.department) continue;
        const label = department === "PM" ? "Project Manager" : department;
        assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 0);
      }
      for (const saved of before.logFiles) for (const origin of [frontend, express]) {
        const prefix = origin === frontend ? "/api" : "/api/v1";
        await refusal(context, origin, `${prefix}/log-attachments/${saved.id}`);
        await refusal(context, origin, `${prefix}/log-attachments/${saved.id}/preview`);
      }
      await page.getByRole("button", { name: "User menu", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.waitForURL(frontend + "/login");
      observations.logouts++;
      signedIn = false;
      checks.push({ name: stage, status: "PASS" });
      await context.close(); context = undefined; page = undefined;
    }
    assert.equal(observations.pageErrors, 0);
    assert.equal(observations.blockedRequests, 0);
  } catch (error) {
    checks.push({ name: stage, status: "FAIL", detail: error instanceof Error ? error.name : "Unknown error" });
  } finally {
    if (signedIn && page) {
      try {
        await page.getByRole("button", { name: "User menu", exact: true }).click();
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await page.waitForURL(frontend + "/login"); observations.logouts++;
      } catch { checks.push({ name: "Owned test-session logout", status: "FAIL" }); }
    }
    await context?.close(); await browser.close();
  }
  const after = snapshot();
  const excluded = new Set(["crm_sessions", "crm_login_attempts"]);
  const preserved = Object.keys(before.tables).every(name =>
    excluded.has(name) || before.tables[name]!.sha256 === after.tables[name]?.sha256);
  const preservation = preserved && before.activeUsers === after.activeUsers && before.ownerSessionHash === after.ownerSessionHash;
  checks.push({ name: "Exact accounts, grants, business, files and owner-session preservation", status: preservation ? "PASS" : "FAIL" });
  const status = checks.every(value => value.status === "PASS") ? "PASS" : "FAIL";
  const receipt = join(directory, "receipt.json");
  writePrivateNew(receipt, { status, scope: "Read-only foreign saved Electrical log-file refusals for users 7-10 and 5; no foreign log exists for user 6.",
    checks, observations, baselineRows: before.rows, finalRows: after.rows, baselineActive: before.activeUsers,
    finalActive: after.activeUsers, changedTables: Object.keys(before.tables).filter(name => before.tables[name]!.sha256 !== after.tables[name]?.sha256),
    blocked: ["No saved foreign-department log file is available for Electrical user 6 without an unapproved write."],
    finishedAt: new Date().toISOString() });
  return { status, receipt, passed: checks.filter(value => value.status === "PASS").length,
    failed: checks.filter(value => value.status === "FAIL").length };
}

const currentFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === currentFile) {
  if (process.argv.length !== 2) { console.error(JSON.stringify({ status: "REFUSED", detail: "No arguments accepted." })); process.exitCode = 1; }
  else if (process.env.CRM_SQLITE_DEMO !== acknowledgement) {
    const loader = pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href;
    const child = spawn(process.execPath, ["--import", loader, currentFile],
      { cwd: backendRoot, env: captureChildEnvironment(), windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise<number>(resolveExit => { child.once("error", () => resolveExit(1)); child.once("exit", code => resolveExit(code ?? 1)); });
  } else {
    try { const result = await run(); console.log(JSON.stringify(result)); process.exitCode = result.status === "PASS" ? 0 : 1; }
    catch { console.error(JSON.stringify({ status: "REFUSED", detail: "Guarded role follow-up failed before acceptance." })); process.exitCode = 1; }
  }
}
