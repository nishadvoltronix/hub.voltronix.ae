import { createHash } from "node:crypto";
import { z } from "zod";

/** An explicitly injected, query-only port. This module creates no connection.
 * The owner must bound connection/query time and authorize metadata visibility. */
export interface LegacyMetadataPort {
  query(sql: string, values: readonly string[]): Promise<readonly unknown[]>;
}

export const legacyMetadataLimits = Object.freeze({ tables: 256, columns: 8192, indexes: 8192 });
export const legacyMetadataLimitations = Object.freeze([
  "visibility-limited", "non-atomic", "foreign-keys-not-collected", "triggers-not-collected",
  "check-constraints-not-collected", "defaults-not-collected", "expressions-not-collected",
  "enum-set-members-not-collected", "index-order-and-visibility-not-collected",
  "data-and-privileges-not-verified",
] as const);
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,63}$/);
const metadataToken = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const nonnegative = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = nonnegative.min(1);
const tableSchema = z.object({ name: identifier, kind: z.enum(["BASE TABLE", "VIEW"]),
  engine: metadataToken.nullable(), collation: metadataToken.nullable() }).strict();
const columnSchema = z.object({ table: identifier, name: identifier, ordinal: positive, dataType: metadataToken,
  nullable: z.boolean(), characterLength: nonnegative.nullable(), numericPrecision: nonnegative.nullable(),
  numericScale: nonnegative.nullable(), datetimePrecision: nonnegative.nullable(),
  charset: metadataToken.nullable(), collation: metadataToken.nullable(), unsigned: z.boolean(),
  autoIncrement: z.boolean(), generated: z.boolean() }).strict();
const indexSchema = z.object({ table: identifier, name: identifier, unique: z.boolean(), sequence: positive,
  column: identifier.nullable(), prefixLength: positive.nullable(), type: metadataToken }).strict();
const snapshotSchema = z.object({ format: z.literal("legacy-schema-metadata-v1"),
  // Hash of the selected database NAME only, not a structural schema fingerprint.
  scope: z.literal("visible-structure-only"), schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
  server: z.object({ family: z.enum(["mysql-compatible", "mariadb"]),
    version: z.string().regex(/^\d{1,2}\.\d{1,3}\.\d{1,3}$/), lowerCaseTableNames: z.union([z.literal(0), z.literal(1), z.literal(2)]) }).strict(),
  tables: z.array(tableSchema).min(1).max(legacyMetadataLimits.tables),
  columns: z.array(columnSchema).min(1).max(legacyMetadataLimits.columns),
  indexes: z.array(indexSchema).max(legacyMetadataLimits.indexes),
}).strict();

/** schemaSha256 binds the selected database name, not schema contents, server
 * identity or collection provenance. It is not a structure compatibility hash. */
export type LegacySchemaSnapshot = z.infer<typeof snapshotSchema>;
export type LegacyTableMetadata = LegacySchemaSnapshot["tables"][number];
export type LegacyColumnMetadata = LegacySchemaSnapshot["columns"][number];
export type LegacyIndexMetadata = LegacySchemaSnapshot["indexes"][number];

export class LegacyMetadataError extends Error {
  constructor() { super("Legacy schema metadata is unavailable or invalid; no schema adoption or change was performed."); this.name = "LegacyMetadataError"; }
}

function boundedArray(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new LegacyMetadataError();
}
function same<T>(values: readonly T[]): boolean { return values.every(value => value === values[0]); }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Validate an offline metadata document, not its authenticity, completeness or
 * runtime compatibility. Unknown fields (including defaults/comments) refuse.
 * Metadata visibility can be partial and collection is not an atomic snapshot. */
