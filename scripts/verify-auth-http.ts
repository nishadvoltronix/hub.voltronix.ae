import { assertSqliteReferenceBuild } from "./sqlite-reference-http-guard";
assertSqliteReferenceBuild();
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hashSync } from "bcryptjs";
import { chromium } from "playwright";
import { parseDatabaseConfig } from "../tests/sqlite-reference/config/database";
import { localDirectory, openDatabase } from "../tests/sqlite-reference/db/connection";
import { migrateDatabase } from "../tests/sqlite-reference/db/migrations";

let currentCheck = "isolated fixture setup";
async function main() {
  const root = realpathSync(process.cwd());
  const testRoot = localDirectory(root, [".local-data", "test"], true);
  const directory = mkdtempSync(join(testRoot, "http-"));
  const databasePath = relative(root, join(directory, "crm.sqlite"));
  const database = openDatabase(parseDatabaseConfig({
    DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath,
  }, root), { create: true });
  migrateDatabase(database);

  // Explicit synthetic integration fixtures, confined to a unique test database.
  const password = randomBytes(24).toString("base64url");
  const storedHash = hashSync(password, 4);
  database.prepare(`INSERT INTO users(id,user_id,username,email,password,status) VALUES
    (1,'9007199254740993123','HTTP fixture','http@example.test',?,'active'),
    (2,'other-external','Other fixture','other@example.test',?,'active'),
    (3,NULL,'Inactive fixture','inactive@example.test',?,'inactive')`).run(storedHash, storedHash, storedHash);
  database.prepare(`INSERT INTO permissions(id,"key",label) VALUES
    (1,'leads.manage.agents','Agent scope'),(2,'leads.view','Read leads')`).run();
  database.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES (1,1),(1,2)").run();
  database.prepare(`INSERT INTO tasks(id,assigned_to,deal_name,status) VALUES
    (1,'9007199254740993123','Owned test task','Qualification'),
    (2,'other-external','Other test task','Qualification')`).run();

  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, windowsHide: true, stdio: "ignore",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath, APP_ORIGIN: base },
  });
  const exited = once(child, "exit");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const cookies = new Map<string, string>();
  let csrfToken = "";
  async function request(path: string, options: RequestInit = {}, useCookies = true) {
    const headers = new Headers(options.headers);
    if (useCookies) headers.set("Cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    const response = await fetch(base + path, { ...options, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (useCookies) for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const equals = pair.indexOf("=");
      cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  }
  async function challenge() {
    const response = await request("/api/auth/csrf");
    assert.equal(response.status, 200);
    csrfToken = (await response.json() as { csrfToken: string }).csrfToken;
    assert.match(csrfToken, /^[A-Za-z0-9_-]{43}$/);
  }
  function login(email: string, submittedPassword = password, extra: Record<string, unknown> = {}) {
    return request("/api/auth/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ email, password: submittedPassword, ...extra }) });
  }
  try {
    currentCheck = "production server startup";
    const deadline = Date.now() + 20_000;
    let online = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Owned test server exited before startup.");
      try { online = (await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ }
      if (online) break;
      await delay(150);
    }
    assert(online, "Production server did not start.");
    currentCheck = "anonymous access and private paths";
    const live = await request("/api/health/live");
    assert.equal(live.headers.get("cache-control"), "no-store");
    assert.equal(live.headers.get("x-frame-options"), "DENY");
    assert.equal(live.headers.get("x-content-type-options"), "nosniff");
    assert.equal(live.headers.get("x-powered-by"), null);
    assert.equal((await request("/api/auth/me")).status, 401);
    assert.equal((await request("/api/tasks/1")).status, 401);
    const account = await request("/account");
    assert.equal(account.status, 307);
    assert.equal(account.headers.get("location"), "/login");
    assert.match(await (await request("/login")).text(), /Sign in to your CRM/);
    for (const path of ["/.env.local", "/.local-data/development/crm.sqlite", `/${databasePath.replaceAll("\\", "/")}`, "/.private/schema-inspection.json", "/application/config/database.php"]) {
      assert.equal((await request(path)).status, 404, `Private path was exposed: ${path}`);
    }
    assert.equal((await request("/api/auth/logout")).status, 405);
    assert.equal((await request("/api/auth/csrf", { headers: { Origin: "https://attacker.test" } })).status, 403);
    currentCheck = "login origin, CSRF and input validation";
    await challenge();
    assert.equal((await request("/api/auth/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await request("/api/auth/login", { method: "POST", headers: { Origin: "https://attacker.test", "X-CSRF-Token": csrfToken }, body: "{}" })).status, 403);
    assert.equal((await login("http@example.test", password, { role: "admin", userId: "2" })).status, 400);
    assert.equal((await login("http@example.test", "wrong-fixture-password")).status, 401);
    assert.equal((await login("inactive@example.test")).status, 401);
    currentCheck = "valid login and secure session";
    const accepted = await login("http@example.test");
    assert.equal(accepted.status, 200);
    for (const cookie of accepted.headers.getSetCookie()) {
      assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=lax/i); assert.match(cookie, /Path=\//i);
    }
    const sessionToken = cookies.get("crm_session")!;
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM crm_sessions WHERE token_hash = ?").get(sessionToken) as { count: number }).count, 0);
    const identity = await (await request("/api/auth/me")).json() as { user: { externalUserId: string; permissions: string[] } };
    assert.equal(identity.user.externalUserId, "9007199254740993123");
    assert.equal(JSON.stringify(identity).includes(storedHash), false);
    currentCheck = "task ownership and immediate grant revocation";
    assert.equal((await request("/api/tasks/1")).status, 200);
    assert.equal((await request("/api/tasks/2")).status, 404);
    database.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id = 1").run();
    assert.equal((await request("/api/tasks/1")).status, 404);
    assert.deepEqual((await (await request("/api/auth/me")).json() as { user: { permissions: string[] } }).user.permissions, []);
    currentCheck = "logout and session revocation";
    assert.equal((await request("/api/auth/logout", { method: "POST", headers: { Origin: base, "X-CSRF-Token": csrfToken } })).status, 403, "Pre-login CSRF must be invalidated");
    await challenge();
    assert.equal((await request("/api/auth/logout", { method: "POST", headers: { Origin: base, "X-CSRF-Token": csrfToken } })).status, 200);
    assert.equal((await request("/api/auth/me", { headers: { Cookie: `crm_session=${sessionToken}` } }, false)).status, 401);
    assert.equal((await request("/account")).status, 307);
    console.log("PASS: HTTP login/logout, origin/CSRF, cookies, identity, task ownership, live grant revocation, and private paths.");

    // Real Chromium form interaction against the same isolated SQLite test database.
    currentCheck = "Chromium visible authentication workflow";
    browser = await chromium.launch({ headless: true, timeout: 20_000 });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(10_000);
    await page.goto(base + "/account");
    await page.waitForURL(base + "/login");
    await page.getByLabel("Email address").fill("http@example.test");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(url => url.origin === base && ["/account", "/dashboard"].includes(url.pathname));
    assert.equal(await page.getByRole("heading", { name: "Your account" }).count(), 1);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(base + "/login");
    assert.equal(await page.getByRole("heading", { name: "Sign in to your CRM" }).count(), 1);
    console.log("PASS: Chromium protected-page redirect, visible sign-in form and logout flow.");
  } finally {
    await browser?.close();
    if (child.exitCode === null) child.kill();
    await exited;
    database.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), resolve(testRoot));
    assert.equal(target, resolve(directory));
    rmSync(target, { recursive: true, force: true });
  }
}

main().catch(() => { console.error(`Authentication HTTP/browser verification failed during ${currentCheck}. No real CRM data was used.`); process.exitCode = 1; });
