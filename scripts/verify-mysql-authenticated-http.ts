import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { openSync, closeSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { hash } from "bcryptjs";
import { chromium } from "playwright";
import { readMysqlProfile } from "../src/server/config/mysql-profile";
import { approvedMysqlBrowserFixture, browserMysqlAcknowledgement } from "../src/server/config/mysql-runtime";
import { MysqlDatabase } from "../src/server/db/mysql/database";
import { connectMysql } from "../src/server/db/mysql/driver";
import { assertMysqlMigrationsCurrent, migrateMysqlApplicationSchema } from "../src/server/db/mysql/migrations";
import { mysqlExpectedTables } from "../src/server/db/mysql/schema";
import { assertMysqlRuntimePrivileges } from "../src/server/db/mysql/runtime-privileges";
import { calculateQuotation, parseQuotationInput } from "../src/server/commercial/quotations";
import type { UserRecord } from "../src/server/settings/service";
import type { QuotationDetail } from "../src/server/commercial/persistence-contracts";
import { assertMysqlBrowserProfilePair, mysqlBrowserArguments } from "./mysql-browser-guard";

/**
 * Explicit isolated fixture only. Never starts MySQL, creates databases/accounts,
 * resets data, imports history, enables transport or records passwords/cookies.
 * Provision the current empty schema and separate scoped identities beforehand.
 */
async function main() {
  const args = mysqlBrowserArguments(process.argv.slice(2));
  const root = process.cwd();
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const address = listener.address(); assert(address && typeof address !== "string");
  const port = address.port, origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const childEnvironment = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", APP_ORIGIN: origin,
    CRM_MYSQL_RUNTIME_PROFILE: "isolated-browser-fixture", CRM_MYSQL_BROWSER_FIXTURE: args.relativeRoot,
    CRM_MYSQL_BROWSER_ACK: browserMysqlAcknowledgement };
  // Never override an explicit network-disable guard inherited from the operator.
  if (process.env.CRM_MYSQL_NETWORK_DISABLED === "1") throw new Error("MySQL networking remains explicitly disabled.");
  const approved = approvedMysqlBrowserFixture(root, childEnvironment);
  const operator = readMysqlProfile(["--profile", ".env.mysql.local"], approved.fixtureRoot);
  assertMysqlBrowserProfilePair(operator, approved.config, args.database);
  assert.equal(approved.fixtureId, args.fixtureId);

  const evidence = { status: "FAILED_OR_INCOMPLETE", source: "actual-local-mysql-authenticated-http-and-chromium",
    startedAt: new Date().toISOString(), finishedAt: "", buildId: readFileSync(join(root, ".next", "BUILD_ID"), "utf8").trim(),
    fixture: args.relativeRoot, serverVersion: "", migrationRepeat: -1, runtimePrivilegesVerified: false,
    checks: [] as string[], currentCheck: "identity and empty fixture preflight", externalRequestsBlocked: 0,
    failure: null as null | { category: string; actualHttpStatus?: number; expectedHttpStatus?: number },
    fixturesRetained: true, historicalImport: false, runtimeZohoTransport: false, stagingVerified: false,
    limitations: ["Loopback HTTP does not verify host HTTPS, proxy or Secure cookie delivery.",
      "Product/quotation fixtures are explicit synthetic persistence, not successful runtime remote mutations.",
      "No unsupported business DELETE route is invented; grant replacement and logout exercise supported deletion.",
      "PDF bytes and authorized downloads do not establish visual glyph/layout approval."] };
  const evidencePath = join(approved.fixtureRoot, `browser-evidence-${randomUUID()}.json`);
  let child: ChildProcess | undefined, exited: Promise<unknown> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const db = new MysqlDatabase(operator);
  const check = async (name: string, work: () => Promise<void>) => {
    evidence.currentCheck = name; await work(); evidence.checks.push(name);
  };
  const count = async (table: string, where = "", values: (string | number)[] = []) => {
    assert(/^[a-z_]+$/.test(table));
    return (await db.prepare(`SELECT COUNT(*) n FROM ${table}${where ? " WHERE " + where : ""}`).get(...values) as { n: number }).n;
  };
  try {
    // Claim this new fixture exclusively. Even a failed attempt is preserved and
    // must use a newly provisioned fixture on retry; no cleanup/reset is attempted.
    const claim = openSync(join(approved.fixtureRoot, "browser-attempt.json"), "wx", 0o600);
    try { writeFileSync(claim, JSON.stringify({ startedAt: evidence.startedAt, fixtureId: args.fixtureId }) + "\n"); }
    finally { closeSync(claim); }
    const operatorConnection = await connectMysql(operator);
    let operatorCleanupFailed = false;
    try {
      await assertMysqlMigrationsCurrent(operatorConnection, args.database);
      evidence.migrationRepeat = await migrateMysqlApplicationSchema(operatorConnection, { database: args.database, allowSchemaChanges: true });
      assert.equal(evidence.migrationRepeat, 0);
      for (const table of mysqlExpectedTables.filter((table) => table !== "crm_app_lock")) assert.equal(await count(table), 0);
      evidence.serverVersion = "8.4.11";
    } finally { try { await operatorConnection.end(); } catch { try { operatorConnection.destroy(); } catch { /* private driver details suppressed */ } operatorCleanupFailed = true; } }
    if (operatorCleanupFailed) throw new Error("Operator connection cleanup failed.");
    const runtimeConnection = await connectMysql(approved.config);
    let runtimeCleanupFailed = false;
    try {
      await assertMysqlMigrationsCurrent(runtimeConnection, args.database);
      await assertMysqlRuntimePrivileges(runtimeConnection, args.database);
      evidence.runtimePrivilegesVerified = true;
    } finally { try { await runtimeConnection.end(); } catch { try { runtimeConnection.destroy(); } catch { /* private driver details suppressed */ } runtimeCleanupFailed = true; } }
    if (runtimeCleanupFailed) throw new Error("Application connection cleanup failed.");
    evidence.checks.push("exact MySQL 8.4.11, empty current schema, repeat migration zero and separate scoped application identity");

    evidence.currentCheck = "explicit non-administrator synthetic fixture preparation";
    const password = randomBytes(32).toString("base64url"), passwordHash = await hash(password, 12);
    const users: string[] = [], taskIds: string[] = [];
    const quotation = parseQuotationInput({ subject: "Synthetic browser quotation", kindAttention: "Synthetic fixture contact",
      discount: "5", adjustment: "0", items: [{ productId: "830001", productName: "Synthetic browser product",
        description: "Explicit isolated fixture line", uom: "PCS", quantity: "2", unitPrice: "100.10", itemDiscount: "10" }] });
    const totals = calculateQuotation(quotation, "percentage"), at = new Date().toISOString();
    await db.transaction(async () => {
      for (let i = 0; i < 4; i++) {
        users.push(String((await db.prepare("INSERT INTO users(user_id,username,email,password,company,sale_name,department_role) VALUES(?,?,?,?,?,?,?)")
          .run(String(810001 + i), `Synthetic browser identity ${i + 1}`, `mysql-browser-${i + 1}@example.invalid`, passwordHash,
            i === 1 ? "VOLTRONIX SWITCHGEAR LLC" : "VOLTRONIX CONTRACTING LLC", "Synthetic fixture operator", i === 3 ? "Electrical" : null)).lastInsertRowid));
      }
      for (const key of ["users.write", "permissions.manage", "dashboard.view", "items.view", "items.write", "leads.manage.agents", "electrical.manage"]) {
        const permission = String((await db.prepare("INSERT INTO permissions(`key`,label) VALUES(?,?)").run(key, "Synthetic explicitly approved test permission")).lastInsertRowid);
        const assigned = key === "electrical.manage" ? [users[3]!] : [users[0]!, users[1]!];
        for (const user of assigned) await db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(?,?)").run(user, permission);
      }
      await db.prepare("INSERT INTO products(product_id,product_name,description,unit_price,created_at,updated_at) VALUES('830001',?,?,'100.10',?,?)")
        .run("Synthetic browser product", "Explicit isolated fixture product", at, at);
      for (let i = 0; i < 3; i++) {
        const task = String((await db.prepare("INSERT INTO tasks(zoho_crm_id,assigned_to,deal_name,status,account_name,Job_Status,service_charge) VALUES(?,?,?,?,?,'Active','183.94')")
          .run(String(820001 + i), String(i === 1 ? 810002 : 810001), `Synthetic browser ${i === 2 ? "job" : "quote"} ${i + 1}`,
            i === 2 ? "Closed Won" : "Proposal/Price Quote", "Synthetic fixture account")).lastInsertRowid);
        taskIds.push(task);
        if (i === 2) continue;
        const external = String(840001 + i), quoteNumber = `SYNTHETIC-BROWSER-${i + 1}`;
        await db.prepare("UPDATE tasks SET quote_id=?,quote_number=?,quote_deal_number=? WHERE id=?").run(external, quoteNumber, quoteNumber, task);
        const { items, ...header } = quotation;
        const quoteId = String((await db.prepare("INSERT INTO crm_quotations(task_id,external_id,quote_number,header_json,totals_json,calculation_policy,remote_modified_at,created_at,updated_at) VALUES(?,?,?,?,?,'percentage-create-v1',?,?,?)")
          .run(task, external, quoteNumber, JSON.stringify(header), JSON.stringify(totals), at, at, at)).lastInsertRowid);
        const item = items[0]!;
        await db.prepare("INSERT INTO proposal_items(quotation_id,task_id,position,product_id,product_name,product_description,uom,quantity,service_charge,item_discount,total) VALUES(?,?,0,?,?,?,?,?,?,?,?)")
          .run(quoteId, task, item.productId, item.productName, item.description, item.uom, item.quantity, item.unitPrice, item.itemDiscount, totals.lineTotals[0]!);
      }
    }).immediate();
    assert.equal(await count("users", "role='admin'"), 0);
    const jobId = taskIds[2]!;

    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: root, windowsHide: true, stdio: "ignore", env: childEnvironment,
    });
    exited = once(child, "exit").catch(() => { evidence.status = "FAILED_OR_INCOMPLETE"; });
    // Only the owned loopback origin is accepted. No arbitrary URL argument exists.
    function client() {
      const cookies = new Map<string, string>(); let csrfToken = "";
      async function request(path: string, options: RequestInit = {}) {
        assert(path.startsWith("/") && !path.startsWith("//"));
        const headers = new Headers(options.headers);
        headers.set("Cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
        const response = await fetch(origin + path, { ...options, headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
        for (const value of response.headers.getSetCookie()) {
          const pair = value.split(";")[0]!, equals = pair.indexOf("=");
          cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
        }
        return response;
      }
      async function login(email: string) {
        const challenge = await request("/api/auth/csrf"); assert.equal(challenge.status, 200);
        csrfToken = (await challenge.json() as { csrfToken: string }).csrfToken;
        const response = await request("/api/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ email, password }) });
        assert.equal(response.status, 200); csrfToken = (await response.json() as { csrfToken: string }).csrfToken;
        assert(response.headers.getSetCookie().every((cookie) => /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie) && /Path=\//i.test(cookie)));
      }
      function write(path: string, method: string, body: unknown, extra: Record<string, string> = {}) {
        return request(path, { method, headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrfToken, ...extra }, body: JSON.stringify(body) });
      }
      function upload(path: string, form: FormData) { return request(path, { method: "POST", headers: { Origin: origin, "X-CSRF-Token": csrfToken }, body: form }); }
      return { request, login, write, upload };
    }
    const anonymous = client(), owner = client(), otherOwner = client(), denied = client(), worker = client();
    async function json<T>(response: Response, expected = 200): Promise<T> {
      assert.equal(response.status, expected); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("vary") ?? "", /cookie/i);
      const text = await response.text(); assert(!text.includes(password) && !text.includes(passwordHash)); return JSON.parse(text) as T;
    }
    evidence.currentCheck = "owned loopback application startup";
    let online = false;
    const startupDeadline = Date.now() + 30_000;
    while (Date.now() < startupDeadline) {
      if (child.exitCode !== null) throw new Error("Owned application exited.");
      try { online = (await fetch(origin + "/api/health/live", { redirect: "manual", signal: AbortSignal.timeout(500) })).status === 200; } catch { /* owned child startup only */ }
      if (online) break; await delay(250);
    }
    assert(online);
    for (const [caller, index] of [[owner, 1], [otherOwner, 2], [denied, 3], [worker, 4]] as const) {
      evidence.currentCheck = `initial synthetic identity ${index} HTTP login`;
      await caller.login(`mysql-browser-${index}@example.invalid`);
    }

    await check("authenticated HTTP sessions, permissions and CSRF fail closed", async () => {
      for (const path of ["/api/settings/users", "/api/jobs", "/api/items", "/api/quotations", `/api/quotations/${taskIds[0]}/pdf`]) {
        assert.equal((await anonymous.request(path)).status, 401);
      }
      assert.equal((await denied.request("/api/settings/users")).status, 403);
      assert.equal((await denied.request("/api/jobs")).status, 403);
      assert.equal((await otherOwner.request(`/api/quotations/${taskIds[0]}`)).status, 404);
      assert.equal((await owner.request("/api/settings/users", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 403);
      assert.equal((await owner.write("/api/settings/users", "POST", {}, { Origin: "https://unapproved.invalid" })).status, 403);
      assert.equal((await owner.write("/api/settings/users", "POST", {})).status, 400);
    });
    await check("settings HTTP create/read/update, literal search, conflict and live grant revocation", async () => {
      const created = await json<UserRecord>(await owner.write("/api/settings/users", "POST", { name: "Synthetic 100%_ browser created", email: "mysql-browser-created@example.invalid", password, status: "active" }), 201);
      assert.equal((await json<UserRecord>(await owner.request(`/api/settings/users/${created.id}`))).name, created.name);
      assert.equal((await json<{ total: number }>(await owner.request("/api/settings/users?query=" + encodeURIComponent("100%_") + "&pageSize=1"))).total, 1);
      const edited = await json<UserRecord>(await owner.write(`/api/settings/users/${created.id}`, "PATCH", { name: "Synthetic browser updated", email: created.email, status: "active", version: 1 }));
      assert.equal(edited.version, 2);
      assert.equal((await owner.write(`/api/settings/users/${created.id}`, "PATCH", { name: "Stale fixture", email: created.email, status: "active", version: 1 })).status, 409);
      assert.equal((await denied.write(`/api/settings/users/${created.id}`, "PATCH", { name: "Denied fixture", email: created.email, status: "active", version: 2 })).status, 403);
      const permission = await db.prepare("SELECT CAST(id AS CHAR) id FROM permissions WHERE `key`='permissions.manage'").get() as { id: string };
      const granted = await json<{ version: number }>(await owner.write(`/api/settings/users/${users[2]}/permissions`, "PUT", { version: 1, permissionIds: [permission.id] }));
      assert.equal((await denied.request("/api/settings/permission-groups")).status, 200);
      await json(await owner.write(`/api/settings/users/${users[2]}/permissions`, "PUT", { version: granted.version, permissionIds: [] }));
      assert.equal((await denied.request("/api/settings/permission-groups")).status, 403);
      assert.equal(await count("admin_user_permissions", "admin_user_id=?", [users[2]!]), 0);
      assert.equal(await count("crm_audit_events", "target_type='users' AND target_id=? AND action IN ('users.create','users.update')", [created.id]), 2);
      const createdClient = client(); await createdClient.login(created.email);
      await json(await owner.write(`/api/settings/users/${created.id}/status`, "POST", { version: 2, status: "inactive" }));
      assert.equal((await createdClient.request("/api/auth/me")).status, 401);
    });
    await check("job HTTP concurrent updates commit one audit and reject the stale request", async () => {
      const before = await count("crm_job_audit_events", "task_id=?", [jobId]);
      const responses = await Promise.all([owner.write(`/api/jobs/${jobId}/status`, "PATCH", { expectedVersion: 1, jobStatus: "Hold" }),
        owner.write(`/api/jobs/${jobId}/status`, "PATCH", { expectedVersion: 1, jobStatus: "Closed" })]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
      assert.equal((await json<{ version: number }>(await owner.request(`/api/jobs/${jobId}`))).version, 2);
      assert.equal(await count("crm_job_audit_events", "task_id=?", [jobId]), before + 1);
      assert.equal((await owner.write(`/api/jobs/${jobId}/status`, "PATCH", { expectedVersion: 2, jobStatus: "invalid" })).status, 400);
      assert.equal((await denied.write(`/api/jobs/${jobId}/remarks`, "PATCH", { expectedVersion: 2, remarks: "Denied" })).status, 403);
      const updated = await json<{ version: number }>(await owner.write(`/api/jobs/${jobId}/remarks`, "PATCH", { expectedVersion: 2, remarks: "Synthetic browser persisted remarks" }));
      assert.equal(updated.version, 3);
    });
    await check("application-identity transaction rollback preserves business and audit rows", async () => {
      const applicationDb = new MysqlDatabase(approved.config, { verify: async (connection, database) => {
        await assertMysqlRuntimePrivileges(connection, database);
        await assertMysqlMigrationsCurrent(connection, database);
      } }), sentinel = new Error("Synthetic rollback sentinel");
      const before = await count("crm_job_audit_events", "task_id=?", [jobId]);
      try {
        await assert.rejects(applicationDb.transaction(async () => {
          await applicationDb.prepare("UPDATE tasks SET Admin_Remarks='Synthetic rollback marker' WHERE id=?").run(jobId);
          await applicationDb.prepare("INSERT INTO crm_job_audit_events(actor_user_id,task_id,action,changed_fields) VALUES(?,?,'jobs.remarks','[]')").run(users[0]!, jobId);
          throw sentinel;
        }).immediate(), (error: unknown) => error === sentinel);
      } finally { applicationDb.close(); }
      assert.equal((await db.prepare("SELECT Admin_Remarks remarks FROM tasks WHERE id=?").get(jobId) as { remarks: string }).remarks, "Synthetic browser persisted remarks");
      assert.equal(await count("crm_job_audit_events", "task_id=?", [jobId]), before);
    });
    let attachmentId = "";
    const attachmentBytes = Buffer.from("Synthetic private browser attachment\nNo real customer data.");
    await check("private attachment HTTP content validation, authorized download and atomic stale-version denial", async () => {
      const form = (name: string, version: number, mediaType = "text/plain") => {
        const body = new FormData(); body.set("expectedVersion", String(version)); body.set("file", new Blob([attachmentBytes], { type: mediaType }), name); return body;
      };
      const uploaded = await json<{ id: string; version: number }>(await owner.upload(`/api/leads/${jobId}/attachments`, form("synthetic-browser.txt", 3)));
      attachmentId = uploaded.id; assert.equal(uploaded.version, 4);
      const download = await owner.request(`/api/attachments/${attachmentId}`); assert.equal(download.status, 200);
      assert.match(download.headers.get("cache-control") ?? "", /private.*no-store/); assert.equal(download.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), attachmentBytes);
      assert.equal((await denied.request(`/api/attachments/${attachmentId}`)).status, 404);
      assert.equal((await owner.upload(`/api/leads/${jobId}/attachments`, form("stale.txt", 3))).status, 409);
      assert.equal((await owner.upload(`/api/leads/${jobId}/attachments`, form("forbidden.exe", 4))).status, 415);
      assert.equal((await owner.upload(`/api/leads/${jobId}/attachments`, form("invalid.png", 4, "image/png"))).status, 415);
      assert.equal(await count("task_attachment", "task_id=?", [jobId]), 1);
      assert.equal(await count("crm_attachment_audit_events", "task_id=?", [jobId]), 1);
      const stored = await db.prepare("SELECT content_sha256 FROM task_attachment WHERE id=?").get(attachmentId) as { content_sha256: string };
      assert.equal(stored.content_sha256, createHash("sha256").update(attachmentBytes).digest("hex"));
    });
    await check("department assignment, immutable work log and log attachment enforce live ownership", async () => {
      // The concurrent-status test deliberately ends in Hold or Closed. Both
      // block new work logs, and Closed also blocks assignment. Use the supported
      // manager operation to reopen this synthetic job rather than bypassing the
      // business rule or depending on which racing status request committed.
      evidence.currentCheck = "department workflow: restore synthetic job to Active";
      const previous = await json<{ version: number; jobStatus: string }>(await owner.request(`/api/jobs/${jobId}`));
      assert.equal(previous.version, 4); assert(["Hold", "Closed"].includes(previous.jobStatus));
      const active = await json<{ version: number; jobStatus: string }>(await owner.write(`/api/jobs/${jobId}/status`, "PATCH", {
        expectedVersion: previous.version, jobStatus: "Active",
      }));
      assert.equal(active.jobStatus, "Active"); assert.equal(active.version, previous.version + 1);
      evidence.currentCheck = "department workflow: authorized assignment";
      const assigned = await json<{ version: number }>(await owner.write(`/api/jobs/${jobId}/assignments`, "POST", {
        expectedVersion: active.version, assignments: [{ department: "Electrical", userId: users[3] }],
      }));
      assert.equal(assigned.version, active.version + 1);
      // Electrical logs allow images/PDF, not the text format accepted by generic
      // task attachments. Generate a complete local one-pixel PNG with valid CRCs.
      const chunk = (type: string, content: Buffer) => {
        const header = Buffer.alloc(8), checksum = Buffer.alloc(4);
        header.writeUInt32BE(content.length); header.write(type, 4);
        checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), content])));
        return Buffer.concat([header, content, checksum]);
      };
      const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(1); pngHeader.writeUInt32BE(1, 4); pngHeader[8] = 8; pngHeader[9] = 6;
      const logBytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", pngHeader),
        chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
      const form = new FormData(); form.set("payload", JSON.stringify({ expectedVersion: assigned.version, authority: "DESIGN", status: "DOCUMENTS PENDING", comments: "Synthetic browser comment", notes: "Synthetic browser work log" }));
      form.set("file", new Blob([logBytes], { type: "image/png" }), "synthetic-log.png");
      evidence.currentCheck = "department workflow: authorized work log and private PNG attachment";
      const logged = await json<{ version: number }>(await worker.upload(`/api/departments/Electrical/jobs/${jobId}/logs`, form));
      assert.equal(logged.version, assigned.version + 1);
      const logs = await json<{ total: number; items: { attachment: { id: string } | null }[] }>(await worker.request(`/api/departments/Electrical/jobs/${jobId}/logs`));
      assert.equal(logs.total, 1); const id = logs.items[0]?.attachment?.id; assert(id);
      const download = await worker.request(`/api/log-attachments/${id}`); assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), logBytes);
      assert.equal((await denied.request(`/api/log-attachments/${id}`)).status, 404);
      evidence.currentCheck = "department workflow: unassign and revoke attachment access";
      const unassigned = await json<{ version: number }>(await owner.write(`/api/jobs/${jobId}/unassign`, "POST", { expectedVersion: logged.version, department: "Electrical" }));
      assert.equal(unassigned.version, logged.version + 1);
      assert.equal((await worker.request(`/api/log-attachments/${id}`)).status, 404);
      assert.equal((await worker.request(`/api/attachments/${attachmentId}`)).status, 404);
      assert.equal(await count("crm_department_audit_events", "task_id=?", [jobId]), 3);
    });
    await check("synthetic quotation persistence, both authorized PDF templates and discount/integration blocks", async () => {
      assert.equal((await json<{ total: number }>(await owner.request("/api/items?query=Synthetic&pageSize=1"))).total, 1);
      for (const [caller, task] of [[owner, taskIds[0]!], [otherOwner, taskIds[1]!]] as const) {
        const detail = await json<QuotationDetail>(await caller.request(`/api/quotations/${task}`));
        assert.equal(detail.grandTotal, "183.94"); assert.equal(detail.subtotal, "180.18");
        const pdf = await caller.request(`/api/quotations/${task}/pdf`); assert.equal(pdf.status, 200);
        assert.equal(pdf.headers.get("content-type"), "application/pdf"); assert.equal(pdf.headers.get("cache-control"), "private, no-store");
        assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString("ascii"), "%PDF-");
        assert.equal((await denied.request(`/api/quotations/${task}/pdf`)).status, 404);
        assert.equal((await caller.write(`/api/quotations/${task}`, "PATCH", { operationId: randomUUID(), expectedVersion: detail.taskVersion,
          expectedQuoteVersion: detail.version, quotation: { ...quotation, items: [{ ...quotation.items[0]!, itemDiscount: "0" }] } })).status, 409);
      }
      assert.equal((await owner.write("/api/items", "POST", { operationId: randomUUID(), name: "Synthetic disabled remote product", description: "No transport" })).status, 503);
      assert.equal(await count("crm_commercial_operations"), 0);
      assert.equal(await count("crm_lead_operations"), 0);
      assert.equal(await count("crm_commercial_audit_events"), 0);
    });

    await check("Chromium login, settings create/edit/deactivate, private download, quotation PDF and logout", async () => {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      await context.route("**/*", async (route) => {
        if (new URL(route.request().url()).origin !== origin) { evidence.externalRequestsBlocked++; await route.abort(); }
        else await route.continue();
      });
      const page = await context.newPage(); await page.goto(origin + "/login");
      await page.getByLabel("Email address").fill("mysql-browser-1@example.invalid");
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.origin === origin && ["/account", "/dashboard"].includes(url.pathname));
      await page.goto(origin + "/settings/users");
      const editor = page.getByRole("region", { name: "User editor" });
      await editor.getByLabel("Name", { exact: true }).fill("Synthetic Chromium created");
      await editor.getByLabel("Email address", { exact: true }).fill("mysql-chromium-created@example.invalid");
      await editor.getByLabel("Password", { exact: true }).fill(password);
      await editor.getByRole("button", { name: "Create user", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "User created." }).waitFor();
      const row = page.getByRole("row").filter({ hasText: "mysql-chromium-created@example.invalid" });
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      await editor.getByLabel("Name", { exact: true }).fill("Synthetic Chromium updated");
      await editor.getByRole("button", { name: "Save user", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "User updated." }).waitFor();
      await Promise.all([
        page.waitForEvent("dialog").then(async dialog => {
          assert.equal(dialog.type(), "confirm"); assert.equal(dialog.message(), "Change user status?");
          await dialog.accept();
        }),
        row.getByRole("button", { name: "Deactivate", exact: true }).click(),
      ]);
      await page.getByRole("status").filter({ hasText: "User deactivated." }).waitFor();
      await page.goto(origin + `/quotations/${taskIds[0]}`);
      await page.getByRole("heading", { name: "SYNTHETIC-BROWSER-1", exact: true }).waitFor();
      await page.getByRole("status").filter({ hasText: "This saved quotation uses an earlier calculation policy" }).waitFor();
      const downloadEvent = page.waitForEvent("download"); await page.getByRole("link", { name: "Download quotation PDF" }).click();
      const download = await downloadEvent, stream = await download.createReadStream(); assert(stream);
      const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      assert.equal(Buffer.concat(chunks).subarray(0, 5).toString("ascii"), "%PDF-"); await download.delete();
      const browserFile = await context.request.get(origin + `/api/attachments/${attachmentId}`, { maxRedirects: 0 });
      assert.equal(browserFile.status(), 200); assert.deepEqual(await browserFile.body(), attachmentBytes);
      await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(origin + "/login");
      assert.equal((await context.request.get(origin + "/api/auth/me", { maxRedirects: 0 })).status(), 401);
      await page.goto(origin + "/login"); await page.getByLabel("Email address").fill("mysql-browser-3@example.invalid");
      await page.getByLabel("Password", { exact: true }).fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL(url => url.origin === origin && ["/account", "/dashboard"].includes(url.pathname));
      assert.equal((await context.request.get(origin + "/api/settings/users", { maxRedirects: 0 })).status(), 403);
      assert.equal((await context.request.get(origin + `/api/attachments/${attachmentId}`, { maxRedirects: 0 })).status(), 404);
      assert.equal(evidence.externalRequestsBlocked, 0);
      await context.close();
    });
    await check("HTTP logout revokes the existing session", async () => {
      assert.equal((await owner.write("/api/auth/logout", "POST", {})).status, 200);
      assert.equal((await owner.request("/api/auth/me")).status, 401);
      assert.equal((await owner.request(`/api/attachments/${attachmentId}`)).status, 401);
    });
    evidence.status = "PASS_ACTUAL_LOCAL_MYSQL_AUTHENTICATED_HTTP_CHROMIUM";
  } catch (error) {
    // Only fixed categories and bounded numeric status codes are retained. Never
    // serialize arbitrary error messages, assertion values, response bodies,
    // driver errors or Playwright call logs: they may contain private inputs.
    const categories: Record<string, string> = {
      AssertionError: "assertion", TimeoutError: "timeout", MysqlDatabaseError: "database-operation",
      MysqlRuntimePrivilegeError: "runtime-privilege-contract", CommercialError: "commercial-validation",
    };
    evidence.failure = { category: error instanceof Error ? categories[error.name] ?? "verification-operation" : "verification-operation" };
    if (error instanceof Error && error.name === "AssertionError" && "actual" in error && "expected" in error) {
      const status = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;
      if (status(error.actual) && status(error.expected)) {
        evidence.failure.actualHttpStatus = error.actual;
        evidence.failure.expectedHttpStatus = error.expected;
      }
    }
    throw error;
  } finally {
    try { await browser?.close(); } catch { evidence.status = "FAILED_OR_INCOMPLETE"; }
    if (child && child.exitCode === null) child.kill();
    if (exited) await Promise.race([exited, delay(10_000).then(() => { if (child?.exitCode === null) evidence.status = "FAILED_OR_INCOMPLETE"; })]);
    db.close(); evidence.finishedAt = new Date().toISOString();
    const file = openSync(evidencePath, "wx", 0o600);
    try { writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n"); } finally { closeSync(file); }
    console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks.length,
      evidence: relative(root, evidencePath), fixtureRetained: true, stagingVerified: false }));
  }
  assert.equal(evidence.status, "PASS_ACTUAL_LOCAL_MYSQL_AUTHENTICATED_HTTP_CHROMIUM");
}
main().catch(() => { console.error("Authenticated MySQL browser verification blocked or failed. No database was reset; no credentials, cookies, SQL driver details or response bodies were logged."); process.exitCode = 1; });
