import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { privateAccess } from "../scripts/mysql-auth/files.js";
import { acknowledgement, access, backendRoot, demoConfiguration, openDemo, privateDirectory, writePrivateNew } from "./storage.js";
import { captureChildEnvironment } from "./ui-capture.js";

const frontend = "http://127.0.0.1:3001";
const express = "http://127.0.0.1:3002";
const departments = [
  { name: "Electrical", id: "6", grant: "electrical.manage", current: "Process" },
  { name: "Civil", id: "7", grant: "civil.manage", current: "Assigned" },
  { name: "PM", id: "8", grant: "project_manager.manage", current: "Assigned" },
  { name: "Switchgear", id: "9", grant: "switchgear.manage", current: "Assigned" },
  { name: "Maintenance", id: "10", grant: "maintenance.manage", current: "Assigned" },
] as const;
type SavedFile = { id: string; content_sha256: string; file_size: number; media_type: string };
type Snapshot = { rows: number; tables: Record<string, { rows: number; sha256: string }>; ownerSessionHash: string;
  ownerSessionUnexpired: boolean; activeUsers: number; taskFiles: SavedFile[]; foreignFile: SavedFile; logFiles: SavedFile[] };
type Receipt = { status: "PASS" | "FAIL"; scope: string; startedAt: string; finishedAt?: string; directory: string;
  checks: { name: string; status: "PASS" | "FAIL"; detail?: string }[]; screenshots: string[];
  observations: { pageErrors: number; blockedRequests: number; loginAttempts: number; logouts: number; applicationWrites: 0 };
  baseline?: Snapshot; final?: Pick<Snapshot, "rows" | "tables" | "ownerSessionHash" | "activeUsers">;
  blocked: string[] };

export function snapshot(): Snapshot {
  const db = openDemo(true);
  try {
    return db.transaction(() => {
      const tables: Snapshot["tables"] = {};
      let rows = 0;
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as { name: string }[]) {
        assert.match(name, /^[A-Za-z0-9_]+$/);
        const records = db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all();
        rows += records.length;
        tables[name] = { rows: records.length, sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex") };
      }
      const ownerSessions = db.prepare("SELECT token_hash,created_at,expires_at FROM crm_sessions WHERE user_id=15 ORDER BY created_at").all() as
        { token_hash: string; created_at: number; expires_at: number }[];
      const taskFiles = db.prepare("SELECT id,content_sha256,file_size,media_type FROM task_attachment WHERE task_id=1 ORDER BY id").all() as SavedFile[];
      const foreignFile = db.prepare("SELECT id,content_sha256,file_size,media_type FROM task_attachment WHERE task_id=7 ORDER BY id").get() as SavedFile | undefined;
      const logFiles = db.prepare(`SELECT f.id,f.content_sha256,f.file_size,f.media_type FROM crm_department_log_attachments f
        JOIN crm_department_work_logs l ON l.id=f.log_id WHERE l.task_id=1 AND l.department='Electrical' ORDER BY f.id`).all() as SavedFile[];
      assert.ok(foreignFile);
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
      return { rows, tables,
        ownerSessionHash: createHash("sha256").update(JSON.stringify(ownerSessions)).digest("hex"),
        ownerSessionUnexpired: ownerSessions.length === 1 && ownerSessions[0]!.expires_at > Date.now(),
        activeUsers: (db.prepare("SELECT COUNT(*) count FROM users WHERE status='active'").get() as { count: number }).count,
        taskFiles, foreignFile, logFiles };
    })();
  } finally { db.close(); }
}

export function allowedPageRequest(url: string, method: string): boolean {
  try {
    const value = new URL(url);
    if (value.origin !== frontend || value.username || value.password || /%(?:2e|2f|5c|00)|\\/i.test(value.pathname)) return false;
    return method === "GET" || method === "HEAD"
      || method === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(value.pathname);
  } catch { return false; }
}

