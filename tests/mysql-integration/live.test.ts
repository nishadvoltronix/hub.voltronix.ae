import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { hash } from "bcryptjs";
import { MysqlDatabase, MysqlDatabaseError } from "../../src/server/db/mysql/database";
import { connectMysql } from "../../src/server/db/mysql/driver";
import { migrateMysqlApplicationSchema, mysqlMigrations } from "../../src/server/db/mysql/migrations";
import { createAuthService } from "../../src/server/auth/service";
import { createSettingsService, SettingsError } from "../../src/server/settings/service";
import { createJobsService, JobsError } from "../../src/server/jobs/service";
import { createCommercialService, CommercialPersistenceError } from "../../src/server/commercial/service";
import { createDepartmentsService, DepartmentsError } from "../../src/server/departments/service";
import { createAttachmentsService, AttachmentError } from "../../src/server/attachments/service";
import { createDashboardService } from "../../src/server/dashboard/service";
import { createLeadsService } from "../../src/server/leads/service";
import { createReportsService } from "../../src/server/reports/service";
import { createExportsService, ExportsError } from "../../src/server/exports/service";
import { createLeadMutationsService, LeadMutationError } from "../../src/server/lead-mutations/service";
import { createQuotationPdfService } from "../../src/server/quotation-pdf/service";
import type { CommercialTransport } from "../../src/server/commercial/transport";
import { approvedLiveMysqlProfile, liveMysqlAcknowledgements, liveMysqlBlockedMessage } from "./guard";

/**
 * Actual MySQL only; deliberately outside tests/*.test.ts and never auto-starts a
 * server. The operator must prepare a NEW empty test schema and private profile.
 * Test records are explicit isolated fixtures, retained afterward, never history.
 */
