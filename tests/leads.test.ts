import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { hashSync } from "bcryptjs";
import { createAuthService } from "./sqlite-reference/auth/service";
import { configureDatabase, openDatabase } from "./sqlite-reference/db/connection";
import { migrateDatabase, migrations } from "./sqlite-reference/db/migrations";
import { PIPELINE_STAGES } from "./sqlite-reference/leads/contracts";
import { createLeadsService, LeadsError } from "./sqlite-reference/leads/service";
import { filesystemFixture } from "./database-fixture";

// Synthetic fixtures only. There is no account, task, note or history seeding in the application.
const password = "Synthetic pipeline test password";
const fixtureHash = hashSync(password, 4);
function grant(db: Database.Database, id: number, key: string) {
  db.prepare('INSERT INTO permissions("key",label) VALUES(?,?) ON CONFLICT("key") DO NOTHING').run(key, key);
  db.prepare('INSERT INTO admin_user_permissions(admin_user_id,permission_id) SELECT ?,id FROM permissions WHERE "key"=?').run(id, key);
}
async function fixture(t: TestContext, database?: Database.Database) {
  const db = database ?? new Database(":memory:");
  configureDatabase(db); migrateDatabase(db);
  if (!database) t.after(() => db.close());
  for (let id = 1; id <= 7; id++) db.prepare(`INSERT INTO users(id,user_id,username,email,password,status,role)
    VALUES(?,?,?,?,?,'active','admin')`).run(id, id === 6 ? null : `external-${id}`,
      `Synthetic Agent ${id}`, `pipeline-${id}@example.invalid`, fixtureHash);
  grant(db, 1, "leads.view");
  grant(db, 2, "leads.manage.agents"); grant(db, 2, "leads.view");
  grant(db, 3, "electrical.manage");
  grant(db, 4, "leads.manage");
  grant(db, 6, "leads.manage.agents");
  grant(db, 7, "leads.view");
  const auth = createAuthService(db), tokens: string[] = [];
  for (let id = 1; id <= 7; id++) tokens.push((await auth.login(`pipeline-${id}@example.invalid`, password, "fixture")).sessionToken);
  let nextId = 1;
  const insert = db.prepare(`INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_name,status,account_name,
    service_charge,qual_deal_number,site_deal_number,quote_deal_number,job_deal_number,lost_deal_number,created_at)
    VALUES(?,?,?,?,?,'Synthetic account','100.00000001',?,?,?,?,?,'2026-10-01 08:00:00')`);
  for (const stage of PIPELINE_STAGES) for (const status of stage.statuses) {
    const id = nextId++;
    insert.run(id, `deal-${id}`, "external-2", `Synthetic ${status}`, status, `QUAL-${id}`, `SITE-${id}`, `QUOTE-${id}`, `JOB-${id}`, `LOST-${id}`);
  }
  insert.run(nextId++, "deal-other", "external-1", "Synthetic unknown stage", "Proposal Omitted", "QUAL-X", "SITE-X", "QUOTE-X", "JOB-X", "LOST-X");
  insert.run(nextId++, "deal-unassigned", null, "Synthetic unassigned", "Qualification", "QUAL-Y", "SITE-Y", "QUOTE-Y", "JOB-Y", "LOST-Y");
  insert.run(nextId, "deal-foreign", "external-7", "Synthetic other owner", "Site Visit", "QUAL-Z", "SITE-Z", "QUOTE-Z", "JOB-Z", "LOST-Z");
  return { db, auth, service: createLeadsService(db), broad: tokens[0]!, agent: tokens[1]!, department: tokens[2]!,
    manageOnly: tokens[3]!, denied: tokens[4]!, unlinked: tokens[5]!, other: tokens[6]! };
}
function status(expected: number) { return (error: unknown) => error instanceof LeadsError && error.status === expected; }

