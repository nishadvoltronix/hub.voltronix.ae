import assert from "node:assert/strict";
import test from "node:test";
import { mysqlMigrations } from "../src/crm/db/mysql/migrations.js";
import { mysqlMigrations as authenticationMigrations } from "../src/db/mysql/migrations.js";
import { mysqlApplicationSchemaStatements, mysqlExpectedTables, mysqlExpectedTriggers } from "../src/crm/db/mysql/schema.js";
import { mysqlDepartmentAttachmentSchemaStatements, mysqlLocalWorkflowSchemaStatements } from "../src/crm/db/mysql/workflow-schema.js";
import { mysqlInboundSchemaStatements } from "../src/crm/db/mysql/inbound-schema.js";

test("OFFLINE CRM target migrations extend the unchanged authentication foundation with explicit local workflows", () => {
  assert.deepEqual(mysqlMigrations.slice(0, 1), authenticationMigrations);
  assert.equal(mysqlMigrations[0].checksum, "766fcdc418218d76eab9051dbeac4165046a117bf8e758ca7f6ca819160afa11");
  assert.deepEqual(mysqlMigrations.map(migration => migration.version), [1, 2, 3, 4, 5]);
  assert.equal(mysqlMigrations[0].statements, mysqlApplicationSchemaStatements);
  assert.equal(mysqlExpectedTables.length, 41);
  assert.equal(mysqlApplicationSchemaStatements.filter(statement => /^CREATE TABLE /.test(statement)).length, 27);
  assert.equal(mysqlMigrations.flatMap(migration => migration.statements).filter(statement => /^CREATE TRIGGER /.test(statement)).length, mysqlExpectedTriggers.length);
});

test("OFFLINE migration seeds only the technical singleton and never adopts, deletes or imports CRM history", () => {
  const statements = mysqlMigrations.flatMap(migration => migration.statements);
  const mutations = statements.filter(statement => !/^CREATE (TABLE|TRIGGER|INDEX|UNIQUE INDEX) /.test(statement));
  assert.deepEqual(mutations, ["INSERT INTO crm_app_lock(id) VALUES (1)", mysqlDepartmentAttachmentSchemaStatements[0],...mysqlInboundSchemaStatements.slice(0,3)]);
  assert.ok(statements.every(statement => !/^\s*(?:DROP|TRUNCATE|LOAD DATA)\b|^CREATE (?:TABLE|TRIGGER) IF NOT EXISTS\b/i.test(statement)));
});

test("OFFLINE schema ordering creates every referenced parent before its dependent table", () => {
  const created = new Set<string>();
  for (const statement of mysqlMigrations.flatMap(migration => migration.statements)) {
    const name = /^CREATE TABLE ([a-z_]+)\s/.exec(statement)?.[1];
    if (!name) continue;
    created.add(name);
    for (const match of statement.matchAll(/REFERENCES ([a-z_]+)\s*\(/g)) assert.ok(created.has(match[1]!), "Referenced table was not created first");
  }
  assert.equal(created.size, mysqlExpectedTables.length);
});

test("OFFLINE MySQL provenance has immediate composite foreign keys and immutable receipts without adopting history", () => {
  const schema = mysqlLocalWorkflowSchemaStatements.join("\n");
  for (const name of ["crm_local_tasks", "crm_local_operations", "crm_local_audit"]) {
    assert.match(schema, new RegExp(`CREATE TRIGGER ${name}_no_update BEFORE UPDATE ON ${name}`));
    assert.match(schema, new RegExp(`CREATE TRIGGER ${name}_no_delete BEFORE DELETE ON ${name}`));
  }
  assert.match(schema, /REFERENCES crm_local_operations\(operation_id,task_id,actor_user_id\) ON DELETE RESTRICT/u);
  assert.match(schema, /CHECK \(state='completed'\)/u);
  assert.match(schema, /CHECK \(remote_effect_possible=0\)/u);
  assert.match(schema, /calculation_policy='percentage-only-v2'/u);
  assert.match(schema, /NOT \(NEW\.issuer_company <=> OLD\.issuer_company\)/u);
  assert.match(schema, /Historical quotation requires explicit reconciliation/u);
  assert.doesNotMatch(schema, /\b(?:INSERT INTO|UPDATE crm_quotations|DELETE FROM|DEFERRABLE|CASCADE)\b/u);
});

test("OFFLINE department upgrade retains author and byte checks and distinguishes PM's smaller limit", () => {
  const schema = mysqlDepartmentAttachmentSchemaStatements.join("\n");
  assert.match(schema, /MODIFY content LONGBLOB NOT NULL/u);
  assert.match(schema, /CHECK \(file_size > 0 AND file_size <= 52428800\)/u);
  for (const name of ["Electrical", "Civil", "Switchgear", "Maintenance"]) assert.match(schema, new RegExp(`WHEN '${name}' THEN 52428800`));
  assert.match(schema, /ELSE 16384000 END/u);
  assert.doesNotMatch(schema, /DROP (?:TRIGGER|TABLE)|DROP CHECK crm_department_log_attachments_chk_2/u);
});
