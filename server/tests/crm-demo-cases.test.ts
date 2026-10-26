import assert from "node:assert/strict";
import test from "node:test";
import type { MysqlWireConnection } from "../src/crm/db/mysql/driver.js";
import { mysqlExpectedTables } from "../src/crm/db/mysql/schema.js";
import { createCrmDemoFixture, consumeCrmDemo, CrmDemoCaseError, getCrmDemoAccess, verifyCrmDemoFixture, type CrmDemoFixture } from "../scripts/crm-demo/fixture.js";
import { runCrmDemoCases } from "../scripts/crm-demo/cases.js";
import { calculateSavedQuotation, parseSavedQuotationInput } from "../src/crm/commercial/quotations.js";

// Fake wire only: these tests perform no SQL, files, sockets or fixture provisioning.
const fixtureId = "ca49a11a-8065-4a61-a56c-7967ec642f9a", database = `crm_local_crm_${fixtureId.replaceAll("-", "")}`;
function wire(options: { target?: string; nonempty?: string; rejectBegin?: boolean; rejectCommit?: boolean; rejectInsert?: boolean; warning?: boolean } = {}) {
  const calls: { sql: string; values: readonly unknown[] }[] = [], lifecycle: string[] = [];
  const users = new Map<string, { role: string; username: unknown; email: unknown }>(), tasks = new Map<string, { notes: unknown }>();
  let nextId = 0;
  const connection: MysqlWireConnection = {
    async execute(sql, values = []) {
      calls.push({ sql, values });
      if (sql === "SELECT DATABASE() AS selected_database") return [[{ selected_database: options.target ?? database }], []];
      if (sql === "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE") return [[{ id: 1 }], []];
      if (sql.startsWith("SELECT COUNT(*) AS total FROM")) {
        const technical = sql.includes("`crm_app_lock`"); return [[{ total: technical || (options.nonempty && sql.includes(`\`${options.nonempty}\``)) ? 1 : 0 }], []];
      }
      if (sql.startsWith("SELECT role,username,email FROM users")) return [[users.get(String(values[0]))].filter(Boolean), []];
      if (sql.startsWith("SELECT notes FROM tasks")) return [[tasks.get(String(values[0]))].filter(Boolean), []];
      if (!sql.startsWith("INSERT INTO")) throw new Error("Unexpected synthetic fixture statement");
      if (options.rejectInsert) throw new Error("Synthetic driver detail must stay private");
      assert.equal((sql.match(/\?/g) ?? []).length, values.length, "prepared parameter arity");
      const id = String(++nextId);
      if (sql.startsWith("INSERT INTO users")) {
        assert.equal(typeof values[3] === "string" && /^\$2[aby]\$12\$/.test(values[3]), true, "approved bcrypt cost");
        assert.equal(sql.includes("'fixture-nonadmin'"), true);
        users.set(id, { role: "fixture-nonadmin", username: values[1], email: values[2] });
      }
      if (sql.startsWith("INSERT INTO tasks")) tasks.set(id, { notes: values[9] });
      return [{ affectedRows: 1, insertId: id, warningStatus: options.warning ? 1 : 0 }, []];
    },
    async query() { throw new Error("No ad hoc SQL accepted in fixture double"); },
    async beginTransaction() { lifecycle.push("BEGIN"); if (options.rejectBegin) throw new Error("Synthetic private begin detail"); },
    async commit() { lifecycle.push("COMMIT"); if (options.rejectCommit) throw new Error("Synthetic uncertain commit"); },
    async rollback() { lifecycle.push("ROLLBACK"); }, async end() { lifecycle.push("END"); }, destroy() { lifecycle.push("DESTROY"); },
  };
  return { connection, calls, lifecycle, users, tasks };
}