async function json(page: Page, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  assert.match(path, /^\/api\/[A-Za-z0-9/_?=&%-]+$/);
  return page.evaluate(async target => {
    const response = await fetch(target, { credentials: "same-origin", redirect: "error" });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, path);
}

async function file(context: BrowserContext, origin: string, path: string, saved: SavedFile, preview = false): Promise<void> {
  assert.ok([frontend, express].includes(origin));
  assert.match(path, /^\/api\/(?:v1\/)?(?:attachments|log-attachments)\/[a-f0-9-]+(?:\/preview)?$/);
  const response = await context.request.get(origin + path, { maxRedirects: 0 });
  assert.equal(response.status(), 200, path);
  const bytes = await response.body();
  assert.equal(bytes.length, saved.file_size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), saved.content_sha256);
  assert.match(response.headers()["cache-control"] ?? "", /private|no-store/);
  if (preview) assert.match(response.headers()["content-security-policy"] ?? "", /sandbox/);
  const head = await context.request.head(origin + path, { maxRedirects: 0 });
  assert.equal(head.status(), 200, path + " HEAD");
  assert.equal((await head.body()).length, 0);
}

export async function refusal(context: BrowserContext, origin: string, path: string): Promise<void> {
  assert.ok([frontend, express].includes(origin));
  assert.match(path, /^\/api\/(?:v1\/)?[A-Za-z0-9/_-]+$/);
  for (const method of ["GET", "HEAD"] as const) {
    const response = await context.request.fetch(origin + path, { method, maxRedirects: 0 });
    assert.ok([403, 404].includes(response.status()), `${path} ${method}: ${response.status()}`);
    const bytes = await response.body();
    assert.ok(bytes.length < 2048);
    assert.equal(response.headers()["content-disposition"], undefined);
  }
}

async function login(page: Page, identity: { email: string; password: string }, receipt: Receipt): Promise<void> {
  assert.equal((await page.goto(frontend + "/login", { waitUntil: "domcontentloaded" }))?.status(), 200);
  await page.getByLabel("Email address", { exact: true }).fill(identity.email);
  await page.getByLabel("Password", { exact: true }).fill(identity.password);
  receipt.observations.loginAttempts++;
  await page.getByRole("button", { name: /^(Login|Sign in)$/ }).click();
  await page.waitForURL(url => url.origin === frontend && ["/account", "/dashboard"].includes(url.pathname));
  await page.getByRole("heading", { name: "Your account", exact: true }).waitFor();
}