test("pipeline classifies every source alias, preserves unknown stages and returns exact decimal text", async (t) => {
  const f = await fixture(t), result = f.service.listPipeline(f.broad);
  assert.equal(result.scope, "all");
  assert.deepEqual(result.counts, { qualification: 3, siteVisit: 2, proposal: 2, won: 2, lost: 4, other: 1 });
  assert.equal(result.total, 14);
  assert.equal(result.items[0]!.id, "14");
  assert.equal(result.items[0]!.serviceCharge, "100.00000001");
  for (const stage of [...PIPELINE_STAGES.map(({ key }) => key), "other"] as const) {
    const filtered = f.service.listPipeline(f.broad, { stage });
    assert.equal(filtered.total, result.counts[stage]);
    assert.ok(filtered.items.every((row) => row.stage === stage));
    assert.deepEqual(filtered.counts, result.counts);
  }
  const won = f.service.listPipeline(f.broad, { stage: "won" });
  assert.ok(won.items.every((row) => row.displayNumber === `JOB-${row.id}`));
  assert.equal(f.service.listPipeline(f.broad, { stage: "other" }).items[0]!.status, "Proposal Omitted");
});

test("pipeline owner scope wins over broad permission and no external identity means no unassigned access", async (t) => {
  const f = await fixture(t), own = f.service.listPipeline(f.agent);
  assert.equal(own.scope, "own"); assert.equal(own.total, 11);
  assert.ok(own.items.every((row) => row.assignedExternalId === "external-2"));
  assert.equal(f.service.listPipeline(f.agent, { agentId: "external-7" }).total, 0);
  assert.equal(f.service.listPipeline(f.agent, { agentId: "unassigned" }).total, 0);
  assert.equal(f.service.listPipeline(f.unlinked).total, 0);
  assert.equal(f.service.listPipeline(f.broad, { scope: "own" }).total, 1);
  assert.equal(f.service.listPipeline(f.broad, { agentId: "unassigned" }).total, 1);
  assert.equal(f.service.listPipeline(f.broad, { agentId: "external-7" }).total, 1);
  assert.deepEqual(f.service.listAgents(f.agent).items, [{ externalId: "external-2", name: "Synthetic Agent 2" }]);
  assert.equal(f.service.listAgents(f.unlinked).total, 0);
  assert.equal(f.service.listAgents(f.broad).total, 3);
});

test("pipeline and selectors deny absent grants before malformed input and reload revocation/status", async (t) => {
  const f = await fixture(t);
  for (const token of [f.department, f.manageOnly, f.denied]) {
    assert.throws(() => f.service.listPipeline(token, { invalid: true }), status(403));
    assert.throws(() => f.service.listAgents(token, { page: -1 }), status(403));
  }
  assert.throws(() => f.service.listPipeline(null), status(401));
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=1").run();
  assert.throws(() => f.service.listPipeline(f.broad), status(403));
  f.db.prepare("UPDATE users SET status='inactive' WHERE id=2").run();
  assert.throws(() => f.service.listAgents(f.agent), status(401));
});

test("search is literal, stage-number based, bounded and deterministically paginated", async (t) => {
  const f = await fixture(t);
  f.db.prepare("UPDATE tasks SET account_name='Synthetic 100%_\\ account' WHERE id=1").run();
  assert.equal(f.service.listPipeline(f.broad, { query: "100%_\\" }).total, 1);
  assert.equal(f.service.listPipeline(f.broad, { query: "' OR 1=1 --" }).total, 0);
  assert.equal(f.service.listPipeline(f.broad, { query: "JOB-6" }).total, 1);
  assert.equal(f.service.listPipeline(f.broad, { query: "QUAL-6" }).total, 0);
  assert.equal(f.service.listPipeline(f.broad, { query: "SYNTHETIC AGENT 7" }).total, 1);
  const first = f.service.listPipeline(f.broad, { pageSize: 2 }), second = f.service.listPipeline(f.broad, { page: 2, pageSize: 2 });
  assert.deepEqual(first.items.map(({ id }) => id), ["14", "13"]);
  assert.deepEqual(second.items.map(({ id }) => id), ["12", "11"]);
  assert.equal(f.service.listPipeline(f.broad, { page: 100 }).items.length, 0);
  assert.equal(f.service.listAgents(f.broad, { query: "Agent 2", pageSize: 1 }).total, 1);
  for (const input of [{ page: 0 }, { page: 1.5 }, { page: 1_000_001 }, { pageSize: 101 }, { pageSize: 0 },
    { scope: "all" }, { stage: "Closed Won" }, { agentId: "" }, { agentId: "a\0b" }, { query: "a\0b" }, { query: "x".repeat(121) }, { extra: true }]) {
    assert.throws(() => f.service.listPipeline(f.broad, input), status(400));
  }
});

