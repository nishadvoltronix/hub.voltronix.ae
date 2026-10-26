import { assertSqliteReferenceBuild } from "./sqlite-reference-http-guard";
assertSqliteReferenceBuild();
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hashSync } from "bcryptjs";
import { chromium } from "playwright";
import { parseDatabaseConfig } from "../tests/sqlite-reference/config/database";
import { localDirectory, openDatabase, type SqliteDatabase } from "../tests/sqlite-reference/db/connection";
import { migrateDatabase } from "../tests/sqlite-reference/db/migrations";

interface UserRecord {
  id: string; name: string; email: string; status: "active" | "inactive";
  externalUserId: string | null; departmentRole: string | null;
  departmentAssignedBy: string | null; departmentAssignedAt: string | null; version: number;
}
interface GroupRecord { id: string; key: string; label: string; sortOrder: number; version: number }
interface PermissionRecord { id: string; key: string; label: string; groupId: string | null; version: number }
interface GrantRecord { user: { id: string; name: string; email: string }; permissionIds: string[]; version: number }
interface Listing<T> { items: T[]; total: number; page: number; pageSize: number }

let currentCheck = "isolated settings fixture setup";

async function main() {
  const root = realpathSync(process.cwd());
  const testRoot = localDirectory(root, [".local-data", "test"], true);
  const directory = mkdtempSync(join(testRoot, "settings-"));
  const databasePath = relative(root, join(directory, "crm.sqlite"));
  let database: SqliteDatabase | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const password = randomBytes(24).toString("base64url");
  const changedPassword = randomBytes(24).toString("base64url");
  const storedHash = hashSync(password, 4);

  try {
    database = openDatabase(parseDatabaseConfig({
      DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath,
    }, root), { create: true });
    migrateDatabase(database);
    // These are explicitly synthetic fixtures in this suite's own disposable database.
    database.prepare(`INSERT INTO users(id,user_id,username,email,password,status) VALUES
      (1,'settings-http-owner','Settings fixture owner','settings-owner@example.test',?,'active'),
      (2,NULL,'Users-only fixture','settings-users-only@example.test',?,'active'),
      (3,NULL,'Permissions-only fixture','settings-permissions-only@example.test',?,'active'),
      (4,NULL,'Ungrantable fixture','settings-ungranted@example.test',?,'active'),
      (5,NULL,'Unrelated fixture','settings-unrelated@example.test',?,'active')`).run(
      storedHash, storedHash, storedHash, storedHash, storedHash,
    );
    database.prepare(`INSERT INTO permissions(id,"key",label) VALUES
      (1,'users.write','Fixture account maintenance'),
      (2,'permissions.manage','Fixture permission maintenance'),
      (3,'leads.view','Fixture lead visibility')`).run();
    database.prepare(`INSERT INTO admin_user_permissions(admin_user_id,permission_id)
      VALUES (1,1),(1,2),(2,1),(3,2)`).run();

    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: root, windowsHide: true, stdio: "ignore",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath, APP_ORIGIN: base },
    });
    exited = once(child, "exit");

    function client() {
      const cookies = new Map<string, string>();
      let csrfToken = "";
      async function request(path: string, options: RequestInit = {}) {
        const headers = new Headers(options.headers);
        headers.set("Cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
        const response = await fetch(base + path, { ...options, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        for (const cookie of response.headers.getSetCookie()) {
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
      }
      async function login(email: string, submittedPassword = password, expected = 200) {
        await challenge();
        const response = await mutate("/api/auth/login", "POST", { email, password: submittedPassword });
        assert.equal(response.status, expected, "Fixture login status mismatch.");
        if (response.ok) csrfToken = (await response.json() as { csrfToken: string }).csrfToken;
      }
      function mutate(path: string, method: string, body: unknown, overrides: Record<string, string> = {}) {
        return request(path, { method, headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrfToken, ...overrides }, body: JSON.stringify(body) });
      }
      function replaceCsrfForTest(value: string) { csrfToken = value; cookies.set("crm_csrf", value); }
      return { request, challenge, login, mutate, csrf: () => csrfToken, replaceCsrfForTest };
    }

    async function json<T>(response: Response, expected = 200): Promise<T> {
      assert.equal(response.status, expected, "Unexpected settings response status.");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text();
      for (const secret of [password, changedPassword, storedHash]) {
        assert(!text.includes(secret), "A response disclosed a fixture password or hash.");
      }
      return JSON.parse(text) as T;
    }

    currentCheck = "settings production server startup";
    const deadline = Date.now() + 20_000;
    let online = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Owned settings test server exited before startup.");
      try { online = (await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ }
      if (online) break;
      await delay(150);
    }
    assert(online, "Production settings server did not start.");

    const anonymous = client();
    const owner = client();
    const usersOnly = client();
    const permissionsOnly = client();
    const ungranted = client();
    const createdSession = client();
    const prefix = "/api/settings";
    currentCheck = "anonymous and least-privilege settings access";
    for (const path of ["users", "users/1", "users/1/permissions", "grant-users", "permission-groups", "permission-groups/1", "permissions", "permissions/1"]) {
      assert.equal((await anonymous.request(`${prefix}/${path}`)).status, 401);
    }
    for (const path of ["/settings/users", "/settings/permission-groups", "/settings/permissions"]) {
      const response = await anonymous.request(path);
      assert.equal(response.status, 307);
      assert.equal(response.headers.get("location"), "/login");
    }
    await owner.login("settings-owner@example.test");
    await usersOnly.login("settings-users-only@example.test");
    await permissionsOnly.login("settings-permissions-only@example.test");
    await ungranted.login("settings-ungranted@example.test");
    assert.equal((await usersOnly.request(`${prefix}/users`)).status, 403);
    assert.equal((await usersOnly.request(`${prefix}/permissions`)).status, 403);
    assert.equal((await permissionsOnly.request(`${prefix}/users`)).status, 403);
    assert.equal((await permissionsOnly.request(`${prefix}/permissions`)).status, 200);
    assert.equal((await permissionsOnly.request(`${prefix}/grant-users`)).status, 200);
    assert.deepEqual(await json<{ error: string }>(await ungranted.request(`${prefix}/grant-users`), 403), { error: "Access denied." });
    assert.equal((await usersOnly.mutate(`${prefix}/users`, "POST", { forged: "invalid" })).status, 403);
    assert.equal((await permissionsOnly.mutate(`${prefix}/users/4/department`, "PUT", { forged: "invalid" })).status, 403);
    assert.equal((await ungranted.mutate(`${prefix}/permissions`, "POST", { forged: "invalid" })).status, 403);

    currentCheck = "settings request security and strict validation";
    const newUser = { name: "HTTP created fixture", email: "http-created@example.test", password, status: "active" };
    assert.equal((await owner.mutate(`${prefix}/users`, "POST", newUser, { "X-CSRF-Token": randomBytes(32).toString("base64url") })).status, 403);
    assert.equal((await owner.mutate(`${prefix}/users`, "POST", newUser, { Origin: "https://attacker.test" })).status, 403);
    owner.replaceCsrfForTest(usersOnly.csrf());
    assert.equal((await owner.mutate(`${prefix}/users`, "POST", newUser)).status, 403, "A CSRF cookie/header pair from another session was accepted.");
    await owner.challenge();
    assert.equal((await owner.mutate(`${prefix}/users`, "POST", newUser, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await owner.mutate(`${prefix}/users`, "POST", { ...newUser, name: "x".repeat(9_000) })).status, 413);
    assert.equal((await owner.mutate(`${prefix}/users`, "POST", { ...newUser, actorId: "5" })).status, 400);
    assert.equal((await owner.mutate(`${prefix}/users`, "POST", { ...newUser, status: "administrator" })).status, 400);
    assert.deepEqual(await json<{ error: string }>(await owner.mutate(`${prefix}/users`, "POST", { ...newUser, email: "invalid-email" }), 400), { error: "Invalid settings input." });
    assert.equal((await owner.mutate(`${prefix}/users`, "POST", { ...newUser, password: "short" })).status, 400);
    assert.equal((await owner.request(`${prefix}/users?page=0`)).status, 400);
    assert.equal((await owner.request(`${prefix}/users?pageSize=101`)).status, 400);
    const firstPage = await json<Listing<UserRecord>>(await owner.request(`${prefix}/users?page=1&pageSize=2`));
    const secondPage = await json<Listing<UserRecord>>(await owner.request(`${prefix}/users?page=2&pageSize=2`));
    assert.equal(firstPage.items.length, 2);
    assert.equal(secondPage.items.length, 2);
    assert.equal(firstPage.total, 5);
    assert.equal(firstPage.page, 1);
    assert.equal(firstPage.pageSize, 2);
    assert(!firstPage.items.some((item) => secondPage.items.some((other) => item.id === other.id)));
    assert.equal((await json<Listing<UserRecord>>(await owner.request(`${prefix}/users?query=${encodeURIComponent("' OR 1=1 --")}`))).total, 0);
    assert.equal((await json<Listing<UserRecord>>(await owner.request(`${prefix}/users?query=%25`))).total, 0);

    currentCheck = "user create, search, update, conflicts and safe projection";
    let created = await json<UserRecord>(await owner.mutate(`${prefix}/users`, "POST", newUser), 201);
    assert.equal(created.name, newUser.name);
    assert.equal(created.externalUserId, null);
    assert.deepEqual(await json<{ error: string }>(await owner.mutate(`${prefix}/users`, "POST", newUser), 409), { error: "The record changed or conflicts with an existing record. Reload and try again." });
    const searched = await json<Listing<UserRecord>>(await owner.request(`${prefix}/users?query=http-created`));
    assert.deepEqual(searched.items.map((item) => item.id), [created.id]);
    const originalVersion = created.version;
    const edit = { version: created.version, name: "HTTP edited fixture", email: "http-edited@example.test", status: "active" };
    created = await json<UserRecord>(await owner.mutate(`${prefix}/users/${created.id}`, "PATCH", edit));
    assert.equal(created.name, edit.name);
    assert.equal(created.email, edit.email);
    assert.equal(created.version, originalVersion + 1);
    assert.equal((await owner.mutate(`${prefix}/users/${created.id}`, "PATCH", edit)).status, 409);
    assert.equal((await owner.mutate(`${prefix}/users/${created.id}`, "PATCH", { ...edit, version: created.version, email: "settings-owner@example.test" })).status, 409);
    const fetched = await json<UserRecord>(await owner.request(`${prefix}/users/${created.id}`));
    assert.equal(fetched.email, edit.email);
    assert(!Object.hasOwn(fetched, "password"));
    assert(!Object.hasOwn(fetched, "role"));
    assert.equal((await owner.request(`${prefix}/users/999999999`)).status, 404);
    assert.equal((await owner.request(`${prefix}/users/not-an-id`)).status, 400);
    assert.equal((await owner.request(`${prefix}/users/${created.id}`, { method: "DELETE" })).status, 405);

    currentCheck = "account status and password changes revoke existing sessions";
    await createdSession.login(edit.email);
    assert.equal((await createdSession.request("/api/auth/me")).status, 200);
    created = await json<UserRecord>(await owner.mutate(`${prefix}/users/${created.id}/status`, "POST", { version: created.version, status: "inactive" }));
    assert.equal(created.status, "inactive");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM crm_sessions WHERE user_id = ?").get(created.id) as { count: number }).count, 0);
    created = await json<UserRecord>(await owner.mutate(`${prefix}/users/${created.id}/status`, "POST", { version: created.version, status: "active" }));
    assert.equal((await createdSession.request("/api/auth/me")).status, 401, "A disabled account's old session revived after reactivation.");
    await createdSession.login(edit.email);
    created = await json<UserRecord>(await owner.mutate(`${prefix}/users/${created.id}`, "PATCH", {
      version: created.version, name: created.name, email: created.email, status: created.status, password: changedPassword,
    }));
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM crm_sessions WHERE user_id = ?").get(created.id) as { count: number }).count, 0);
    assert.equal((await createdSession.request("/api/auth/me")).status, 401);
    await createdSession.login(edit.email, password, 401);
    await createdSession.login(edit.email, changedPassword);

    currentCheck = "department assignment derives actor and uses optimistic concurrency";
    assert.equal((await owner.mutate(`${prefix}/users/${created.id}/department`, "PUT", { version: created.version, departmentRole: "Electrical", assignedBy: "5" })).status, 400);
    assert.equal((await owner.mutate(`${prefix}/users/${created.id}/department`, "PUT", { version: created.version, departmentRole: "Unverified department" })).status, 400);
    const departmentVersion = created.version;
    created = await json<UserRecord>(await owner.mutate(`${prefix}/users/${created.id}/department`, "PUT", { version: created.version, departmentRole: "Electrical" }));
    assert.equal(created.departmentRole, "Electrical");
    assert.equal(created.departmentAssignedBy, "1");
    assert(created.departmentAssignedAt);
    assert.equal((await owner.mutate(`${prefix}/users/${created.id}/department`, "PUT", { version: departmentVersion, departmentRole: "Civil" })).status, 409);

    currentCheck = "permission groups and catalog create, edit, search and conflicts";
    let group = await json<GroupRecord>(await permissionsOnly.mutate(`${prefix}/permission-groups`, "POST", { key: "httpfixture", label: "HTTP fixture group", sortOrder: 5 }), 201);
    assert.equal((await permissionsOnly.mutate(`${prefix}/permission-groups`, "POST", { key: "httpfixture", label: "Duplicate group", sortOrder: 6 })).status, 409);
    const groupVersion = group.version;
    group = await json<GroupRecord>(await permissionsOnly.mutate(`${prefix}/permission-groups/${group.id}`, "PATCH", { version: group.version, label: "HTTP edited group", sortOrder: 6 }));
    assert.equal(group.sortOrder, 6);
    assert.equal((await permissionsOnly.mutate(`${prefix}/permission-groups/${group.id}`, "PATCH", { version: groupVersion, label: "Stale group", sortOrder: 7 })).status, 409);
    assert.equal((await permissionsOnly.mutate(`${prefix}/permission-groups/${group.id}`, "PATCH", { version: group.version, key: "forgedkey", label: group.label, sortOrder: group.sortOrder })).status, 400);
    assert.equal((await json<Listing<GroupRecord>>(await owner.request(`${prefix}/permission-groups?query=edited`))).total, 1);
    let permission = await json<PermissionRecord>(await permissionsOnly.mutate(`${prefix}/permissions`, "POST", { key: "reports.view", label: "HTTP report permission", groupId: group.id }), 201);
    assert.equal(permission.groupId, group.id);
    assert.equal((await permissionsOnly.mutate(`${prefix}/permissions`, "POST", { key: "reports.view", label: "Duplicate permission", groupId: group.id })).status, 409);
    const permissionVersion = permission.version;
    permission = await json<PermissionRecord>(await permissionsOnly.mutate(`${prefix}/permissions/${permission.id}`, "PATCH", { version: permission.version, label: "HTTP edited permission", groupId: group.id }));
    assert.equal((await permissionsOnly.mutate(`${prefix}/permissions/${permission.id}`, "PATCH", { version: permissionVersion, label: "Stale permission", groupId: group.id })).status, 409);
    assert.equal((await permissionsOnly.mutate(`${prefix}/permissions/${permission.id}`, "PATCH", { version: permission.version, key: "permissions.manage", label: permission.label, groupId: group.id })).status, 400);
    assert.equal((await json<Listing<PermissionRecord>>(await owner.request(`${prefix}/permissions?query=edited`))).total, 1);
    for (const collection of ["permission-groups", "permissions"]) {
      assert.equal((await owner.request(`${prefix}/${collection}/999999999`)).status, 404);
      assert.equal((await owner.request(`${prefix}/${collection}/1`, { method: "DELETE" })).status, 405);
    }

    currentCheck = "atomic permission replacement, stale forms and live grant revocation";
    let grants = await json<GrantRecord>(await permissionsOnly.request(`${prefix}/users/${created.id}/permissions`));
    assert.deepEqual(grants.permissionIds, []);
    const grantsVersion = grants.version;
    grants = await json<GrantRecord>(await permissionsOnly.mutate(`${prefix}/users/${created.id}/permissions`, "PUT", { version: grants.version, permissionIds: [permission.id] }));
    assert.deepEqual(grants.permissionIds, [permission.id]);
    let identity = await json<{ user: { permissions: string[] } }>(await createdSession.request("/api/auth/me"));
    assert.deepEqual(identity.user.permissions, ["reports.view"]);
    assert.equal((await permissionsOnly.mutate(`${prefix}/users/${created.id}/permissions`, "PUT", { version: grantsVersion, permissionIds: [] })).status, 409);
    assert.equal((await permissionsOnly.mutate(`${prefix}/users/${created.id}/permissions`, "PUT", { version: grants.version, permissionIds: [permission.id, permission.id] })).status, 400);
    assert.equal((await permissionsOnly.mutate(`${prefix}/users/${created.id}/permissions`, "PUT", { version: grants.version, permissionIds: [permission.id, "999999999"] })).status, 404);
    assert.deepEqual((await json<GrantRecord>(await permissionsOnly.request(`${prefix}/users/${created.id}/permissions`))).permissionIds, [permission.id]);
    grants = await json<GrantRecord>(await permissionsOnly.mutate(`${prefix}/users/${created.id}/permissions`, "PUT", { version: grants.version, permissionIds: [] }));
    assert.deepEqual(grants.permissionIds, []);
    identity = await json<{ user: { permissions: string[] } }>(await createdSession.request("/api/auth/me"));
    assert.deepEqual(identity.user.permissions, []);
    const managerGrants = await json<GrantRecord>(await owner.request(`${prefix}/users/3/permissions`));
    await json<GrantRecord>(await owner.mutate(`${prefix}/users/3/permissions`, "PUT", { version: managerGrants.version, permissionIds: [] }));
    assert.equal((await permissionsOnly.request(`${prefix}/permissions`)).status, 403);
    assert.equal((await permissionsOnly.mutate(`${prefix}/permission-groups`, "POST", { key: "revoked", label: "Revoked", sortOrder: 0 })).status, 403);
    console.log("PASS: Settings HTTP authorization, CSRF/origin, input validation, search/pagination, user lifecycle, department assignment, catalog maintenance and atomic grants.");

    currentCheck = "append-only audit events exclude sensitive values";
    const auditEvents = database.prepare("SELECT * FROM crm_audit_events ORDER BY id").all() as {
      id: number; actor_user_id: number; target_type: string; target_id: string;
      action: string; changed_fields: string; occurred_at: string;
    }[];
    assert.equal(auditEvents.length, 13, "Failed requests created events or successful writes missed audit events.");
    const auditJson = JSON.stringify(auditEvents);
    for (const sensitive of ["@", password, changedPassword, storedHash, "HTTP created fixture", "HTTP edited fixture", "settings-http-owner"]) {
      assert(!auditJson.includes(sensitive), "Audit events contain personal or secret values.");
    }
    const allowedFields = new Set(["name", "email", "password", "status", "departmentRole", "departmentAssignedBy", "departmentAssignedAt", "key", "label", "sortOrder", "groupId", "permissionIds"]);
    for (const event of auditEvents) {
      assert([1, 3].includes(event.actor_user_id));
      assert(["users", "permission_groups", "permissions"].includes(event.target_type));
      assert.match(event.target_id, /^[1-9][0-9]*$/);
      const fields = JSON.parse(event.changed_fields) as string[];
      assert(fields.every((field) => allowedFields.has(field)));
      assert(event.occurred_at);
    }
    assert.throws(() => database!.prepare("UPDATE crm_audit_events SET action = 'tamper' WHERE id = ?").run(auditEvents[0]!.id));
    assert.throws(() => database!.prepare("DELETE FROM crm_audit_events WHERE id = ?").run(auditEvents[0]!.id));
    assert.equal(JSON.stringify(database.prepare("SELECT * FROM crm_audit_events ORDER BY id").all()), auditJson);
    console.log("PASS: Successful settings writes have append-only audit events; failures leave no events and audit payloads exclude passwords and personal values.");

    currentCheck = "Chromium settings browser startup";
    browser = await chromium.launch({ headless: true, timeout: 20_000 });
    const page = await browser.newPage();
    let browserErrors = 0;
    page.on("pageerror", () => { browserErrors += 1; });
    page.on("console", (entry) => { if (entry.type() === "error") browserErrors += 1; });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(10_000);
    await page.goto(base + "/settings/users");
    await page.waitForURL(base + "/login");
    await page.getByLabel("Email address").fill("settings-owner@example.test");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(url => url.origin === base && ["/account", "/dashboard"].includes(url.pathname));
    await page.goto(base + "/settings/users");

    currentCheck = "Chromium account creation form inputs";
    await page.getByLabel("Name", { exact: true }).fill("Browser created fixture");
    await page.getByLabel("Email address", { exact: true }).fill("browser-created@example.test");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create user", exact: true }).click();
    currentCheck = "Chromium account creation confirmation";
    await page.getByText("User created.", { exact: true }).waitFor();
    const browserUserRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "browser-created@example.test", exact: true }) });
    await browserUserRow.waitFor();
    currentCheck = "Chromium account edit";
    await browserUserRow.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Browser edited fixture");
    await page.getByRole("button", { name: "Save user", exact: true }).click();
    await page.getByText("User updated.", { exact: true }).waitFor();
    await browserUserRow.getByRole("cell", { name: "Browser edited fixture", exact: true }).waitFor();
    currentCheck = "Chromium account deactivation";
    await browserUserRow.getByRole("button", { name: "Deactivate", exact: true }).click();
    await page.getByText("User deactivated. Existing sessions have been revoked.", { exact: true }).waitFor();
    await browserUserRow.getByRole("cell", { name: "inactive", exact: true }).waitFor();
    currentCheck = "Chromium account reactivation";
    await browserUserRow.getByRole("button", { name: "Activate", exact: true }).click();
    await page.getByText("User activated.", { exact: true }).waitFor();
    await browserUserRow.getByRole("cell", { name: "active", exact: true }).waitFor();
    currentCheck = "Chromium department editor selection";
    await browserUserRow.getByRole("button", { name: "Edit", exact: true }).click();
    currentCheck = "Chromium department selector";
    await page.getByLabel("Department", { exact: true }).selectOption("Civil");
    currentCheck = "Chromium department submission";
    const assignedResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/department") && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Assign department", exact: true }).click();
    assert.equal((await assignedResponse).status(), 200);
    currentCheck = "Chromium department confirmation";
    await page.getByText("Department assigned.", { exact: true }).waitFor();
    currentCheck = "Chromium department list refresh";
    await browserUserRow.getByRole("cell", { name: "Civil", exact: true }).waitFor();
    const assignmentHref = await browserUserRow.getByRole("link", { name: "Permissions", exact: true }).getAttribute("href");
    assert(assignmentHref);
    assert(assignmentHref.startsWith("/settings/permissions/assign?userId="));
    const browserUserId = new URL(assignmentHref, base).searchParams.get("userId");
    assert(browserUserId && /^[1-9][0-9]*$/.test(browserUserId));
    currentCheck = "Chromium account search";
    await page.getByLabel("Search users", { exact: true }).fill("browser-created");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);
    await browserUserRow.waitFor();
    assert.equal(await page.locator("tbody tr").count(), 1);

    currentCheck = "Chromium permission group and catalog workflows";
    await page.goto(base + "/settings/permission-groups");
    await page.getByLabel("Key", { exact: true }).fill("browserfixture");
    await page.getByLabel("Label", { exact: true }).fill("Browser fixture group");
    await page.getByLabel("Display order", { exact: true }).fill("10");
    await page.getByRole("button", { name: "Create group", exact: true }).click();
    await page.getByText("Permission group saved.", { exact: true }).waitFor();
    const browserGroupRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "browserfixture", exact: true }) });
    await browserGroupRow.getByRole("button", { name: "Edit", exact: true }).click();
    assert(await page.getByLabel("Key", { exact: true }).getAttribute("readonly") !== null);
    await page.getByLabel("Label", { exact: true }).fill("Browser edited group");
    await page.getByLabel("Display order", { exact: true }).fill("11");
    await page.getByRole("button", { name: "Save group", exact: true }).click();
    await page.getByText("Permission group saved.", { exact: true }).waitFor();
    await browserGroupRow.getByRole("cell", { name: "Browser edited group", exact: true }).waitFor();

    await page.goto(base + "/settings/permissions");
    await page.getByLabel("Key", { exact: true }).fill("browser.fixture");
    await page.getByLabel("Label", { exact: true }).fill("Browser fixture permission");
    await page.getByLabel("Permission group", { exact: true }).selectOption({ label: "Browser edited group" });
    await page.getByRole("button", { name: "Create permission", exact: true }).click();
    await page.getByText("Permission saved.", { exact: true }).waitFor();
    const browserPermissionRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "browser.fixture", exact: true }) });
    await browserPermissionRow.getByRole("button", { name: "Edit", exact: true }).click();
    assert(await page.getByLabel("Key", { exact: true }).getAttribute("readonly") !== null);
    await page.getByLabel("Label", { exact: true }).fill("Browser edited permission");
    await page.getByLabel("Permission group", { exact: true }).selectOption({ label: "HTTP edited group" });
    await page.getByRole("button", { name: "Save permission", exact: true }).click();
    await page.getByText("Permission saved.", { exact: true }).waitFor();
    await browserPermissionRow.getByRole("cell", { name: "Browser edited permission", exact: true }).waitFor();
    await browserPermissionRow.getByRole("cell", { name: "HTTP edited group", exact: true }).waitFor();

    currentCheck = "Chromium grant selection across search and complete removal";
    await page.goto(base + assignmentHref);
    await page.getByRole("heading", { name: "Permissions for Browser edited fixture", exact: true }).waitFor();
    await page.getByRole("checkbox", { name: "Browser edited permission (browser.fixture)", exact: true }).check();
    await page.getByLabel("Find permissions", { exact: true }).fill("lead");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("checkbox", { name: "Fixture lead visibility (leads.view)", exact: true }).check();
    await page.getByRole("button", { name: "Save permissions", exact: true }).click();
    await page.getByText("Permissions saved.", { exact: true }).waitFor();
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM admin_user_permissions WHERE admin_user_id=?").get(browserUserId) as { count: number }).count, 2);
    await page.getByLabel("Find permissions", { exact: true }).fill("");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const browserGrant = page.getByRole("checkbox", { name: "Browser edited permission (browser.fixture)", exact: true });
    const leadGrant = page.getByRole("checkbox", { name: "Fixture lead visibility (leads.view)", exact: true });
    await browserGrant.waitFor();
    assert(await browserGrant.isChecked());
    assert(await leadGrant.isChecked());
    await browserGrant.uncheck();
    await leadGrant.uncheck();
    const removedResponse = page.waitForResponse((response) => response.url() === `${base}${prefix}/users/${browserUserId}/permissions` && response.request().method() === "PUT");
    await page.getByRole("button", { name: "Save permissions", exact: true }).click();
    assert.equal((await removedResponse).status(), 200);
    await page.getByText("0 selected. Selections are preserved across search results and pages.", { exact: true }).waitFor();
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM admin_user_permissions WHERE admin_user_id=?").get(browserUserId) as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM crm_audit_events").get() as { count: number }).count, 24);
    const completeAudit = JSON.stringify(database.prepare("SELECT * FROM crm_audit_events ORDER BY id").all());
    for (const sensitive of ["@", password, changedPassword, storedHash, "Browser created fixture", "Browser edited fixture"]) {
      assert(!completeAudit.includes(sensitive), "Browser writes disclosed personal or secret values to audit events.");
    }
    currentCheck = "Chromium narrow viewport and runtime errors";
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/settings/users", "/settings/permission-groups", "/settings/permissions", assignmentHref]) {
      await page.goto(base + path);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Settings page overflows a narrow viewport.");
    }
    assert.equal(browserErrors, 0, "Browser reported a console or page runtime error.");
    console.log("PASS: Chromium user create/edit/activation/department, group and permission maintenance, search-preserved grant selection and removal.");
  } finally {
    await browser?.close().catch(() => { /* Complete owned server/database cleanup even if Chromium already exited. */ });
    if (child?.exitCode === null) child.kill();
    if (exited) await exited;
    database?.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), resolve(testRoot));
    assert.equal(target, resolve(directory));
    rmSync(target, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`Settings HTTP/browser verification failed during ${currentCheck}. No real CRM data was used.`);
  if (error instanceof assert.AssertionError && typeof error.actual === "number" && typeof error.expected === "number") {
    console.error(`Numeric assertion: expected ${error.expected}, received ${error.actual}.`);
  }
  process.exitCode = 1;
});