async function logout(page: Page, receipt: Receipt): Promise<void> {
  await page.goto(frontend + "/account", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "User menu", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(frontend + "/login");
  receipt.observations.logouts++;
  const denied = await json(page, "/api/auth/me");
  assert.equal(denied.status, 401);
}

export async function runApprovedRoleBrowser(): Promise<Receipt> {
  demoConfiguration(process.env);
  const fixture = access().fixture;
  assert.equal(fixture.jobId, "1");
  assert.equal(fixture.switchgearTaskId, "4");
  assert.equal(fixture.identities.switchgear.id, "5");
  for (const department of departments) assert.equal(fixture.identities.workers[department.name].id, department.id);
  const directory = privateDirectory(["evidence", "approved-role-browser-" + randomUUID()], true);
  const result: Receipt = { status: "FAIL", scope: "Approved read-only existing-account browser checks: workers 6-10 and restrictive user 5 only.",
    startedAt: new Date().toISOString(), directory, checks: [], screenshots: [],
    observations: { pageErrors: 0, blockedRequests: 0, loginAttempts: 0, logouts: 0, applicationWrites: 0 },
    blocked: ["Worker status/log/file writes require separate approval.", "Restrictive positive own-file preview requires a separately approved retained upload."] };
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, signedIn = false;
  let stage = "Preflight";
  const check = async (name: string, action: () => Promise<void>) => {
    stage = name;
    try { await action(); result.checks.push({ name, status: "PASS" }); }
    catch (error) {
      const detail = name.includes("source navigation") && error instanceof Error
        ? `${error.name}: ${error.message.slice(0, 1200)}`
        : "Sanitized failure; inspect this named step and preserved evidence.";
      result.checks.push({ name, status: "FAIL", detail }); throw new Error(name, { cause: error });
    }
  };
  const capture = async (name: string) => {
    assert.ok(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      if (width === 390) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      const filename = `${name}-${width}.png`;
      await page.screenshot({ path: join(directory, filename), fullPage: true, animations: "disabled" });
      privateAccess(join(directory, filename), false);
      result.screenshots.push(filename);
      if (width === 390) await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  try {
    result.baseline = snapshot();
    assert.equal(result.baseline.activeUsers, 15);
    assert.equal(result.baseline.ownerSessionUnexpired, true);
    assert.equal(result.baseline.taskFiles.length, 5);
    assert.equal(result.baseline.logFiles.length, 3);
    assert.ok(existsSync(chromium.executablePath()));
    browser = await chromium.launch({ headless: true, env: captureChildEnvironment() as Record<string, string>,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"] });
    for (const department of departments) {
      context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
      context.setDefaultTimeout(20_000);
      context.setDefaultNavigationTimeout(25_000);
      await context.route("**/*", route => {
        if (allowedPageRequest(route.request().url(), route.request().method())) return route.continue();
        result.observations.blockedRequests++; return route.abort("blockedbyclient");
      });
      await context.routeWebSocket("**/*", socket => { result.observations.blockedRequests++; socket.close(); });
      page = await context.newPage();
      page.on("pageerror", () => { result.observations.pageErrors++; });
      await check(department.name + " normal login and exact grants", async () => {
        await login(page!, fixture.identities.workers[department.name], result); signedIn = true;
        const me = await json(page!, "/api/auth/me");
        assert.equal(me.status, 200);
        const user = me.body.user as { localUserId: string; permissions: string[] };
        assert.equal(user.localUserId, department.id);
        assert.ok(user.permissions.includes(department.grant));
        assert.equal(user.permissions.some(value => value === "permissions.manage" || value === "users.write"), false);
      });
      await check(department.name + " source navigation and status-filtered queue", async () => {
        assert.equal((await page!.goto(frontend + `/departments/${department.name}/jobs`, { waitUntil: "domcontentloaded" }))?.status(), 200);
        await page!.getByRole("heading", { name: department.name + " jobs", exact: true }).waitFor();
        const label = department.name === "PM" ? "Project Manager" : department.name;
        const group = page!.locator("li.pc-hasmenu").filter({ has: page!.getByRole("button", { name: label, exact: true }) });
        assert.equal(await group.count(), 1);
        for (const [text, value] of [["Pending", "Assigned"], ["Process", "Process"], ["Completed", "Completed"], ["Hold", "Hold"], ["View All", "all"]]) {
          const link = group.getByRole("link", { name: text === "View All" ? `${department.name} jobs` : text, exact: true });
          assert.equal(await link.count(), 1);
          assert.equal(await link.getAttribute("href"), `/departments/${department.name}/jobs` + (value === "all" ? "" : `?status=${value}`));
          const queue = await json(page!, `/api/departments/${department.name}/jobs?status=${value}&page=1&pageSize=25`);
          assert.equal(queue.status, 200);
          assert.ok(Array.isArray(queue.body.items));
          if (value === department.current) assert.ok((queue.body.items as { id: string }[]).some(item => String(item.id) === "1"));
        }
        const groupButton = group.getByRole("button", { name: label, exact: true });
        if (await groupButton.getAttribute("aria-expanded") !== "true") await groupButton.click();
        await group.getByRole("link", { name: department.current === "Process" ? "Process" : "Pending", exact: true }).click();
        await page!.waitForURL(frontend + `/departments/${department.name}/jobs?status=${department.current}`);
        await page!.getByRole("combobox", { name: "Department status filter" }).waitFor();
        await page!.waitForFunction(expected => document.querySelector<HTMLSelectElement>("select")?.value === expected, department.current);
        assert.equal(await page!.getByRole("combobox", { name: "Department status filter" }).inputValue(), department.current);
        await capture("worker-" + department.name.toLowerCase());
      });
      await check(department.name + " assigned task, logs, export and saved file bytes", async () => {
        const detail = await json(page!, `/api/departments/${department.name}/jobs/1`);
        const logs = await json(page!, `/api/departments/${department.name}/jobs/1/logs?page=1&pageSize=25`);
        assert.equal(detail.status, 200); assert.equal(logs.status, 200);
        assert.ok(Array.isArray(logs.body.items));
        const listing = await json(page!, "/api/leads/1/attachments?page=1&pageSize=25");
        assert.equal(listing.status, 200);
        const saved = result.baseline!.taskFiles[0]!;
        for (const origin of [frontend, express]) {
          const prefix = origin === frontend ? "/api" : "/api/v1";
          await file(context!, origin, `${prefix}/attachments/${saved.id}`, saved);
          await file(context!, origin, `${prefix}/attachments/${saved.id}/preview`, saved, true);
        }
        if (department.name === "Electrical") for (const log of result.baseline!.logFiles) for (const origin of [frontend, express]) {
          const prefix = origin === frontend ? "/api" : "/api/v1";
          await file(context!, origin, `${prefix}/log-attachments/${log.id}`, log);
          await file(context!, origin, `${prefix}/log-attachments/${log.id}/preview`, log, true);
        }
        await page!.goto(frontend + `/departments/${department.name}/jobs`);
        const pending = page!.waitForEvent("download");
        await page!.getByRole("link", { name: "Export assigned jobs (XLSX)", exact: true }).click();
        const download = await pending;
        const bytes = readFileSync(await download.path());
        assert.equal(bytes.subarray(0, 2).toString(), "PK");
      });
      await check(department.name + " foreign task, department and file refusals", async () => {
        const foreign = department.name === "Electrical" ? "Civil" : "Electrical";
        const queue = await json(page!, `/api/departments/${foreign}/jobs?page=1&pageSize=25`);
        const unassigned = await json(page!, `/api/departments/${department.name}/jobs/7`);
        assert.ok([403, 404].includes(queue.status));
        assert.ok([403, 404].includes(unassigned.status));
        for (const origin of [frontend, express]) {
          const prefix = origin === frontend ? "/api" : "/api/v1";
          await refusal(context!, origin, `${prefix}/attachments/${result.baseline!.foreignFile.id}`);
        }
      });
      await check(department.name + " normal logout and session refusal", () => logout(page!, result));
      signedIn = false;
      await context.close(); context = undefined; page = undefined;
    }
    context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: 1440, height: 1000 } });
    await context.route("**/*", route => {
      if (allowedPageRequest(route.request().url(), route.request().method())) return route.continue();
      result.observations.blockedRequests++; return route.abort("blockedbyclient");
    });
    page = await context.newPage();
    page.on("pageerror", () => { result.observations.pageErrors++; });
    await check("Restrictive user 5 normal login and exact grants", async () => {
      await login(page!, fixture.identities.switchgear, result); signedIn = true;
      const me = await json(page!, "/api/auth/me");
      assert.equal(me.status, 200);
      const user = me.body.user as { localUserId: string; permissions: string[] };
      assert.equal(user.localUserId, "5");
      assert.deepEqual([...user.permissions].sort(), ["items.view", "leads.manage.agents"]);
    });
    await check("Restrictive user 5 own task, empty file list and role navigation", async () => {
      assert.equal((await page!.goto(frontend + "/pipeline", { waitUntil: "domcontentloaded" }))?.status(), 200);
      await page!.getByRole("heading", { level: 1 }).first().waitFor();
      assert.equal(await page!.getByRole("button", { name: "Switchgear", exact: true }).count(), 0);
      await capture("restrictive-user-5");
      assert.equal((await page!.goto(frontend + "/leads/4", { waitUntil: "domcontentloaded" }))?.status(), 200);
      const own = await json(page!, "/api/leads/4/attachments?page=1&pageSize=25");
      assert.equal(own.status, 200);
      assert.deepEqual(own.body.items, []);
    });
    await check("Restrictive user 5 foreign task and direct file refusals", async () => {
      for (const task of ["1", "7"]) {
        const listing = await json(page!, `/api/leads/${task}/attachments?page=1&pageSize=25`);
        assert.ok([403, 404].includes(listing.status));
      }
      for (const origin of [frontend, express]) {
        const prefix = origin === frontend ? "/api" : "/api/v1";
        for (const saved of [result.baseline!.taskFiles[0]!, result.baseline!.foreignFile]) {
          await refusal(context!, origin, `${prefix}/attachments/${saved.id}`);
          await refusal(context!, origin, `${prefix}/attachments/${saved.id}/preview`);
        }
      }
    });
    await check("Restrictive user 5 normal logout and session refusal", () => logout(page!, result));
    signedIn = false;
    await context.close(); context = undefined; page = undefined;
    assert.equal(result.observations.blockedRequests, 0);
    assert.equal(result.observations.pageErrors, 0);
    result.status = "PASS";
  } catch {
    if (!result.checks.some(value => value.name === stage && value.status === "FAIL"))
      result.checks.push({ name: stage, status: "FAIL", detail: "Sanitized browser or preservation failure." });
  } finally {
    if (signedIn && page) {
      try { await logout(page, result); } catch {
        result.status = "FAIL";
        result.checks.push({ name: "Owned test-session logout", status: "FAIL", detail: "Normal logout not confirmed; preserve the session for review." });
      }
    }
    try { await context?.close(); await browser?.close(); } catch { result.status = "FAIL"; }
    const after = snapshot();
    result.final = { rows: after.rows, tables: after.tables, ownerSessionHash: after.ownerSessionHash, activeUsers: after.activeUsers };
    const excluded = new Set(["crm_sessions", "crm_login_attempts"]);
    const preserved = Object.keys(result.baseline?.tables ?? {}).every(name =>
      excluded.has(name) || result.baseline!.tables[name]!.sha256 === after.tables[name]?.sha256);
    if (!preserved || after.activeUsers !== result.baseline?.activeUsers || after.ownerSessionHash !== result.baseline.ownerSessionHash) {
      result.status = "FAIL";
      result.checks.push({ name: "Exact account, grant, business, file and owner-session preservation", status: "FAIL",
        detail: "Unexpected database delta; retained for review without resetting data." });
    } else result.checks.push({ name: "Exact account, grant, business, file and owner-session preservation", status: "PASS" });
    result.finishedAt = new Date().toISOString();
    writePrivateNew(join(directory, "receipt.json"), result);
  }
  return result;
}

const currentFile = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === currentFile) {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ status: "REFUSED", detail: "No credentials or command arguments are accepted." })); process.exitCode = 1;
  } else if (process.env.CRM_SQLITE_DEMO !== acknowledgement) {
    const loader = pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href;
    const child = spawn(process.execPath, ["--import", loader, currentFile],
      { cwd: backendRoot, env: captureChildEnvironment(), windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise<number>(resolveExit => { child.once("error", () => resolveExit(1)); child.once("exit", code => resolveExit(code ?? 1)); });
  } else {
    try {
      const result = await runApprovedRoleBrowser();
      console.log(JSON.stringify({ status: result.status, receipt: join(result.directory, "receipt.json"),
        checks: result.checks.length, passed: result.checks.filter(value => value.status === "PASS").length,
        failed: result.checks.filter(value => value.status === "FAIL").length, screenshots: result.screenshots.length,
        observations: result.observations, blocked: result.blocked.length }));
      process.exitCode = result.status === "PASS" ? 0 : 1;
    } catch {
      console.error(JSON.stringify({ status: "REFUSED", detail: "Guarded role browser failed before acceptance; no credentials were logged." }));
      process.exitCode = 1;
    }
  }
}
