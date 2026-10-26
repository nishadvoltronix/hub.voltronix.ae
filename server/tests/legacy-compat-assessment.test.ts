import assert from "node:assert/strict";
import { test } from "node:test";
import { assessLegacySchema, sharedDatabaseWork } from "../scripts/legacy-compat/assessment.js";
import { runLegacyInspection } from "../scripts/legacy-compat/command.js";
import { LegacyMetadataError, type LegacySchemaSnapshot } from "../scripts/legacy-compat/metadata.js";
import { sourceContract } from "../scripts/legacy-compat/source-contract.js";

/** Invented metadata solely for coverage tests. VARCHAR columns and first-column
 * primary keys below are NOT an assertion of legacy SQL types or real DDL. */
function syntheticSnapshot(): LegacySchemaSnapshot {
  return {
    format: "legacy-schema-metadata-v1", scope: "visible-structure-only", schemaSha256: "a".repeat(64),
    server: { family: "mysql-compatible", version: "8.0.41", lowerCaseTableNames: 0 },
    tables: sourceContract.map(entry => ({ name: entry.table, kind: "BASE TABLE", engine: "InnoDB", collation: "utf8mb4_general_ci" })),
    columns: sourceContract.flatMap(entry => entry.columns.map((name, index) => ({
      table: entry.table, name, ordinal: index + 1, dataType: "varchar", nullable: false, characterLength: 255,
      numericPrecision: null, numericScale: null, datetimePrecision: null, charset: "utf8mb4", collation: "utf8mb4_general_ci",
      unsigned: false, autoIncrement: false, generated: false,
    }))),
    indexes: sourceContract.map(entry => ({ table: entry.table, name: "PRIMARY", unique: true, sequence: 1,
      column: entry.columns[0]!, prefixLength: null, type: "BTREE" })),
  };
}

function tableReport(report: ReturnType<typeof assessLegacySchema>, table: string) {
  const result = report.tables.find(entry => entry.table === table);
  assert.ok(result, `Missing known-source report for ${table}`);
  return result;
}

function renameTable(snapshot: LegacySchemaSnapshot, previous: string, next: string) {
  for (const table of snapshot.tables) if (table.name === previous) table.name = next;
  for (const column of snapshot.columns) if (column.table === previous) column.table = next;
  for (const index of snapshot.indexes) if (index.table === previous) index.table = next;
}

test("OFFLINE full synthetic name coverage never becomes deployment or shared-write readiness", () => {
  const snapshot = syntheticSnapshot(), before = structuredClone(snapshot), report = assessLegacySchema(snapshot);
  assert.equal(report.status, "PREPARATION_ONLY");
  assert.equal(report.scope, "offline-source-name-coverage");
  assert.equal(report.deploymentReady, false);
  assert.equal(report.sharedDatabaseWritesEnabled, false);
  assert.equal(report.sourceEvidence.authoritativeDdl, false);
  assert.equal(report.sourceEvidence.runtimeCompatibilityVerified, false);
  assert.equal(report.coverage.referencedTables, sourceContract.length);
  assert.equal(report.coverage.observedReferencedTables, sourceContract.length);
  assert.equal(report.coverage.tablesWithAllReferencedNames, sourceContract.length);
  assert.equal(report.coverage.referencedColumns, snapshot.columns.length);
  assert.equal(report.coverage.observedReferencedColumns, snapshot.columns.length);
  assert.equal(report.coverage.structuralFindings, 0);
  assert.deepEqual(report.requiredWork, sharedDatabaseWork);
  for (const code of ["LEGACY_RUNTIME_ADAPTER", "CONCURRENT_WRITES", "IDENTITIES_AND_AUTHORIZATION",
    "SHARED_ATTACHMENT_STORAGE", "ZOHO_WRITER_OWNERSHIP", "ISOLATED_COEXISTENCE_ACCEPTANCE"]) {
    assert.ok(report.requiredWork.some(work => work.code === code));
  }
  assert.match(report.conclusion, /not schema, data, workflow or concurrent-write compatibility/);
  assert.deepEqual(snapshot, before);
});

test("OFFLINE primary-key spelling matches metadata validator case handling", () => {
  const snapshot = syntheticSnapshot();
  for (const index of snapshot.indexes) index.name = "Primary";
  const result = assessLegacySchema(snapshot);
  assert.equal(result.coverage.structuralFindings, 0);
  assert.equal(result.deploymentReady, false);
});

test("OFFLINE assess command returns exit two for a full synthetic snapshot, never production success", () => {
  const snapshot = syntheticSnapshot();
  let reads = 0;
  const result = runLegacyInspection(["assess"], () => { reads++; return snapshot; });
  assert.equal(reads, 1);
  assert.equal(result.exitCode, 2);
  const expected = assessLegacySchema(snapshot);
  assert.deepEqual(result.output, expected);
  assert.equal(expected.deploymentReady, false);
  assert.equal(expected.sharedDatabaseWritesEnabled, false);
  assert.equal(expected.coverage.structuralFindings, 0);
});