test("full lead detail exposes persisted core fields only with record ownership and lossless identifiers", async (t) => {
  const f = await fixture(t);
  const big = "9007199254740993";
  f.db.prepare(`INSERT INTO tasks(id,zoho_crm_id,assigned_to,deal_crm_created_by,deal_name,status,
    customer_name,customer_email,customer_contact,address,complaint_info,notes,assign_notes,
    quote_number,owner_id,enq_deal_date,quote_deal_date,Job_Status)
    VALUES(?,?,'external-2',2,'Synthetic large ID','Qualification','Fixture Contact','contact@example.invalid',
    'Fixture phone','Fixture address','<script>fixture text</script>','Stored note','Stored assignment note',
    'quote-external','owner-external','2026-10-01 08:00:00','2026-10-02 08:00:00','Hold')`).run(big, `zoho-${big}`);
  const detail = f.service.getLead(f.agent, big);
  assert.equal(detail.id, big); assert.equal(detail.externalId, `zoho-${big}`);
  assert.equal(detail.createdByLocalId, "2"); assert.equal(detail.customerName, "Fixture Contact");
  assert.equal(detail.description, "<script>fixture text</script>"); assert.equal(detail.quoteId, "quote-external");
  assert.equal(detail.jobStatus, "Hold"); assert.equal(detail.assignmentNotes, "Stored assignment note");
  assert.equal(Object.hasOwn(detail, "password"), false); assert.equal(Object.hasOwn(detail, "filePath"), false);
  assert.throws(() => f.service.getLead(f.agent, "14"), status(404));
  assert.throws(() => f.service.getLead(f.unlinked, "13"), status(404));
  assert.throws(() => f.service.getLead(f.denied, big), status(404));
  for (const id of ["missing", "0", "01", "9223372036854775808", big + " OR 1=1", 1, "999999"]) {
    assert.throws(() => f.service.getLead(f.broad, id), status(404));
  }
});

test("department detail access uses latest local assignment and matching grant, not previous assignment", async (t) => {
  const f = await fixture(t);
  const assign = f.db.prepare("INSERT INTO departments_assign(task_id,user_id,department) VALUES(?,?,?)");
  assign.run(1, 3, "Electrical");
  assert.equal(f.service.getLead(f.department, "1").id, "1");
  assign.run(1, 4, "Electrical");
  assert.throws(() => f.service.getLead(f.department, "1"), status(404));
  assign.run(2, 3, "Civil");
  assert.throws(() => f.service.getLead(f.department, "2"), status(404));
  assign.run(2, 3, "Electrical");
  f.db.prepare("DELETE FROM admin_user_permissions WHERE admin_user_id=3").run();
  assert.throws(() => f.service.getLead(f.department, "2"), status(404));
});