test("OFFLINE CRM demo fixtures use guarded empty schema, parameterized synthetic rows, bcrypt and retained ownership", async () => {
  const f = wire(), fixture = await createCrmDemoFixture(f.connection, fixtureId);
  assert.equal(fixture.database, database); assert.equal(f.users.size, 5); assert.equal(f.tasks.size, 3);
  assert.equal(f.calls.filter(value => value.sql.startsWith("SELECT COUNT(*) AS total FROM")).length, mysqlExpectedTables.length);
  for (const statement of f.calls.filter(value => value.sql.startsWith("INSERT INTO tasks"))) {
    assert.equal(statement.values[16], statement.values[3] === "Proposal/Price Quote" ? "250.25" : "100.10", "task amount matches the exact quotation subtotal");
  }
  for (const statement of f.calls.filter(value => value.sql.startsWith("INSERT INTO crm_quotations"))) {
    const header = JSON.parse(String(statement.values[3]));
    assert.equal(header.discountType, undefined, "synthetic historical fixture must not be relabeled with current percentage metadata");
    const input = parseSavedQuotationInput({ ...header, items: [{ productId: fixture.productId, productName: "TEST ONLY isolated panel",
      description: fixture.marker, quantity: "2.5", unitPrice: "100.10", itemDiscount: "0", uom: "NOS" }] }, "percentage-create-v1");
    assert.deepEqual(JSON.parse(String(statement.values[4])), calculateSavedQuotation(input, "percentage-create-v1"));
  }
  assert.equal(f.calls.some(value => /^(?:CREATE|DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/.test(value.sql)), false);
  assert.deepEqual(f.lifecycle, ["BEGIN", "COMMIT"]);
  assert.equal(fixture.password.length >= 32, true);
  await verifyCrmDemoFixture(f.connection, fixture);
  consumeCrmDemo(fixture, "cases"); assert.throws(() => consumeCrmDemo(fixture, "cases"), CrmDemoCaseError);
  consumeCrmDemo(fixture, "http"); assert.throws(() => consumeCrmDemo(fixture, "http"), CrmDemoCaseError);
  consumeCrmDemo(fixture, "chromium"); assert.throws(() => consumeCrmDemo(fixture, "chromium"), CrmDemoCaseError);
});
test("OFFLINE CRM demo rejects existing application target before a transaction or insert", async () => {
  const f = wire({ target: "crm_local_dev" });
  await assert.rejects(createCrmDemoFixture(f.connection, fixtureId), CrmDemoCaseError);
  assert.equal(f.lifecycle.length, 0); assert.equal(f.calls.some(value => value.sql.startsWith("INSERT")), false);
  await assert.rejects(createCrmDemoFixture(f.connection, "../untrusted"), CrmDemoCaseError);
  assert.equal(f.calls.length, 1);
});
test("OFFLINE private demo handoff requires original immutable ownership and every requested phase", async () => {
  const f = wire(), fixture = await createCrmDemoFixture(f.connection, fixtureId);
  const sqlCount = f.calls.length;
  assert.throws(() => getCrmDemoAccess({ ...fixture }, false), CrmDemoCaseError);
  assert.throws(() => getCrmDemoAccess(fixture, false), CrmDemoCaseError);
  consumeCrmDemo(fixture, "cases");
  assert.throws(() => getCrmDemoAccess(fixture, false), CrmDemoCaseError);
  consumeCrmDemo(fixture, "http");
  assert.throws(() => getCrmDemoAccess(fixture, true), CrmDemoCaseError);
  const access = getCrmDemoAccess(fixture, false);
  assert.equal(access.email === fixture.identities.operator.email && access.password === fixture.password, true);
  assert.equal(access.database, database); assert.equal(access.fixtureId, fixtureId); assert.equal(Object.isFrozen(access), true);
  consumeCrmDemo(fixture, "chromium");
  assert.equal(getCrmDemoAccess(fixture, true).marker, fixture.marker);
  assert.equal(f.calls.length, sqlCount, "handoff capability performs no database operation");
});
test("OFFLINE CRM demo refuses any pre-existing business rows and never resets them", async () => {
  const f = wire({ nonempty: "tasks" });
  await assert.rejects(createCrmDemoFixture(f.connection, fixtureId), CrmDemoCaseError);
  assert.deepEqual(f.lifecycle, ["BEGIN", "ROLLBACK"]);
  assert.equal(f.calls.some(value => /^(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/.test(value.sql)), false);
});
test("OFFLINE fixture DML failures and warnings rollback without exposing driver details", async () => {
  for (const options of [{ rejectInsert: true }, { warning: true }]) {
    const f = wire(options);
    await assert.rejects(createCrmDemoFixture(f.connection, fixtureId), error => error instanceof CrmDemoCaseError && !error.message.includes("driver"));
    assert.deepEqual(f.lifecycle, ["BEGIN", "ROLLBACK"]);
  }
});
test("OFFLINE uncertain fixture commit destroys connection without retry or cleanup", async () => {
  const f = wire({ rejectCommit: true });
  await assert.rejects(createCrmDemoFixture(f.connection, fixtureId), CrmDemoCaseError);
  assert.deepEqual(f.lifecycle, ["BEGIN", "COMMIT", "DESTROY"]);
  assert.equal(f.calls.some(value => /^(?:DELETE|DROP|TRUNCATE)\b/.test(value.sql)), false);
});
test("OFFLINE uncertain fixture begin is redacted and closed before fixture DML", async () => {
  const f = wire({ rejectBegin: true });
  await assert.rejects(createCrmDemoFixture(f.connection, fixtureId), error => error instanceof CrmDemoCaseError && !error.message.includes("begin"));
  assert.deepEqual(f.lifecycle, ["BEGIN", "DESTROY"]);
  assert.equal(f.calls.some(value => value.sql.startsWith("INSERT")), false);
});
test("OFFLINE ownership capability rejects copied receipts and changed parent markers before runtime creation", async () => {
  const f = wire(), fixture = await createCrmDemoFixture(f.connection, fixtureId);
  let factories = 0;
  const copied = { ...fixture } as CrmDemoFixture;
  await assert.rejects(verifyCrmDemoFixture(f.connection, copied), CrmDemoCaseError);
  await assert.rejects(runCrmDemoCases({ fixture: copied, fixtureConnection: f.connection,
    createRuntime: () => { factories++; throw new Error("Must not construct"); }, record: () => {} }), CrmDemoCaseError);
  assert.equal(factories, 0);
  f.tasks.set(fixture.jobId, { notes: "unapproved rows" });
  await assert.rejects(verifyCrmDemoFixture(f.connection, fixture), CrmDemoCaseError);
});