test("OFFLINE missing tables report known source names without pretending columns were inspected", () => {
  const snapshot = syntheticSnapshot();
  snapshot.tables = snapshot.tables.filter(table => table.name !== "tasks");
  snapshot.columns = snapshot.columns.filter(column => column.table !== "tasks");
  snapshot.indexes = snapshot.indexes.filter(index => index.table !== "tasks");
  const report = assessLegacySchema(snapshot), tasks = tableReport(report, "tasks");
  assert.equal(tasks.observed, false);
  assert.equal(tasks.observedReferencedColumnCount, 0);
  assert.deepEqual(tasks.findings, ["TABLE_NOT_OBSERVED"]);
  assert.deepEqual(tasks.missingColumns, sourceContract.find(entry => entry.table === "tasks")!.columns);
  assert.equal(report.coverage.observedReferencedTables, sourceContract.length - 1);
  assert.equal(report.coverage.structuralFindings, 1);
});

test("OFFLINE missing referenced columns reduce coverage and retain precise known identifiers", () => {
  const snapshot = syntheticSnapshot();
  snapshot.columns = snapshot.columns.filter(column => !(column.table === "tasks" && column.name === "subject"));
  let ordinal = 0;
  for (const column of snapshot.columns) if (column.table === "tasks") column.ordinal = ++ordinal;
  const report = assessLegacySchema(snapshot), tasks = tableReport(report, "tasks");
  assert.equal(tasks.observed, true);
  assert.deepEqual(tasks.missingColumns, ["subject"]);
  assert.deepEqual(tasks.findings, ["REFERENCED_COLUMNS_NOT_OBSERVED"]);
  assert.equal(tasks.observedReferencedColumnCount, tasks.referencedColumnCount - 1);
  assert.equal(report.coverage.tablesWithAllReferencedNames, sourceContract.length - 1);
  assert.equal(report.coverage.observedReferencedColumns, report.coverage.referencedColumns - 1);
});

test("OFFLINE lower_case_table_names zero reports case mismatch instead of adopting another table", () => {
  const snapshot = syntheticSnapshot();
  renameTable(snapshot, "users", "USERS");
  const report = assessLegacySchema(snapshot), users = tableReport(report, "users");
  assert.equal(users.observed, false);
  assert.deepEqual(users.findings, ["TABLE_CASE_MISMATCH"]);
  assert.equal(users.observedReferencedColumnCount, 0);
  assert.equal(report.coverage.observedReferencedTables, sourceContract.length - 1);
  assert.ok(!JSON.stringify(report).includes('"USERS"'));
});

test("OFFLINE case modes one and two match table names and columns case-insensitively", () => {
  for (const caseMode of [1, 2] as const) {
    const snapshot = syntheticSnapshot();
    snapshot.server.lowerCaseTableNames = caseMode;
    for (const entry of sourceContract) renameTable(snapshot, entry.table, entry.table.toUpperCase());
    for (const column of snapshot.columns) column.name = column.name.toLowerCase();
    const report = assessLegacySchema(snapshot);
    assert.equal(report.coverage.tablesWithAllReferencedNames, sourceContract.length);
    assert.equal(report.coverage.structuralFindings, 0);
    assert.equal(report.coverage.observedReferencedColumns, report.coverage.referencedColumns);
    assert.equal(report.sharedDatabaseWritesEnabled, false);
  }
});

test("OFFLINE case-sensitive duplicate spellings require collision review even with exact coverage", () => {
  const snapshot = syntheticSnapshot();
  snapshot.tables.push({ name: "USERS", kind: "BASE TABLE", engine: "InnoDB", collation: "utf8mb4_general_ci" });
  snapshot.columns.push({ ...snapshot.columns[0]!, table: "USERS", name: "id", ordinal: 1 });
  const report = assessLegacySchema(snapshot), users = tableReport(report, "users");
  assert.equal(users.observed, true);
  assert.deepEqual(users.missingColumns, []);
  assert.deepEqual(users.findings, ["TABLE_CASE_COLLISION"]);
  assert.equal(report.coverage.tablesWithAllReferencedNames, sourceContract.length);
  assert.equal(report.coverage.visibleTables, sourceContract.length + 1);
  assert.equal(report.deploymentReady, false);
  snapshot.server.lowerCaseTableNames = 1;
  assert.throws(() => assessLegacySchema(snapshot), LegacyMetadataError);
});

