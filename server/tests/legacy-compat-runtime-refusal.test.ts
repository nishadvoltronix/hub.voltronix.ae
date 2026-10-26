import assert from "node:assert/strict";
import test from "node:test";
import { sourceContract } from "../scripts/legacy-compat/source-contract.js";
import { assertMysqlMigrationsCurrent, inspectMysqlApplicationSchema, MysqlMigrationError,
  type MysqlMigrationSession } from "../src/crm/db/mysql/migrations.js";

/** Synthetic source-name inventory only. These invented InnoDB metadata rows
 * are not recovered DDL. No connection, database file or migration is used. */
function legacyInventory(includeNativeLedger = false) {
  const schema = "synthetic_legacy_contract";
  const tables = sourceContract.map(entry => ({ name: entry.table, type: "BASE TABLE", engine: "InnoDB" }));
  if (includeNativeLedger) tables.push({ name: "crm_mysql_schema_migrations", type: "BASE TABLE", engine: "InnoDB" });
  const before = structuredClone(tables), statements: string[] = [];
  let unexpectedCalls = 0;
  const connection: MysqlMigrationSession = {
    async execute(sql, values = []) {
      statements.push(sql);
      assert.match(sql, /^SELECT /);
      if (sql.startsWith("SELECT DATABASE()")) return [[{ selectedDatabase: schema, serverVersion: "8.4.11",
        versionComment: "MySQL Community Server", autocommit: 1 }], []];
      assert.deepEqual(values, [schema]);
      if (sql.includes("FROM information_schema.TABLES")) return [structuredClone(tables), []];
      if (/FROM information_schema\.(?:TRIGGERS|ROUTINES|EVENTS)/.test(sql)) return [[], []];
      unexpectedCalls++;
      assert.fail("Native inspection must refuse the source-name inventory before reading application rows.");
    },
    async query(sql) {
      statements.push(sql);
      unexpectedCalls++;
      assert.fail("Readiness and inspection must not issue schema changes or business writes.");
    },
  };
  return { schema, tables, before, statements, connection, unexpectedCalls: () => unexpectedCalls };
}

test("OFFLINE all PHP-observed tables cannot satisfy the native CRM runtime schema guard", async () => {
  const fixture = legacyInventory();
  await assert.rejects(assertMysqlMigrationsCurrent(fixture.connection, fixture.schema), MysqlMigrationError);
  assert.equal(fixture.statements.length, 2);
  assert.equal(fixture.unexpectedCalls(), 0);
  assert.deepEqual(fixture.tables, fixture.before);
});

test("OFFLINE read-only native inspection refuses the existing PHP-name inventory without adopting it", async () => {
  const fixture = legacyInventory();
  await assert.rejects(inspectMysqlApplicationSchema(fixture.connection, fixture.schema), MysqlMigrationError);
  assert.equal(fixture.statements.length, 5);
  assert.equal(fixture.unexpectedCalls(), 0);
  assert.deepEqual(fixture.tables, fixture.before);
  assert.ok(fixture.statements.every(sql => /^SELECT /.test(sql)));
});

test("OFFLINE adding a native ledger name cannot turn PHP source-name coverage into runtime compatibility", async () => {
  const fixture = legacyInventory(true);
  await assert.rejects(assertMysqlMigrationsCurrent(fixture.connection, fixture.schema), MysqlMigrationError);
  assert.equal(fixture.statements.length, 2);
  assert.equal(fixture.unexpectedCalls(), 0);
  assert.deepEqual(fixture.tables, fixture.before);
  assert.ok(fixture.statements.every(sql => !sql.includes("FROM crm_mysql_schema_migrations")));
});