test("notes and status history page actual parent records without leaking other tasks or creating history", async (t) => {
  const f = await fixture(t);
  const note = f.db.prepare("INSERT INTO job_notes(deal_id,note_title,note_content,zoho_note_id) VALUES(?,?,?,?)");
  note.run("deal-1", "Synthetic first", "Synthetic body one", "external-note-1");
  note.run("deal-1", "Synthetic second", "<b>Synthetic body two</b>", "external-note-2");
  note.run("deal-foreign", "Synthetic foreign", "Must not leak", "external-note-3");
  f.db.prepare("INSERT INTO tasks_status_log(Task_ID,User_ID,Status) VALUES(1,2,'Site Visit'),(1,NULL,'Proposal'),(14,7,'Closed Won')").run();
  const notes = f.service.listNotes(f.agent, "1", { pageSize: 1 });
  assert.equal(notes.total, 2); assert.equal(notes.items[0]!.title, "Synthetic second");
  assert.equal(f.service.listNotes(f.agent, "1", { page: 2, pageSize: 1 }).items[0]!.id, "1");
  const history = f.service.listStatusHistory(f.agent, "1", { pageSize: 1 });
  assert.equal(history.total, 2); assert.equal(history.items[0]!.actorId, null);
  assert.equal(f.service.listStatusHistory(f.agent, "1", { page: 2, pageSize: 1 }).items[0]!.actorId, "2");
  for (const read of [f.service.listNotes, f.service.listStatusHistory]) {
    assert.throws(() => read(f.agent, "14"), status(404));
    assert.throws(() => read(null, "1"), status(401));
    assert.throws(() => read(f.agent, "1", { pageSize: 101 }), status(400));
    assert.equal(read(f.broad, "13").total, 0);
  }
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM crm_audit_events").get() as { n: number }).n, 0);
  assert.throws(() => note.run("nonexistent-deal", "Title", "Body", null), /FOREIGN KEY/);
  assert.throws(() => f.db.prepare("INSERT INTO tasks_status_log(Task_ID,Status) VALUES(99999,'Qualification')").run(), /FOREIGN KEY/);
});

test("read failures are sanitized and cannot expose SQLite schema or record content", async (t) => {
  const f = await fixture(t);
  f.db.exec("DROP TABLE job_notes");
  assert.throws(() => f.service.listNotes(f.agent, "1"), (error) =>
    error instanceof LeadsError && error.status === 503 && error.message === "Leads are temporarily unavailable.");
});

test("source-backed read migration preserves populated version-2 records and creates no notes or status events", () => {
  const db = new Database(":memory:"); configureDatabase(db);
  try {
    db.exec(`CREATE TABLE crm_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT`);
    for (const migration of migrations.slice(0, 2)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO crm_schema_migrations(version,name,checksum) VALUES(?,?,?)")
        .run(migration.version, migration.name, createHash("sha256").update(migration.sql).digest("hex"));
    }
    db.prepare("INSERT INTO tasks(id,deal_name,status) VALUES(42,'Synthetic retained lead','Qualification')").run();
    assert.equal(migrateDatabase(db), migrations.length - 2);
    assert.deepEqual(db.prepare("SELECT CAST(id AS TEXT) AS id,deal_name,status,account_name,service_charge FROM tasks").get(),
      { id: "42", deal_name: "Synthetic retained lead", status: "Qualification", account_name: null, service_charge: null });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM job_notes").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tasks_status_log").get() as { n: number }).n, 0);
    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally { db.close(); }
});

test("persisted reads reload ownership changes committed by a second SQLite connection", async (t) => {
  const storage = filesystemFixture(), first = openDatabase(storage.config, { create: true });
  let second: Database.Database | undefined;
  try {
    const f = await fixture(t, first);
    second = openDatabase(storage.config);
    assert.equal(f.service.getLead(f.agent, "1").id, "1");
    second.prepare("UPDATE tasks SET assigned_to='external-7' WHERE id=1").run();
    assert.throws(() => f.service.getLead(f.agent, "1"), status(404));
    assert.equal(f.service.listPipeline(f.agent).total, 10);
    assert.equal(f.service.listPipeline(f.broad, { agentId: "external-7" }).total, 2);
  } finally { second?.close(); first.close(); storage.cleanup(); }
});
