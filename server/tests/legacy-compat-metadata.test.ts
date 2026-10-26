import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectLegacySchemaMetadata, LegacyMetadataError, legacyMetadataLimits, legacyMetadataLimitations,
  legacyMetadataQueries, validateLegacySchemaSnapshot, type LegacyMetadataPort } from "../scripts/legacy-compat/metadata.js";

const schema = "fixture_legacy";
const table = { name: "tasks", kind: "BASE TABLE", engine: "InnoDB", collation: "utf8mb4_general_ci" };
const column = { table: "tasks", name: "id", ordinal: 1, dataType: "bigint", nullable: "NO", characterLength: null,
  numericPrecision: 20, numericScale: 0, datetimePrecision: null, charset: null, collation: null,
  unsigned: 1, autoIncrement: 1, generated: 0 };
const index = { table: "tasks", name: "PRIMARY", nonUnique: 0, sequence: 1, column: "id", prefixLength: null, type: "BTREE" };
function fixture() {
  return [[{ version: "8.0.41-0ubuntu0.22.04.1", lowerCaseTableNames: 0, selectedDatabase: schema }],
    [{ ...table }], [{ ...column }], [{ ...index }]] as unknown[][];
}
function port(rows = fixture()) {
  const calls: { sql: string; values: readonly string[] }[] = [];
  const adapter: LegacyMetadataPort = { async query(sql, values) {
    calls.push({ sql, values }); return rows[calls.length - 1]!;
  } };
  return { calls, adapter };
}
function redacted(error: unknown): boolean {
  assert.ok(error instanceof LegacyMetadataError);
  assert.equal(error.message, "Legacy schema metadata is unavailable or invalid; no schema adoption or change was performed.");
  assert.doesNotMatch(error.stack ?? "", /synthetic-secret|fixture_legacy|unexpected-private-marker/);
  assert.equal(error.cause, undefined);
  return true;
}

test("OFFLINE legacy metadata uses only four fixed metadata SELECTs with parameterized schema", async () => {
  const fake = port(), snapshot = await collectLegacySchemaMetadata(fake.adapter, { schema });
  assert.deepEqual(fake.calls.map(call => call.sql), Object.values(legacyMetadataQueries));
  assert.deepEqual(fake.calls.map(call => call.values), [[], [schema], [schema], [schema]]);
  for (const { sql } of fake.calls) {
    assert.match(sql, /^SELECT /);
    assert.ok(!sql.includes(schema));
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|SET|SHOW|CALL|TABLE_ROWS|COLUMN_DEFAULT|COLUMN_COMMENT|TABLE_COMMENT|GENERATION_EXPRESSION|ROUTINE_DEFINITION|TRIGGER_BODY|CURRENT_USER)\b/i);
  }
  assert.match(fake.calls[0]!.sql, /DATABASE\(\) AS `selectedDatabase`/);
  for (const { sql } of fake.calls.slice(1)) assert.match(sql, /FROM INFORMATION_SCHEMA\.(?:TABLES|COLUMNS|STATISTICS) WHERE TABLE_SCHEMA=\?/);
  assert.equal(snapshot.format, "legacy-schema-metadata-v1");
  assert.equal(snapshot.scope, "visible-structure-only");
  assert.equal(snapshot.schemaSha256, createHash("sha256").update(schema).digest("hex"));
  assert.deepEqual(snapshot.server, { family: "mysql-compatible", version: "8.0.41", lowerCaseTableNames: 0 });
  assert.equal(snapshot.columns[0]!.autoIncrement, true);
  assert.equal(snapshot.columns[0]!.nullable, false);
  assert.equal(snapshot.indexes[0]!.unique, true);
  assert.ok(!JSON.stringify(snapshot).includes(schema));
  assert.ok(!JSON.stringify(snapshot).includes("ubuntu"));
  assert.ok(legacyMetadataLimitations.includes("foreign-keys-not-collected"));
  assert.ok(legacyMetadataLimitations.includes("triggers-not-collected"));
  assert.ok(legacyMetadataLimitations.includes("check-constraints-not-collected"));
});