test("REAL MySQL 8.4.11 application integration (explicit local opt-in only)", { timeout: 180_000 }, async (t) => {
  if (process.env.CRM_MYSQL_LIVE_TEST_ACK !== liveMysqlAcknowledgements.join(" ")) throw new Error(liveMysqlBlockedMessage);
  const { config, fixtureRoot } = approvedLiveMysqlProfile(process.cwd(), [
    ...liveMysqlAcknowledgements, "--fixture-root", process.env.CRM_MYSQL_LIVE_TEST_FIXTURE ?? "",
  ]);
  const evidence: { status: string; startedAt: string; finishedAt?: string; source: string; verifiedServerVersion?: string;
    checks: string[]; migrationsApplied?: number; migrationRepeat?: number; fixturesRetained: true; historicalImport: false;
    externalTransport: string; stagingVerified: false } = {
    status: "FAILED_OR_INCOMPLETE", startedAt: new Date().toISOString(), source: "actual-local-mysql-not-sqlite-or-driver-mock",
    checks: [], fixturesRetained: true, historicalImport: false, externalTransport: "isolated-in-process-mock-only", stagingVerified: false,
  };
  const databases: MysqlDatabase[] = [];
  const check = async (name: string, work: () => Promise<void>) => {
    await t.test(name, async () => { await work(); evidence.checks.push(name); });
  };
  try {
    const migrationConnection = await connectMysql(config);
    let migrationCleanupFailed = false;
    try {
      // This suite NEVER resets an old test schema. Supply another newly approved
      // empty schema/profile for a repeatable run; retained evidence stays intact.
      let objects: unknown;
      try {
        [objects] = await migrationConnection.execute(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?`, [config.database]);
      } catch { throw new Error("MySQL integration schema inventory unavailable; driver details were redacted."); }
      if (!Array.isArray(objects) || objects.length !== 0) throw new Error("BLOCKED: integration schema must be new and empty; existing data was not reset.");
      evidence.migrationsApplied = await migrateMysqlApplicationSchema(migrationConnection, { database: config.database, allowSchemaChanges: true });
      evidence.migrationRepeat = await migrateMysqlApplicationSchema(migrationConnection, { database: config.database, allowSchemaChanges: true });
      assert.equal(evidence.migrationsApplied, mysqlMigrations.length);
      assert.equal(evidence.migrationRepeat, 0);
      evidence.verifiedServerVersion = "8.4.11";
    } finally {
      try { await migrationConnection.end(); }
      catch {
        try { migrationConnection.destroy(); } catch { /* Driver details must never reach TAP or retained evidence. */ }
        migrationCleanupFailed = true;
      }
    }
    if (migrationCleanupFailed) throw new Error("MySQL integration connection cleanup unavailable; driver details were redacted.");
    const db = new MysqlDatabase(config); databases.push(db);
    await check("actual migration is seed-free and idempotent", async () => {
      for (const table of ["users", "tasks", "products", "crm_quotations", "crm_audit_events"]) {
        assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
      }
    });

    // Explicit test identities, random unpublished passwords, no administrator role
    // and no dev:user CLI. They exist only in the approved disposable test schema.
    const password = randomBytes(32).toString("base64url"), passwordHash = await hash(password, 12);
    let actorId = "", deniedId = "", taskId = "";
    await db.transaction(async () => {
      actorId = String((await db.prepare("INSERT INTO users(user_id,username,email,password,status) VALUES(?,?,?,?, 'active')")
        .run("900001", "Synthetic MySQL workflow operator", "mysql-operator@example.invalid", passwordHash)).lastInsertRowid);
      deniedId = String((await db.prepare("INSERT INTO users(username,email,password,status) VALUES(?,?,?, 'active')")
        .run("Synthetic MySQL denied identity", "mysql-denied@example.invalid", passwordHash)).lastInsertRowid);
      for (const key of ["users.write", "permissions.manage", "dashboard.view", "items.write", "items.view", "leads.manage.agents"]) {
        await db.prepare("INSERT INTO permissions(`key`,label) VALUES(?,?)").run(key, "Synthetic explicit test grant");
        await db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE `key`=?").run(actorId, key);
      }
      taskId = String((await db.prepare("INSERT INTO tasks(zoho_crm_id,assigned_to,deal_name,status) VALUES('900002','900001',?,'Closed Won')")
        .run("Synthetic MySQL concurrency fixture")).lastInsertRowid);
    }).immediate();
    const auth = createAuthService(db);
    const owner = (await auth.login("mysql-operator@example.invalid", password, "mysql integration isolated")).sessionToken;
    const denied = (await auth.login("mysql-denied@example.invalid", password, "mysql integration isolated")).sessionToken;
    const settings = createSettingsService(db);

    await check("actual settings persistence, literal search, validation and isolated CRUD", async () => {
      const user = await settings.createUser(owner, { name: "Synthetic 100%_' literal", email: "mysql-created@example.invalid", password, status: "active" });
      assert.equal((await settings.getUser(owner, user.id)).name, "Synthetic 100%_' literal");
      assert.equal((await settings.listUsers(owner, { query: "100%_'", pageSize: 1 })).total, 1);
      assert.equal((await settings.updateUser(owner, user.id, { name: "Updated synthetic identity", email: user.email, status: "active", version: user.version })).version, 2);
      await assert.rejects(settings.createUser(owner, { name: "", email: "invalid", password, status: "active" }), (error: unknown) => error instanceof SettingsError && error.status === 400);
      // Delete only this newly created unreferenced test row; no CRM delete workflow is invented.
      const transient = String((await db.prepare("INSERT INTO users(username,email,password) VALUES(?,?,?)")
        .run("Synthetic transient DAL CRUD", "mysql-transient@example.invalid", passwordHash)).lastInsertRowid);
      assert.equal((await db.prepare("DELETE FROM users WHERE id=? AND email=?").run(transient, "mysql-transient@example.invalid")).changes, 1);
      assert.equal(await db.prepare("SELECT id FROM users WHERE id=?").get(transient), undefined);
    });

    await check("actual DML failure rolls back business row and its audit atomically", async () => {
      const prior = (await db.prepare("SELECT COUNT(*) AS n FROM crm_audit_events").get() as { n: number }).n;
      await assert.rejects(db.transaction(async () => {
        const id = String((await db.prepare("INSERT INTO users(username,email,password) VALUES(?,?,?)")
          .run("Synthetic rolled-back identity", "mysql-rollback@example.invalid", passwordHash)).lastInsertRowid);
        await db.prepare("INSERT INTO crm_audit_events(actor_user_id,target_type,target_id,action,changed_fields) VALUES(?,'users',?,'users.create','[]')").run(actorId, id);
        await db.prepare("INSERT INTO departments_assign(task_id,user_id,department) VALUES(?,?,?)").run("9223372036854775806", actorId, "Civil");
      }).immediate(), (error: unknown) => error instanceof MysqlDatabaseError && error.code === "MYSQL_FOREIGN_KEY");
      assert.equal(await db.prepare("SELECT id FROM users WHERE email=?").get("mysql-rollback@example.invalid"), undefined);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM crm_audit_events").get() as { n: number }).n, prior);
    });

    await check("actual concurrent repository versions allow exactly one update and one conflict", async () => {
      const other = new MysqlDatabase(config); databases.push(other);
      const outcomes = await Promise.allSettled([
        createJobsService(db).updateStatus(owner, taskId, { expectedVersion: 1, jobStatus: "Hold" }),
        createJobsService(other).updateStatus(owner, taskId, { expectedVersion: 1, jobStatus: "Closed" }),
      ]);
      assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = outcomes.find((value) => value.status === "rejected");
      assert.ok(rejected?.status === "rejected" && rejected.reason instanceof JobsError && rejected.reason.status === 409);
      assert.equal((await createJobsService(db).getJob(owner, taskId)).version, 2);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM crm_job_audit_events WHERE task_id=?").get(taskId) as { n: number }).n, 1);
    });

    await check("actual permission checks, fresh grant revocation, CSRF and logout remain enforced", async () => {
      await assert.rejects(settings.listGroups(undefined), (error: unknown) => error instanceof SettingsError && error.status === 401);
      await assert.rejects(settings.listGroups(denied), (error: unknown) => error instanceof SettingsError && error.status === 403);
      const permission = await db.prepare("SELECT CAST(id AS CHAR) AS id FROM permissions WHERE `key`='permissions.manage'").get() as { id: string };
      const granted = await settings.replaceGrants(owner, deniedId, { version: 1, permissionIds: [permission.id] });
      await settings.listGroups(denied);
      await settings.replaceGrants(owner, deniedId, { version: granted.version, permissionIds: [] });
      await assert.rejects(settings.listGroups(denied), (error: unknown) => error instanceof SettingsError && error.status === 403);
      const session = await auth.login("mysql-denied@example.invalid", password, "mysql integration isolated");
      assert.equal(await auth.verifySessionCsrf(session.sessionToken, session.csrfToken), true);
      assert.equal(await auth.verifySessionCsrf(session.sessionToken, randomBytes(32).toString("base64url")), false);
      await auth.logout(session.sessionToken);
      assert.equal(await auth.authenticate(session.sessionToken), null);
    });

    await check("actual product persistence and idempotent replay use MySQL with isolated transport replies", async () => {
      let transportCalls = 0;
      const transport: CommercialTransport = { async request() { transportCalls++; return { status: 200,
        body: { data: [{ code: "SUCCESS", status: "success", details: { id: "900003" } }] } }; } };
      const commercial = createCommercialService(db, { transport });
      const input = { operationId: randomUUID(), name: "Synthetic MySQL 100% product", description: "Isolated integration fixture" };
      const created = await commercial.createProduct(owner, input);
      assert.deepEqual(await commercial.createProduct(owner, input), created);
      assert.equal(transportCalls, 1);
      assert.equal((await commercial.getProduct(owner, "900003")).name, input.name);
      await assert.rejects(commercial.createProduct(owner, { ...input, name: "Changed duplicate request" }),
        (error: unknown) => error instanceof CommercialPersistenceError && error.status === 409);
      const runtime = createCommercialService(db);
      assert.equal((await runtime.getCapabilities(owner)).integrationAvailable, false);
      await assert.rejects(runtime.createProduct(owner, { ...input, operationId: randomUUID() }),
        (error: unknown) => error instanceof CommercialPersistenceError && error.status === 503);
    });

    await check("actual generated uniqueness protects unfinished journals; completed task reservations can be reused", async () => {
      const first = randomUUID(), second = randomUUID(), at = new Date().toISOString(), digest = "a".repeat(64);
      const insert = db.prepare("INSERT INTO crm_lead_operations(operation_id,actor_user_id,task_id,kind,request_hash,state,created_at,updated_at) VALUES(?,?,?,'lead.stage',?,'inflight',?,?)");
      await insert.run(first, actorId, taskId, digest, at, at);
      await assert.rejects(insert.run(second, actorId, taskId, digest, at, at),
        (error: unknown) => error instanceof MysqlDatabaseError && error.code === "MYSQL_CONFLICT");
      await db.prepare("UPDATE crm_lead_operations SET state='reconciliation' WHERE operation_id=?").run(first);
      await assert.rejects(insert.run(second, actorId, taskId, digest, at, at),
        (error: unknown) => error instanceof MysqlDatabaseError && error.code === "MYSQL_CONFLICT");
      await db.prepare("UPDATE crm_lead_operations SET state='completed' WHERE operation_id=?").run(first);
      await insert.run(second, actorId, taskId, digest, at, at);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM crm_lead_operations WHERE task_id=?").get(taskId) as { n: number }).n, 2);
    });

    await check("actual exact decimal strings, large IDs, binary bytes and immutable audit survive fresh connections", async () => {
      const amount = "123456789012345678901234567890.123456789012345678";
      await db.prepare("UPDATE products SET unit_price=? WHERE product_id='900003'").run(amount);
      const reopened = new MysqlDatabase(config); databases.push(reopened);
      assert.equal((await reopened.prepare("SELECT unit_price FROM products WHERE product_id='900003'").get() as { unit_price: string }).unit_price, amount);
      await db.prepare("INSERT INTO users(id,username,email,password) VALUES(?,?,?,?)").run("9007199254740993", "Synthetic large identifier", "mysql-large-id@example.invalid", passwordHash);
      assert.equal((await reopened.prepare("SELECT CAST(id AS CHAR) AS id FROM users WHERE email=?").get("mysql-large-id@example.invalid") as { id: string }).id, "9007199254740993");
      const bytes = Buffer.from([0, 255, 128, 10, 65]), attachmentId = randomUUID();
      await db.prepare("INSERT INTO task_attachment(id,task_id,uploaded_by,file_name,media_type,file_size,content_sha256,content) VALUES(?,?,?,?,?,?,?,?)")
        .run(attachmentId, taskId, actorId, "synthetic-fixture.bin", "application/octet-stream", bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes);
      assert.deepEqual((await reopened.prepare("SELECT content FROM task_attachment WHERE id=?").get(attachmentId) as { content: Buffer }).content, bytes);
      await assert.rejects(db.prepare("UPDATE crm_commercial_audit_events SET target_id=? WHERE actor_user_id=?").run("unchanged", actorId),
        (error: unknown) => error instanceof MysqlDatabaseError && error.code === "MYSQL_SIGNAL");
      await assert.rejects(db.prepare("DELETE FROM crm_commercial_audit_events WHERE actor_user_id=?").run(actorId),
        (error: unknown) => error instanceof MysqlDatabaseError && error.code === "MYSQL_SIGNAL");
    });
    // Additional fixtures are created only in this run's explicitly approved test
    // schema. Values are assertions, never claimed to be recovered CRM records.
    let workerId = "", worker = "", departmentTask = "", logAttachment = "";
    const departments = createDepartmentsService(db), attachments = createAttachmentsService(db);
    const fixtureTime = Date.now(), today = new Date(fixtureTime + 14_400_000).toISOString().slice(0, 10);
    const dayStart = new Date(Date.parse(today + "T00:00:00Z") - 14_400_000).toISOString();
    const searchMarker = "MySQL literal 100%_!";
    const pngChunk = (type: string, content: Buffer) => {
      const header = Buffer.alloc(8), checksum = Buffer.alloc(4);
      header.writeUInt32BE(content.length); header.write(type, 4);
      checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), content])));
      return Buffer.concat([header, content, checksum]);
    };
    const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(1); pngHeader.writeUInt32BE(1, 4); pngHeader[8] = 8; pngHeader[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", pngHeader),
      pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))), pngChunk("IEND", Buffer.alloc(0))]);

    await check("actual department assignment, work log, status and log-file authorization persist atomically", async () => {
      await db.transaction(async () => {
        workerId = String((await db.prepare("INSERT INTO users(user_id,username,email,password,department_role) VALUES(?,?,?,?,?)")
          .run("900004", "Synthetic MySQL electrical worker", "mysql-worker@example.invalid", passwordHash, "Electrical")).lastInsertRowid);
        await db.prepare("INSERT INTO permissions(`key`,label) VALUES('electrical.manage','Synthetic electrical grant')").run();
        await db.prepare("INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE `key`='electrical.manage'").run(workerId);
        departmentTask = String((await db.prepare("INSERT INTO tasks(zoho_crm_id,assigned_to,deal_name,status,Job_Status,job_deal_number,service_charge,created_at) VALUES('900010','900001',?,'Close to Won','Active','MYSQL-JOB-1','123.45',?)")
          .run(searchMarker + " department fixture", dayStart)).lastInsertRowid);
      }).immediate();
      worker = (await auth.login("mysql-worker@example.invalid", password, "mysql integration isolated")).sessionToken;
      const assigned = await departments.assign(owner, departmentTask, { expectedVersion: 1,
        assignments: [{ department: "Electrical", userId: workerId }] });
      assert.equal(assigned.version, 2); assert.equal(assigned.assignments[0]?.userId, workerId);
      assert.equal((await departments.listQueue(worker, "Electrical", { query: "100%_!", pageSize: 1 })).total, 1);
      await assert.rejects(departments.getJob(denied, "Electrical", departmentTask),
        (error: unknown) => error instanceof DepartmentsError && error.status === 403);
      const logged = await departments.addLog(worker, "Electrical", departmentTask, { expectedVersion: 2,
        authority: "DESIGN", status: "DOCUMENTS PENDING", comments: "Synthetic comment", notes: "Synthetic work log" },
      { name: "synthetic-log.png", mediaType: "image/png", content: png });
      assert.equal(logged.version, 3);
      const logs = await departments.listLogs(worker, "Electrical", departmentTask, { pageSize: 1 });
      assert.equal(logs.total, 1); assert.equal(logs.items[0]?.notes, "Synthetic work log");
      logAttachment = logs.items[0]?.attachment?.id ?? ""; assert.ok(logAttachment);
      assert.deepEqual((await departments.downloadLogAttachment(worker, logAttachment)).content, png);
      assert.deepEqual((await departments.downloadLogAttachment(owner, logAttachment)).content, png);
      await assert.rejects(departments.downloadLogAttachment(denied, logAttachment),
        (error: unknown) => error instanceof DepartmentsError && error.status === 404);
      const processed = await departments.updateStatus(worker, "Electrical", departmentTask, { expectedVersion: 3, status: "Process" });
      assert.equal(processed.assignment.status, "Process"); assert.equal(processed.version, 4);
      await assert.rejects(departments.addLog(worker, "Electrical", departmentTask, { expectedVersion: 3,
        authority: "DESIGN", status: "DOCUMENTS PENDING", notes: "Stale synthetic log" }),
      (error: unknown) => error instanceof DepartmentsError && error.status === 409);
      assert.equal((await departments.listLogs(worker, "Electrical", departmentTask)).total, 1);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM crm_department_audit_events WHERE task_id=?").get(departmentTask) as { n: number }).n, 3);
      await assert.rejects(db.prepare("UPDATE crm_department_work_logs SET notes=? WHERE task_id=?").run("Forbidden fixture edit", departmentTask),
        (error: unknown) => error instanceof MysqlDatabaseError && error.code === "MYSQL_SIGNAL");
    });

    await check("actual private task files enforce hashes, permissions, stale versions and outer rollback", async () => {
      const bytes = Buffer.from("Synthetic private file\nNo historical records"), metadata = { expectedVersion: 4, name: "synthetic.txt", mediaType: "text/plain" };
      const before = (await db.prepare("SELECT COUNT(*) AS n FROM task_attachment WHERE task_id=?").get(departmentTask) as { n: number }).n;
      const rollbackFixture = new Error("Explicit isolated rollback fixture");
      await assert.rejects(db.transaction(async () => {
        await attachments.upload(owner, departmentTask, metadata, bytes);
        // The deliberate exception tests enclosing transaction rollback without DDL,
        // deleting data, corrupting a database, or weakening immutable audit triggers.
        throw rollbackFixture;
      }).immediate(), (error: unknown) => error === rollbackFixture);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM task_attachment WHERE task_id=?").get(departmentTask) as { n: number }).n, before);
      assert.equal((await departments.getAssignments(owner, departmentTask)).version, 4);
      const uploaded = await attachments.upload(owner, departmentTask, metadata, bytes);
      assert.equal(uploaded.version, 5);
      assert.deepEqual((await attachments.download(worker, uploaded.id)).content, bytes);
      assert.equal((await attachments.list(worker, departmentTask, { pageSize: 1 })).total, before + 1);
      const hashRow = await db.prepare("SELECT content_sha256 FROM task_attachment WHERE id=?").get(uploaded.id) as { content_sha256: string };
      assert.equal(hashRow.content_sha256, createHash("sha256").update(bytes).digest("hex"));
      await assert.rejects(attachments.download(denied, uploaded.id), (error: unknown) => error instanceof AttachmentError && error.status === 404);
      await assert.rejects(attachments.upload(owner, departmentTask, metadata, bytes), (error: unknown) => error instanceof AttachmentError && error.status === 409);
      await assert.rejects(attachments.upload(owner, departmentTask, { ...metadata, expectedVersion: 5, name: "unsafe.exe" }, bytes),
        (error: unknown) => error instanceof AttachmentError && error.status === 415);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM crm_attachment_audit_events WHERE task_id=?").get(departmentTask) as { n: number }).n, 1);
      const unassigned = await departments.unassign(owner, departmentTask, { expectedVersion: 5, department: "Electrical" });
      await assert.rejects(attachments.download(worker, uploaded.id), (error: unknown) => error instanceof AttachmentError && error.status === 404);
      await assert.rejects(departments.downloadLogAttachment(worker, logAttachment), (error: unknown) => error instanceof DepartmentsError && error.status === 404);
      await departments.assign(owner, departmentTask, { expectedVersion: unassigned.version, assignments: [{ department: "Electrical", userId: workerId }] });
    });

    await check("actual dashboard, pipeline, reports and exports evaluate date/search/assignment SQL", async () => {
      // Keep the earlier concurrency fixture outside this report's selected day.
      await db.prepare("UPDATE tasks SET created_at='2000-01-01T00:00:00.000Z',service_charge='0' WHERE id=?").run(taskId);
      const leads = createLeadsService(db);
      const pipeline = await leads.listPipeline(owner, { query: "100%_!", page: 1, pageSize: 1 });
      assert.equal(pipeline.scope, "own"); assert.equal(pipeline.total, 1); assert.equal(pipeline.items[0]?.id, departmentTask);
      assert.equal((await leads.listPipeline(owner, { query: "100%_!", page: 2, pageSize: 1 })).items.length, 0);
      assert.equal((await leads.getLead(owner, departmentTask)).serviceCharge, "123.45");
      const dashboard = await createDashboardService(db, { now: () => fixtureTime }).getDashboard(owner);
      assert.equal(dashboard.global?.accounts.totalPending, "123.45");
      const progress = dashboard.global?.departmentProgress.find((row) => row.department === "Electrical");
      assert.equal(progress?.total, 1); assert.equal(progress?.pending, 1);
      const report = await createReportsService(db, { now: () => fixtureTime }).employeePerformance(owner, { dateFrom: today, dateTo: today });
      assert.equal(report.summary.wonJobs, 1); assert.equal(report.summary.wonAmount, "123.45");
      const workbook = await createExportsService(db).exportJobs(owner, { query: "100%_!" });
      assert.equal(workbook.rowCount, 1); assert.equal(Buffer.from(workbook.bytes).subarray(0, 2).toString("ascii"), "PK");
      assert.equal((await createExportsService(db).exportDepartmentJobs(worker, "Electrical", { query: "100%_!" })).rowCount, 1);
      await assert.rejects(createExportsService(db).exportJobs(denied), (error: unknown) => error instanceof ExportsError && error.status === 403);
    });

    await check("actual lead stage and note persistence retain idempotency and audit with isolated transport", async () => {
      const leadId = String((await db.prepare("INSERT INTO tasks(zoho_crm_id,assigned_to,deal_name,status) VALUES('900020','900001',?,'Pending')")
        .run("Synthetic MySQL stage fixture")).lastInsertRowid);
      let remoteCalls = 0;
      const leads = createLeadMutationsService(db, { wait: async () => {}, transport: { async request(request) {
        assert.equal(db.inTransaction, false); remoteCalls++;
        if (request.method === "GET") return { status: 200, body: { data: [{ id: "900020", Stage: "Site Visit",
          DealNumber: "MYSQL-LEAD-1", SiteDealNumber: "MYSQL-SITE-1", Site_Deal_Date: new Date(fixtureTime).toISOString() }] } };
        const id = request.path.includes("Notes") ? "900021" : "900020";
        return { status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id } }] } };
      } } });
      const stage = { operationId: randomUUID(), expectedVersion: 1, stage: "Site Visit", serviceCharge: "0.123456789012345678" };
      const transitioned = await leads.changeStage(owner, leadId, stage);
      assert.equal(transitioned.version, 2); assert.deepEqual(await leads.changeStage(owner, leadId, stage), transitioned);
      assert.equal(remoteCalls, 2);
      const note = await leads.addNote(owner, leadId, { operationId: randomUUID(), expectedVersion: 2, title: "Synthetic note", content: "Synthetic content" });
      assert.ok(note.noteId); assert.equal(note.version, 3);
      await leads.editNote(owner, leadId, note.noteId, { operationId: randomUUID(), expectedVersion: 3, content: "Synthetic edited content" });
      const read = createLeadsService(db);
      assert.equal((await read.listNotes(owner, leadId)).items[0]?.content, "Synthetic edited content");
      assert.equal((await read.listStatusHistory(owner, leadId)).total, 1);
      assert.equal((await read.getLead(owner, leadId)).serviceCharge, "0.123456789012345678");
      await assert.rejects(leads.addNote(denied, leadId, { operationId: randomUUID(), expectedVersion: 4, title: "Denied", content: "Denied" }),
        (error: unknown) => error instanceof LeadMutationError && error.status === 403);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM crm_lead_audit_events WHERE task_id=?").get(leadId) as { n: number }).n, 3);
    });

    await check("actual quotation lines/totals and both local PDF templates retain discount and permission blocks", async () => {
      await db.prepare("UPDATE users SET company='VOLTRONIX CONTRACTING LLC',sale_name='Synthetic sales operator' WHERE id=?").run(actorId);
      const quoteTask = String((await db.prepare("INSERT INTO tasks(zoho_crm_id,assigned_to,deal_name,status,account_name,created_at) VALUES('900030','900001',?,'Site Visit',?,?)")
        .run("Synthetic MySQL quote fixture", "Synthetic customer LLC", dayStart)).lastInsertRowid);
      let remoteCalls = 0;
      const contactPath = "/Contacts/search?criteria=" + encodeURIComponent("(Last_Name:equals:Synthetic contact)");
      const expectedRequests = [`GET ${contactPath}`, "POST /Quotes", "GET /Quotes/900032", "PUT /Deals"];
      const commercial = createCommercialService(db, { transport: { async request(request) {
        assert.equal(db.inTransaction, false); assert.equal(request.apiVersion, "v2.1");
        assert.equal(`${request.method} ${request.path}`, expectedRequests[remoteCalls]); remoteCalls++;
        if (request.method === "GET" && request.path === contactPath) return { status: 200, body: { data: [{ id: "900031", Last_Name: "Synthetic contact" }] } };
        if (request.method === "GET" && request.path === "/Quotes/900032") return { status: 200,
          body: { data: [{ id: "900032", Quote_No: "MYSQL-QUOTE-001", Modified_Time: new Date(fixtureTime).toISOString() }] } };
        if (request.method === "POST" && request.path === "/Quotes") return { status: 200,
          body: { data: [{ code: "SUCCESS", status: "success", details: { id: "900032" } }] } };
        if (request.method === "PUT" && request.path === "/Deals") {
          assert.deepEqual(request.body, { data: [{ id: "900030", Stage: "Proposal/Price Quote", QuoteDealNumber: "MYSQL-QUOTE-001" }] });
          return { status: 200, body: { data: [{ code: "SUCCESS", status: "success", details: { id: "900030" } }] } };
        }
        throw new Error("Unexpected isolated quotation transport request.");
      } } });
      const quotation = { subject: "Synthetic MySQL quotation", kindAttention: "Synthetic contact", discount: "5", adjustment: "0",
        items: [{ productId: "900003", productName: "Synthetic MySQL 100% product", description: "Synthetic line description",
          uom: "PCS", quantity: "2", unitPrice: "100.10", itemDiscount: "10" }] };
      const input = { operationId: randomUUID(), expectedVersion: 1, quotation };
      const created = await commercial.createQuotation(owner, quoteTask, input);
      assert.deepEqual(await commercial.createQuotation(owner, quoteTask, input), created); assert.equal(remoteCalls, 4);
      const detail = await commercial.getQuotation(owner, quoteTask);
      assert.equal(detail.subtotal, "180.18"); assert.equal(detail.grandTotal, "183.94"); assert.equal(detail.quotation.items.length, 1);
      const line = await db.prepare("SELECT service_charge,item_discount,total FROM proposal_items WHERE quotation_id=?").get(created.quoteId) as
        { service_charge: string; item_discount: string; total: string };
      assert.deepEqual(line, { service_charge: "100.10", item_discount: "10", total: "180.18" });
      const pdf = createQuotationPdfService(commercial);
      for (const company of ["VOLTRONIX CONTRACTING LLC", "VOLTRONIX SWITCHGEAR LLC"]) {
        await db.prepare("UPDATE users SET company=? WHERE id=?").run(company, actorId);
        const document = await pdf.download(owner, quoteTask);
        assert.equal(document.bytes.subarray(0, 5).toString("ascii"), "%PDF-"); assert.ok(document.pages >= 1);
      }
      // This verifies generation and authorized persistence; it is not a visual
      // glyph/layout approval and does not perform any Zoho sandbox request.
      await assert.rejects(pdf.download(denied, quoteTask), (error: unknown) => error instanceof CommercialPersistenceError && error.status === 404);
      await assert.rejects(commercial.updateQuotation(owner, quoteTask, { operationId: randomUUID(), expectedVersion: detail.taskVersion,
        expectedQuoteVersion: detail.version, quotation: { ...quotation, items: [{ ...quotation.items[0]!, itemDiscount: "0" }] } }),
      (error: unknown) => error instanceof CommercialPersistenceError && error.status === 409);
      assert.equal(remoteCalls, 4);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM crm_commercial_audit_events WHERE task_id=?").get(quoteTask) as { n: number }).n, 1);
    });
    if (evidence.checks.length === 13) evidence.status = "PASS_ACTUAL_LOCAL_MYSQL_SCOPED_CHECKS";
  } finally {
    for (const database of databases) database.close();
    evidence.finishedAt = new Date().toISOString();
    const descriptor = openSync(join(fixtureRoot, `integration-evidence-${randomUUID()}.json`), "wx", 0o600);
    try { writeFileSync(descriptor, JSON.stringify(evidence, null, 2) + "\n", "utf8"); }
    finally { closeSync(descriptor); }
  }
});