export function validateLegacySchemaSnapshot(value: unknown): LegacySchemaSnapshot {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new LegacyMetadataError();
    const input = value as Record<string, unknown>;
    boundedArray(input.tables, legacyMetadataLimits.tables);
    boundedArray(input.columns, legacyMetadataLimits.columns);
    boundedArray(input.indexes, legacyMetadataLimits.indexes);
    const result = snapshotSchema.parse(value);
    const tableNames = new Set(result.tables.map(table => table.name));
    const tableKinds = new Map(result.tables.map(table => [table.name, table.kind]));
    if (tableNames.size !== result.tables.length) throw new LegacyMetadataError();
    if (result.server.lowerCaseTableNames !== 0 && new Set(result.tables.map(table => table.name.toLowerCase())).size !== result.tables.length) throw new LegacyMetadataError();
    const columnKeys = new Set<string>(), columnsByTable = new Map<string, LegacyColumnMetadata[]>();
    for (const column of result.columns) {
      const key = `${column.table}/${column.name.toLowerCase()}`;
      if (!tableNames.has(column.table) || columnKeys.has(key)
        || (column.numericScale !== null && (column.numericPrecision === null || column.numericScale > column.numericPrecision))
        || (column.datetimePrecision !== null && column.datetimePrecision > 6)
        || (column.autoIncrement && column.generated)) throw new LegacyMetadataError();
      columnKeys.add(key);
      const columns = columnsByTable.get(column.table) ?? []; columns.push(column); columnsByTable.set(column.table, columns);
    }
    for (const table of result.tables) {
      const columns = columnsByTable.get(table.name);
      if (!columns?.length || (table.kind === "BASE TABLE" && !table.engine)
        || (table.kind === "VIEW" && table.engine !== null)) throw new LegacyMetadataError();
      columns.sort((a, b) => a.ordinal - b.ordinal);
      if (columns.some((column, index) => column.ordinal !== index + 1)) throw new LegacyMetadataError();
    }
    const indexGroups = new Map<string, LegacyIndexMetadata[]>();
    for (const index of result.indexes) {
      if (tableKinds.get(index.table) !== "BASE TABLE" || (index.column !== null && !columnKeys.has(`${index.table}/${index.column.toLowerCase()}`))
        || (index.column === null && index.prefixLength !== null)) throw new LegacyMetadataError();
      const key = `${index.table}/${index.name.toLowerCase()}`;
      const entries = indexGroups.get(key) ?? []; entries.push(index); indexGroups.set(key, entries);
    }
    for (const entries of indexGroups.values()) {
      entries.sort((a, b) => a.sequence - b.sequence);
      if (!same(entries.map(index => index.name)) || !same(entries.map(index => index.unique)) || !same(entries.map(index => index.type))
        || entries.some((index, position) => index.sequence !== position + 1)
        || (entries[0]!.name.toUpperCase() === "PRIMARY" && !entries[0]!.unique)) throw new LegacyMetadataError();
    }
    result.tables.sort((a, b) => compare(a.name, b.name));
    result.columns.sort((a, b) => compare(a.table, b.table) || a.ordinal - b.ordinal);
    result.indexes.sort((a, b) => compare(a.table, b.table) || compare(a.name, b.name) || a.sequence - b.sequence);
    return result;
  } catch { throw new LegacyMetadataError(); }
}

const integerWire = z.union([nonnegative, z.string().regex(/^(?:0|[1-9][0-9]{0,15})$/).transform(Number).pipe(nonnegative)]);
const flagWire = z.union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")]).transform(value => value === 1 || value === "1");
const serverRow = z.object({ version: z.string().max(128), lowerCaseTableNames: integerWire, selectedDatabase: identifier }).strict();
const tableRow = tableSchema;
const columnRow = columnSchema.extend({ ordinal: integerWire, nullable: z.enum(["YES", "NO"]).transform(value => value === "YES"),
  characterLength: integerWire.nullable(), numericPrecision: integerWire.nullable(), numericScale: integerWire.nullable(),
  datetimePrecision: integerWire.nullable(), unsigned: flagWire, autoIncrement: flagWire, generated: flagWire });
const indexRow = indexSchema.omit({ unique: true }).extend({ nonUnique: flagWire, sequence: integerWire, prefixLength: integerWire.nullable() });