test("OFFLINE metadata projections quote every alias and reduce generated markers without expressions", () => {
  for (const sql of Object.values(legacyMetadataQueries)) {
    for (const alias of sql.matchAll(/\bAS\s+([^,\s]+)/g)) assert.match(alias[1]!, /^`[A-Za-z][A-Za-z0-9]*`$/);
  }
  assert.match(legacyMetadataQueries.columns, /END AS `generated`/);
  assert.match(legacyMetadataQueries.indexes, /SEQ_IN_INDEX AS `sequence`/);
  assert.ok(legacyMetadataQueries.columns.includes("UPPER(EXTRA) REGEXP '(^| )(VIRTUAL|STORED|PERSISTENT)( |$)'"));
  for (const marker of ["VIRTUAL", "STORED", "PERSISTENT", "VIRTUAL GENERATED", "STORED GENERATED", "INVISIBLE VIRTUAL GENERATED"])
    assert.match(marker.toUpperCase(), /(^| )(VIRTUAL|STORED|PERSISTENT)( |$)/);
  for (const marker of ["DEFAULT_GENERATED", "auto_increment", "on update CURRENT_TIMESTAMP"])
    assert.doesNotMatch(marker.toUpperCase(), /(^| )(VIRTUAL|STORED|PERSISTENT)( |$)/);
  assert.doesNotMatch(legacyMetadataQueries.columns, /(?:EXTRA|COLUMN_TYPE) AS /);
});

test("OFFLINE legacy metadata normalizes MariaDB compatibility versions and numeric wire strings", async () => {
  const rows = fixture();
  rows[0] = [{ version: "5.5.5-10.11.7-MariaDB-1", lowerCaseTableNames: "1", selectedDatabase: schema }];
  rows[2] = [{ ...column, ordinal: "1", numericPrecision: "20", numericScale: "0", unsigned: "1", autoIncrement: "1", generated: "0" }];
  rows[3] = [{ ...index, nonUnique: "0", sequence: "1" }];
  const snapshot = await collectLegacySchemaMetadata(port(rows).adapter, { schema });
  assert.deepEqual(snapshot.server, { family: "mariadb", version: "10.11.7", lowerCaseTableNames: 1 });
  assert.equal(snapshot.columns[0]!.ordinal, 1);
  assert.equal(snapshot.columns[0]!.unsigned, true);
  assert.equal(snapshot.indexes[0]!.unique, true);
});

test("OFFLINE legacy metadata validates schema before any query and refuses system schemas", async () => {
  for (const input of [undefined, null, {}, { schema: "" }, { schema: "x; SELECT secret" }, { schema: "x.y" },
    { schema: "a".repeat(65) }, { schema: "mysql" }, { schema: "Information_Schema" }, { schema: "performance_schema" },
    { schema: "sys" }, { schema, password: "synthetic-secret" }]) {
    const fake = port();
    await assert.rejects(collectLegacySchemaMetadata(fake.adapter, input as { schema: string }), redacted);
    assert.equal(fake.calls.length, 0);
  }
});

test("OFFLINE legacy metadata binds the selected database and refuses malformed identity without exposing it", async () => {
  for (const identity of [[], [{ version: "8.0.41", lowerCaseTableNames: 0, selectedDatabase: "other_schema" }],
    [{ version: "8.0.41", lowerCaseTableNames: 0, selectedDatabase: null }],
    [{ version: "synthetic-secret", lowerCaseTableNames: 0, selectedDatabase: schema }],
    [{ version: "8.0.41", lowerCaseTableNames: 3, selectedDatabase: schema }],
    [{ version: "8.0.41", lowerCaseTableNames: 0, selectedDatabase: schema, currentUser: "synthetic-secret" }]]) {
    const rows = fixture(); rows[0] = identity;
    const fake = port(rows);
    await assert.rejects(collectLegacySchemaMetadata(fake.adapter, { schema }), redacted);
    assert.equal(fake.calls.length, 1);
  }
});

test("OFFLINE legacy metadata failures expose neither driver errors nor row values and do not retry", async () => {
  let calls = 0;
  await assert.rejects(collectLegacySchemaMetadata({ async query() { calls++; throw new Error("synthetic-secret unexpected-private-marker"); } }, { schema }), redacted);
  assert.equal(calls, 1);
  for (const [position, extra] of [[1, { comment: "synthetic-secret" }], [2, { default: "synthetic-secret" }], [3, { expression: "synthetic-secret" }]] as const) {
    const rows = fixture(); rows[position] = [{ ...(rows[position]![0] as object), ...extra }];
    await assert.rejects(collectLegacySchemaMetadata(port(rows).adapter, { schema }), redacted);
  }
});

test("OFFLINE legacy metadata refuses empty, non-array and over-limit results instead of truncating", async () => {
  const empty = fixture(); empty[1] = [];
  const emptyPort = port(empty);
  await assert.rejects(collectLegacySchemaMetadata(emptyPort.adapter, { schema }), redacted);
  assert.equal(emptyPort.calls.length, 2);
  await assert.rejects(collectLegacySchemaMetadata({ async query() { return {} as unknown[]; } }, { schema }), redacted);
  for (const [position, maximum] of [[0, 1], [1, legacyMetadataLimits.tables], [2, legacyMetadataLimits.columns], [3, legacyMetadataLimits.indexes]] as const) {
    const rows = fixture(); rows[position] = Array.from({ length: maximum + 1 }, () => rows[position]![0]);
    const fake = port(rows);
    await assert.rejects(collectLegacySchemaMetadata(fake.adapter, { schema }), redacted);
    assert.equal(fake.calls.length, position + 1);
  }
});