test("OFFLINE assessment never echoes unknown metadata table, column or index identifiers", () => {
  const snapshot = syntheticSnapshot();
  const unknownTable = "private_table_marker", unknownColumn = "private_column_marker", unknownIndex = "private_index_marker";
  snapshot.tables.push({ name: unknownTable, kind: "BASE TABLE", engine: "InnoDB", collation: "utf8mb4_general_ci" });
  snapshot.columns.push({ ...snapshot.columns[0]!, table: unknownTable, name: unknownColumn, ordinal: 1 });
  snapshot.indexes.push({ table: unknownTable, name: unknownIndex, unique: false, sequence: 1,
    column: unknownColumn, prefixLength: null, type: "BTREE" });
  const usersColumnCount = snapshot.columns.filter(column => column.table === "users").length;
  snapshot.columns.push({ ...snapshot.columns[0]!, table: "users", name: unknownColumn, ordinal: usersColumnCount + 1 });
  snapshot.indexes.push({ table: "users", name: unknownIndex, unique: false, sequence: 1,
    column: unknownColumn, prefixLength: null, type: "BTREE" });
  const report = assessLegacySchema(snapshot), serialized = JSON.stringify(report);
  for (const marker of [unknownTable, unknownColumn, unknownIndex]) assert.ok(!serialized.includes(marker));
  assert.deepEqual(report.tables.map(table => table.table), sourceContract.map(entry => entry.table));
  assert.equal(report.coverage.visibleTables, sourceContract.length + 1);
  assert.equal(report.coverage.structuralFindings, 0);
  assert.equal(report.coverage.observedReferencedColumns, report.coverage.referencedColumns);
});

test("OFFLINE views require review even when every referenced column name is present", () => {
  const snapshot = syntheticSnapshot(), tasks = snapshot.tables.find(table => table.name === "tasks")!;
  tasks.kind = "VIEW"; tasks.engine = null;
  snapshot.indexes = snapshot.indexes.filter(index => index.table !== "tasks");
  const report = assessLegacySchema(snapshot), result = tableReport(report, "tasks");
  assert.deepEqual(result.missingColumns, []);
  assert.deepEqual(result.findings, ["VIEW_REQUIRES_REVIEW", "ENGINE_REQUIRES_REVIEW", "PRIMARY_KEY_NOT_OBSERVED"]);
  assert.equal(report.deploymentReady, false);
});

test("OFFLINE non-InnoDB storage and absent primary keys have independent review findings", () => {
  const snapshot = syntheticSnapshot();
  snapshot.tables.find(table => table.name === "tasks")!.engine = "MyISAM";
  snapshot.indexes = snapshot.indexes.filter(index => index.table !== "users");
  const report = assessLegacySchema(snapshot);
  assert.deepEqual(tableReport(report, "tasks").findings, ["ENGINE_REQUIRES_REVIEW"]);
  assert.deepEqual(tableReport(report, "users").findings, ["PRIMARY_KEY_NOT_OBSERVED"]);
  assert.equal(report.coverage.structuralFindings, 2);
});

test("OFFLINE generated referenced columns and enum or set domains cannot silently pass", () => {
  for (const dataType of ["enum", "SET"]) {
    const snapshot = syntheticSnapshot();
    snapshot.columns.find(column => column.table === "users" && column.name === "username")!.generated = true;
    snapshot.columns.find(column => column.table === "users" && column.name === "status")!.dataType = dataType;
    const report = assessLegacySchema(snapshot);
    assert.deepEqual(tableReport(report, "users").findings, ["GENERATED_REFERENCED_COLUMN", "ENUM_DOMAIN_NOT_COLLECTED"]);
    assert.equal(report.coverage.tablesWithAllReferencedNames, sourceContract.length);
    assert.equal(report.sharedDatabaseWritesEnabled, false);
  }
});

test("OFFLINE unrelated extra generated or enum columns do not become referenced-column findings", () => {
  const snapshot = syntheticSnapshot();
  snapshot.columns.push({ ...snapshot.columns[0]!, table: "users", name: "extra_private_marker",
    ordinal: snapshot.columns.filter(column => column.table === "users").length + 1, generated: true, dataType: "enum" });
  const report = assessLegacySchema(snapshot);
  assert.deepEqual(tableReport(report, "users").findings, []);
  assert.ok(!JSON.stringify(report).includes("extra_private_marker"));
  assert.equal(report.deploymentReady, false);
});

test("OFFLINE expression-index metadata is flagged without exposing its identifier or inventing expression checks", () => {
  const snapshot = syntheticSnapshot();
  snapshot.indexes.push({ table: "tasks", name: "private_expression_marker", unique: false, sequence: 1,
    column: null, prefixLength: null, type: "BTREE" });
  const report = assessLegacySchema(snapshot);
  assert.deepEqual(tableReport(report, "tasks").findings, ["EXPRESSION_INDEX_NOT_COLLECTED"]);
  assert.ok(report.metadataLimitations.includes("expressions-not-collected"));
  assert.ok(!JSON.stringify(report).includes("private_expression_marker"));
});

test("OFFLINE invalid metadata fails closed before producing any compatibility report", () => {
  const snapshot = syntheticSnapshot();
  snapshot.columns[0]!.ordinal = 0;
  assert.throws(() => assessLegacySchema(snapshot), error => {
    assert.ok(error instanceof LegacyMetadataError);
    assert.match(error.message, /no schema adoption or change was performed/);
    return true;
  });
  assert.throws(() => assessLegacySchema({ ...syntheticSnapshot(), extraPrivateValue: "private_marker" }), error => {
    assert.ok(error instanceof LegacyMetadataError);
    assert.ok(!error.message.includes("private_marker"));
    return true;
  });
});
