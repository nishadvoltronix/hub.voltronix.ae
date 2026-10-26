import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.ts";
import { configureDatabase } from "../../tests/sqlite-reference/db/connection.ts";
import { migrateDatabase } from "../../tests/sqlite-reference/db/migrations.ts";
import { createAuthService } from "../../tests/sqlite-reference/auth/service.ts";
import { createLeadsService } from "../../tests/sqlite-reference/leads/service.ts";
import { createDepartmentsService } from "../../tests/sqlite-reference/departments/service.ts";
import { createCommercialService } from "../../tests/sqlite-reference/commercial/service.ts";
import { createLeadMutationsService } from "../../tests/sqlite-reference/lead-mutations/service.ts";
import { createReportsService } from "../../tests/sqlite-reference/reports/service.ts";
import { DEPARTMENTS } from "../../tests/sqlite-reference/departments/contracts.ts";
import { DemoSeedError, seedDemo, type DemoIdentity } from "./fixture.ts";

const Database = createRequire(new URL("../../package.json", import.meta.url))("better-sqlite3") as new (path: string) => SqliteDatabase;
const NOW = "2026-10-12T08:00:00.000Z";
function memory() { const db = new Database(":memory:"); configureDatabase(db); return db; }

test("fresh SQLite demo authenticates distinct nonadmin identities and exposes seeded workflows with real permissions", async (t) => {
  const db = memory(); t.after(() => db.close()); assert.equal(migrateDatabase(db), 10);
  const fixture = await seedDemo(db, { now: NOW });
  assert.deepEqual(fixture.summary, { synthetic: true, users: 10, tasks: 5, products: 1, quotations: 2,
    departmentAssignments: 5, workLogs: 5, notes: 5, statusHistory: 5 });
  const identities = [fixture.identities.operator, fixture.identities.browser, fixture.identities.denied,
    fixture.identities.contracting, fixture.identities.switchgear, ...Object.values(fixture.identities.workers)];
  assert.ok(new Set(identities.map(value => value.password)).size === identities.length, "Every identity needs independent random credentials");
  assert.ok(identities.every(value => value.email.endsWith("@example.invalid") && value.password.length >= 32));
  assert.ok((db.prepare("SELECT password,role,quote_access FROM users").all() as { password: string; role: string; quote_access: number }[])
    .every(value => /^\$2[aby]\$12\$/.test(value.password) && value.role === "sqlite-demo-nonadmin" && value.quote_access === 0));
  const auth = createAuthService(db, { now: () => Date.parse(NOW) });
  const signIn = async (identity: DemoIdentity) => (await auth.login(identity.email, identity.password, `fixture-${identity.id}`)).sessionToken;
  const manager = await signIn(fixture.identities.browser), denied = await signIn(fixture.identities.denied);
  const actor = auth.authenticate(manager)!;
  assert.ok(actor.permissions.includes("dashboard.view") && actor.permissions.includes("users.write")
    && actor.permissions.includes("permissions.manage") && !actor.permissions.includes("leads.manage.agents"));
  assert.ok(auth.canAccessTask(actor, fixture.contractingTaskId));
  assert.equal(auth.canAccessTask(auth.authenticate(denied)!, fixture.jobId), false);
  // Services own their normal clocks. Keep these test sessions valid at the actual test time.
  db.prepare("UPDATE crm_sessions SET expires_at=?").run(Math.max(Date.now(), Date.parse(NOW)) + 86_400_000);
  const leads = createLeadsService(db);
  assert.equal(leads.listPipeline(manager).total, 5);
  assert.equal(leads.listNotes(manager, fixture.leadId).total, 1);
  assert.equal(leads.listStatusHistory(manager, fixture.leadId).total, 1);
  const commercial = createCommercialService(db);
  assert.equal(commercial.listProducts(manager).total, 1);
  assert.equal(commercial.listQuotations(manager).total, 2);
  const contracting = commercial.getQuotation(manager, fixture.contractingTaskId);
  const switchgear = commercial.getQuotation(manager, fixture.switchgearTaskId);
  assert.equal(contracting.task.assignedCompany, "VOLTRONIX CONTRACTING LLC");
  assert.equal(switchgear.task.assignedCompany, "VOLTRONIX SWITCHGEAR LLC");
  assert.equal(contracting.totals.subtotal, "250.25");
  assert.equal(contracting.quotation.items[0]!.itemDiscount, "0");
  assert.equal(commercial.getCapabilities(manager).integrationAvailable, false);
  await assert.rejects(createLeadMutationsService(db).addNote(manager, fixture.leadId,
    { operationId: randomUUID(), expectedVersion: 1, title: "Synthetic request", content: "Must remain unavailable" }),
  (error: unknown) => error !== null && typeof error === "object" && "status" in error && error.status === 503);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM crm_lead_operations").get() as { n: number }).n, 0);
  const departments = createDepartmentsService(db, { now: () => Date.parse(NOW) });
  for (const department of DEPARTMENTS) {
    const worker = await signIn(fixture.identities.workers[department]);
    assert.equal(departments.listQueue(worker, department).total, 1);
    assert.equal(departments.getJob(worker, department, fixture.jobId).id, fixture.jobId);
    assert.equal(departments.listLogs(worker, department, fixture.jobId).total, 1);
  }
  assert.equal(createReportsService(db, { now: () => Date.parse(NOW) }).employeePerformance(manager).summary.totalDeals, 5);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(migrateDatabase(db), 0);
  const before = db.prepare("SELECT id,username,password FROM users ORDER BY id").all();
  await assert.rejects(seedDemo(db, { now: NOW }), DemoSeedError);
  assert.ok(JSON.stringify(db.prepare("SELECT id,username,password FROM users ORDER BY id").all()) === JSON.stringify(before),
    "Repeat seeding must preserve all identities and password hashes");
});

test("seed refuses missing schema, invalid time, caller transaction and foreign key bypass without creating records", async (t) => {
  const db = memory(); t.after(() => db.close());
  await assert.rejects(seedDemo(db), DemoSeedError);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table'").get() as { n: number }).n, 0);
  migrateDatabase(db);
  await assert.rejects(seedDemo(db, { now: "2026-02-30T00:00:00.000Z" }), DemoSeedError);
  db.exec("BEGIN IMMEDIATE");
  await assert.rejects(seedDemo(db), DemoSeedError);
  assert.equal(db.inTransaction, true); db.exec("ROLLBACK");
  db.pragma("foreign_keys = OFF"); await assert.rejects(seedDemo(db), DemoSeedError);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n, 0);
});

test("seed refuses an unexpected table before provisioning any identity", async (t) => {
  const db = memory(); t.after(() => db.close()); migrateDatabase(db);
  db.exec("CREATE TABLE unexpected_demo_input(value TEXT)");
  await assert.rejects(seedDemo(db), DemoSeedError);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n, 0);
});

test("a provisioning failure rolls back previously inserted synthetic identities and grants", async (t) => {
  const db = memory(); t.after(() => db.close()); migrateDatabase(db);
  db.exec(`CREATE TRIGGER synthetic_provisioning_failure BEFORE INSERT ON users
    WHEN NEW.username='SYNTHETIC DEMO denied' BEGIN SELECT RAISE(ABORT,'Synthetic test failure'); END`);
  await assert.rejects(seedDemo(db, { now: NOW }), DemoSeedError);
  assert.equal(db.inTransaction, false);
  for (const table of ["users", "permissions", "admin_user_permissions", "tasks"]) {
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get() as { n: number }).n, 0);
  }
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});