// Fixed SELECT projections only: never defaults, comments, row counts, enum
// literals, expressions, SHOW CREATE output, grants, users or business rows.
export const legacyMetadataQueries = Object.freeze({
  server: "SELECT VERSION() AS `version`,@@lower_case_table_names AS `lowerCaseTableNames`,DATABASE() AS `selectedDatabase`",
  tables: `SELECT TABLE_NAME AS \`name\`,TABLE_TYPE AS \`kind\`,ENGINE AS \`engine\`,TABLE_COLLATION AS \`collation\` FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME LIMIT ${legacyMetadataLimits.tables + 1}`,
  columns: `SELECT TABLE_NAME AS \`table\`,COLUMN_NAME AS \`name\`,ORDINAL_POSITION AS \`ordinal\`,DATA_TYPE AS \`dataType\`,IS_NULLABLE AS \`nullable\`,CHARACTER_MAXIMUM_LENGTH AS \`characterLength\`,NUMERIC_PRECISION AS \`numericPrecision\`,NUMERIC_SCALE AS \`numericScale\`,DATETIME_PRECISION AS \`datetimePrecision\`,CHARACTER_SET_NAME AS \`charset\`,COLLATION_NAME AS \`collation\`,CASE WHEN DATA_TYPE IN ('tinyint','smallint','mediumint','int','integer','bigint','decimal','float','double','real') AND COLUMN_TYPE REGEXP ' unsigned( zerofill)?$' THEN 1 ELSE 0 END AS \`unsigned\`,CASE WHEN LOCATE('auto_increment',EXTRA)>0 THEN 1 ELSE 0 END AS \`autoIncrement\`,CASE WHEN UPPER(EXTRA) REGEXP '(^| )(VIRTUAL|STORED|PERSISTENT)( |$)' THEN 1 ELSE 0 END AS \`generated\` FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION LIMIT ${legacyMetadataLimits.columns + 1}`,
  indexes: `SELECT TABLE_NAME AS \`table\`,INDEX_NAME AS \`name\`,NON_UNIQUE AS \`nonUnique\`,SEQ_IN_INDEX AS \`sequence\`,COLUMN_NAME AS \`column\`,SUB_PART AS \`prefixLength\`,INDEX_TYPE AS \`type\` FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT ${legacyMetadataLimits.indexes + 1}`,
} as const);

function serverSummary(value: unknown, schema: string): LegacySchemaSnapshot["server"] {
  const row = serverRow.parse(value);
  if (row.selectedDatabase !== schema) throw new LegacyMetadataError();
  const maria = /mariadb/i.test(row.version);
  const version = /^(?:5\.5\.5-)?(\d{1,2}\.\d{1,3}\.\d{1,3})(?:[-+][A-Za-z0-9._+-]{1,100})?$/.exec(row.version)?.[1];
  if (!version || row.lowerCaseTableNames > 2) throw new LegacyMetadataError();
  return { family: maria ? "mariadb" : "mysql-compatible", version, lowerCaseTableNames: row.lowerCaseTableNames as 0 | 1 | 2 };
}

/** Four sequential metadata SELECTs through the supplied port; no connection,
 * transaction, schema adoption, migration or fallback. A caller-owned adapter
 * must enforce I/O deadlines. Null index columns flag unsupported expression
 * metadata without collecting the expression itself. */
export async function collectLegacySchemaMetadata(port: LegacyMetadataPort, input: { schema: string }): Promise<LegacySchemaSnapshot> {
  try {
    const { schema } = z.object({ schema: identifier }).strict().parse(input);
    if (["information_schema", "mysql", "performance_schema", "sys"].includes(schema.toLowerCase())) throw new LegacyMetadataError();
    const serverRows = await port.query(legacyMetadataQueries.server, []);
    boundedArray(serverRows, 1);
    if (serverRows.length !== 1) throw new LegacyMetadataError();
    const server = serverSummary(serverRows[0], schema);
    const rawTables = await port.query(legacyMetadataQueries.tables, [schema]); boundedArray(rawTables, legacyMetadataLimits.tables);
    if (!rawTables.length) throw new LegacyMetadataError();
    const tables = rawTables.map(row => tableRow.parse(row));
    const rawColumns = await port.query(legacyMetadataQueries.columns, [schema]); boundedArray(rawColumns, legacyMetadataLimits.columns);
    const columns = rawColumns.map(row => columnRow.parse(row));
    const rawIndexes = await port.query(legacyMetadataQueries.indexes, [schema]); boundedArray(rawIndexes, legacyMetadataLimits.indexes);
    const indexes = rawIndexes.map(row => { const { nonUnique, ...index } = indexRow.parse(row); return { ...index, unique: !nonUnique }; });
    return validateLegacySchemaSnapshot({ format: "legacy-schema-metadata-v1", scope: "visible-structure-only",
      schemaSha256: createHash("sha256").update(schema).digest("hex"), server, tables, columns, indexes });
  } catch { throw new LegacyMetadataError(); }
}
