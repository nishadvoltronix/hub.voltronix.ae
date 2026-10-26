import { assertSqliteReferenceBuild } from "./sqlite-reference-http-guard";
assertSqliteReferenceBuild();
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
import type { LeadMutationCapabilities } from "../tests/sqlite-reference/lead-mutations/contracts";

let currentCheck = "isolated lead mutation fixture setup";
async function main() {
  const root = realpathSync(process.cwd()), testRoot = localDirectory(root, [".local-data", "test"], true);
  const directory = mkdtempSync(join(testRoot, "lead-mutations-")), databasePath = relative(root, join(directory, "crm.sqlite"));
  let db: SqliteDatabase | undefined, child: ChildProcess | undefined, exited: Promise<unknown> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const password = randomBytes(24).toString("base64url"), passwordHash = hashSync(password, 4);
  try {
    db = openDatabase(parseDatabaseConfig({ DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath }, root), { create: true });
    migrateDatabase(db);
    for (let id = 1; id <= 4; id++) db.prepare("INSERT INTO users(id,user_id,username,email,password) VALUES(?,?,?,?,?)")
      .run(id, id === 3 ? null : `90000000000000${id}`, `Synthetic lead HTTP user ${id}`, `lead-http-${id}@example.invalid`, passwordHash);
    function grant(userId: number, key: string) {
      db!.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
      db!.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(userId, key);
    }
    grant(1, "leads.manage.agents"); grant(1, "deals.manage"); grant(2, "leads.view"); grant(3, "deals.manage");
    grant(4, "leads.view"); grant(4, "leads.manage");
    db.prepare("INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status) VALUES(1,'700000000000001','900000000000001','Synthetic mutation lead','Pending'),(2,'700000000000002','900000000000004','Synthetic foreign lead','Pending')").run();
    db.prepare("INSERT INTO job_notes(id,deal_id,note_title,note_content,zoho_note_id) VALUES(1,'700000000000001','Synthetic existing note','Synthetic only','800000000000001'),(2,'700000000000002','Synthetic foreign note','Synthetic foreign only','800000000000002')").run();
    const originalTasks = db.prepare("SELECT * FROM tasks ORDER BY id").all(), originalNotes = db.prepare("SELECT * FROM job_notes ORDER BY id").all();
    const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const address = listener.address(); assert(address && typeof address !== "string"); const port = address.port;
    await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: root, windowsHide: true, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: databasePath, APP_ORIGIN: base },
    }); exited = once(child, "exit");
    function client() {
      const cookies = new Map<string, string>(); let csrf = "";
      async function request(path: string, options: RequestInit = {}) {
        const headers = new Headers(options.headers); headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
        const response = await fetch(base + path, { ...options, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        for (const item of response.headers.getSetCookie()) { const pair = item.split(";")[0]!, index = pair.indexOf("="); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
        return response;
      }
      async function login(id: number) {
        const challenge = await request("/api/auth/csrf"); assert.equal(challenge.status, 200); csrf = (await challenge.json() as { csrfToken: string }).csrfToken;
        const response = await request("/api/auth/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify({ email: `lead-http-${id}@example.invalid`, password }) });
        assert.equal(response.status, 200); csrf = (await response.json() as { csrfToken: string }).csrfToken;
      }
      const write = (path: string, method: string, body: unknown, headers: Record<string, string> = {}) => request(path, { method,
        headers: { Origin: base, "Content-Type": "application/json", "X-CSRF-Token": csrf, ...headers }, body: JSON.stringify(body) });
      return { request, login, write };
    }
    async function status(response: Response, expected: number) {
      assert.equal(response.status, expected); assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text(); assert(!text.includes(password) && !text.includes(passwordHash), "Synthetic credential exposed.");
      assert(!text.includes("SQLITE_") && !text.includes("node_modules") && !text.includes(".local-data"), "Private internals exposed.");
      return JSON.parse(text) as unknown;
    }
    currentCheck = "built server startup";
    const deadline = Date.now() + 20_000; let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Owned lead test server exited.");
      try { ready = (await fetch(base + "/api/health/live", { signal: AbortSignal.timeout(500) })).ok; } catch { /* startup */ }
      if (ready) break; await delay(150);
    }
    assert(ready);
    const anonymous = client(), owner = client(), reader = client(), unlinked = client(), broad = client();
    const note = () => ({ operationId: randomUUID(), expectedVersion: 1, title: "Synthetic submitted note", content: "Synthetic test only" });
    const stage = () => ({ operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit" });
    const deal = () => ({ operationId: randomUUID(), firstName: "Synthetic", lastName: "Customer", companyName: "Synthetic HTTP company",
      email: "synthetic-http-customer@example.invalid", mobile: "+000000", phone: "+000001", department: "VOLTRONIX CONTRACTING LLC" });
    currentCheck = "authentication and independent read/write grants";
    await status(await anonymous.request("/api/leads/1/capabilities"), 401);
    await status(await anonymous.write("/api/leads/1/notes", "POST", note()), 401);
    assert.equal((await anonymous.request("/deals/new")).status, 307);
    for (const [caller, id] of [[owner, 1], [reader, 2], [unlinked, 3], [broad, 4]] as const) await caller.login(id);
    const caps = await status(await owner.request("/api/leads/1/capabilities"), 200) as LeadMutationCapabilities;
    assert.equal(caps.integrationAvailable, false); assert.equal(caps.version, 1); assert.equal(caps.canWriteNotes, true); assert.deepEqual(caps.stages, ["Site Visit", "Closed Lost"]);
    assert.equal((await status(await reader.request("/api/leads/1/capabilities"), 200) as LeadMutationCapabilities).canWriteNotes, false);
    await status(await owner.request("/api/leads/2/capabilities"), 404);
    await status(await reader.write("/api/leads/1/notes", "POST", { invalid: true }), 403);
    await status(await reader.write("/api/leads/1/stage", "PATCH", stage()), 403);
    await status(await broad.write("/api/leads/1/stage", "PATCH", stage()), 403);
    await status(await broad.write("/api/leads/1/notes/2", "PATCH", note()), 404);
    await status(await owner.write("/api/leads/2/notes", "POST", note()), 404);
    await status(await reader.write("/api/deals", "POST", deal()), 403);
    await status(await unlinked.write("/api/deals", "POST", deal()), 403);
    assert.equal((await reader.request("/deals/new")).status, 404);
    currentCheck = "fail-closed runtime with valid authorized requests";
    await status(await owner.write("/api/leads/1/stage", "PATCH", stage()), 503);
    await status(await owner.write("/api/leads/1/notes", "POST", note()), 503);
    await status(await owner.write("/api/leads/1/notes/1", "PATCH", note()), 503);
    await status(await owner.write("/api/deals", "POST", deal()), 503);
    const concurrent = await Promise.all([owner.write("/api/leads/1/notes", "POST", note()), owner.write("/api/leads/1/notes", "POST", note())]);
    for (const response of concurrent) await status(response, 503);
    currentCheck = "CSRF origin validation strict inputs and safe errors";
    const rejectedHeaders: Record<string, string>[] = [{ Origin: "https://cross-origin.invalid" }, { "X-CSRF-Token": "invalid" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of rejectedHeaders)
      await status(await owner.write("/api/leads/1/notes", "POST", note(), headers), 403);
    await status(await owner.request("/api/leads/1/capabilities", { headers: { Origin: "https://cross-origin.invalid" } }), 403);
    await status(await owner.request("/api/leads/1/capabilities?unexpected=true"), 400);
    await status(await owner.write("/api/leads/1/stage", "PATCH", { ...stage(), stage: "Closed Won" }), 400);
    await status(await owner.write("/api/leads/1/stage", "PATCH", { ...stage(), serviceCharge: "-1" }), 400);
    await status(await owner.write("/api/leads/1/notes", "POST", { ...note(), injected: true }), 400);
    await status(await owner.write("/api/leads/1/notes", "POST", { ...note(), expectedVersion: 2 }), 409);
    await status(await owner.write("/api/leads/1/notes", "POST", { ...note(), title: "" }), 400);
    await status(await owner.write("/api/leads/1/notes", "POST", { ...note(), content: "x".repeat(9000) }), 413);
    await status(await owner.write("/api/leads/1/notes", "POST", note(), { "Content-Type": "text/plain" }), 415);
    await status(await owner.write("/api/deals", "POST", { ...deal(), email: "bad" }), 400);
    assert.equal((await owner.write("/api/leads/1/notes/1", "DELETE", {})).status, 405);
    assert.equal((await owner.write("/api/leads/1/stage", "PUT", {})).status, 405);
    currentCheck = "Chromium blocked actions and permission-filtered controls";
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.name));
    async function browserLogin(id: number) {
      await page.goto(base + "/login"); await page.getByLabel("Email").fill(`lead-http-${id}@example.invalid`); await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.origin === base && ["/account", "/dashboard"].includes(url.pathname));
    }
    await browserLogin(1); currentCheck = "Chromium owner lead controls"; await page.goto(base + "/leads/1");
    await page.getByRole("heading", { name: "Synthetic mutation lead", exact: true }).waitFor();
    await page.getByText("Lead changes require an approved Zoho connection. Submission is unavailable until that connection is verified.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Update Status", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Add Note", exact: true }).isDisabled(), true);
    currentCheck = "Chromium lead reload and mobile layout";
    await page.getByRole("button", { name: "Reload lead", exact: true }).click();
    await page.getByRole("heading", { name: "Synthetic existing note", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    currentCheck = "Chromium unavailable deal form and mobile layout";
    await page.goto(base + "/deals/new"); await page.getByRole("heading", { name: "Create deal", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create deal", exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel("Company name", { exact: true }).isDisabled(), true);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(base + "/login");
    currentCheck = "Chromium read-only account visibility";
    await browserLogin(2); await page.goto(base + "/leads/1");
    await page.getByText("Your account can read this lead but cannot change it.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save lead stage", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Add lead note", exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    currentCheck = "grant revocation and proof of zero runtime writes";
    db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
    await status(await owner.write("/api/leads/1/notes", "POST", note()), 403);
    await status(await owner.write("/api/deals", "POST", deal()), 403);
    await status(await owner.request("/api/leads/1/capabilities"), 404);
    assert.deepEqual(db.prepare("SELECT * FROM tasks ORDER BY id").all(), originalTasks);
    assert.deepEqual(db.prepare("SELECT * FROM job_notes ORDER BY id").all(), originalNotes);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM crm_lead_operations").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM crm_lead_audit_events").get() as { n: number }).n, 0);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    console.log("PASS: Lead/deal HTTP fail-closed integration, fresh permissions, parent/owner scope, CSRF/origin, strict validation, safe errors and zero journal/business writes.");
    console.log("PASS: Chromium disabled stage/note/deal controls, reader-only visibility, reload and 390px layout without browser errors. No sandbox or mocked HTTP success claimed.");
  } finally {
    await browser?.close().catch(() => {}); if (child?.exitCode === null) child.kill(); if (exited) await exited; db?.close();
    const target = realpathSync(directory); assert.equal(dirname(target), resolve(testRoot)); assert.equal(target, resolve(directory)); rmSync(target, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  console.error(`Lead mutation HTTP/browser verification failed during ${currentCheck}. No real CRM records or external API were used.`);
  if (error instanceof assert.AssertionError && typeof error.actual === "number" && typeof error.expected === "number") console.error(`Numeric assertion: expected ${error.expected}, received ${error.actual}.`);
  process.exitCode = 1;
});