test("OFFLINE legacy metadata refuses malformed numeric, flag and identifier fields", async () => {
  for (const patch of [{ ordinal: 0 }, { ordinal: "1e0" }, { ordinal: "01" }, { characterLength: "9007199254740992" },
    { numericPrecision: -1 }, { numericScale: 21 }, { datetimePrecision: 7 }, { unsigned: true }, { unsigned: 2 },
    { generated: 1 }, { nullable: "true" }, { name: "unexpected-private-marker\nsecret" }, { dataType: "enum('synthetic-secret')" }]) {
    const rows = fixture(); rows[2] = [{ ...column, ...patch }];
    await assert.rejects(collectLegacySchemaMetadata(port(rows).adapter, { schema }), redacted);
  }
});

test("OFFLINE snapshot rejects duplicate tables, case collisions, missing parents and column gaps", async () => {
  const base = await collectLegacySchemaMetadata(port().adapter, { schema });
  const variants = [
    { ...base, tables: [...base.tables, base.tables[0]] },
    { ...base, tables: [{ ...base.tables[0], name: "absent" }] },
    { ...base, columns: [...base.columns, base.columns[0]] },
    { ...base, columns: [{ ...base.columns[0], ordinal: 2 }] },
    { ...base, columns: [{ ...base.columns[0], table: "absent" }] },
    { ...base, columns: [...base.columns, { ...base.columns[0], name: "ID", ordinal: 2 }] },
    { ...base, server: { ...base.server, lowerCaseTableNames: 1 }, tables: [...base.tables, { ...base.tables[0], name: "TASKS" }] },
  ];
  for (const value of variants) assert.throws(() => validateLegacySchemaSnapshot(value), redacted);
});

test("OFFLINE snapshot rejects invalid or incomplete index metadata", async () => {
  const base = await collectLegacySchemaMetadata(port().adapter, { schema });
  for (const indexes of [[{ ...base.indexes[0], table: "absent" }], [{ ...base.indexes[0], column: "absent" }],
    [{ ...base.indexes[0], sequence: 2 }], [base.indexes[0], base.indexes[0]], [{ ...base.indexes[0], unique: false }],
    [{ ...base.indexes[0], name: "primary", unique: false }], [{ ...base.indexes[0], name: "Primary", unique: false }],
    [{ ...base.indexes[0], column: null, prefixLength: 2 }],
    [base.indexes[0], { ...base.indexes[0], sequence: 2, unique: false }]]) {
    assert.throws(() => validateLegacySchemaSnapshot({ ...base, indexes }), redacted);
  }
  assert.throws(() => validateLegacySchemaSnapshot({ ...base, tables: [{ ...base.tables[0], kind: "VIEW", engine: null }] }), redacted);
});

test("OFFLINE snapshot retains views and unsupported expression-index markers without definitions", async () => {
  const rows = fixture();
  rows[1]!.push({ name: "public_view", kind: "VIEW", engine: null, collation: null });
  rows[2]!.push({ ...column, table: "public_view", unsigned: 0, autoIncrement: 0 });
  rows[3]!.push({ ...index, name: "expression_idx", column: null, nonUnique: 1 });
  const snapshot = await collectLegacySchemaMetadata(port(rows).adapter, { schema });
  assert.equal(snapshot.tables[0]!.kind, "VIEW");
  assert.equal(snapshot.indexes.find(value => value.name === "expression_idx")!.column, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /definition|default|expressionBody/);
});

test("OFFLINE snapshot validation is deterministic, strict, detached and does not grant adoption", async () => {
  const base = await collectLegacySchemaMetadata(port().adapter, { schema });
  const input = structuredClone(base);
  const result = validateLegacySchemaSnapshot(input);
  result.tables[0]!.name = "changed_copy";
  assert.equal(input.tables[0]!.name, "tasks");
  for (const value of [null, [], { ...base, password: "synthetic-secret" }, { ...base, adopted: true },
    { ...base, schema: "synthetic-secret" }, { ...base, schemaSha256: "invalid" }, { ...base, scope: "complete" },
    { ...base, columns: base.columns.map(value => ({ ...value, default: "synthetic-secret" })) }]) {
    assert.throws(() => validateLegacySchemaSnapshot(value), redacted);
  }
  assert.deepEqual(validateLegacySchemaSnapshot(JSON.parse(JSON.stringify(base))), base);
});
