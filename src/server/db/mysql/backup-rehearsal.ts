import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { validateLocalMysqlConfig, type LocalMysqlConfig } from "../../config/mysql";
import { assertMysqlMigrationsCurrent, migrateMysqlApplicationSchema, type MysqlMigrationSession } from "./migrations";
import { mysqlExpectedTables, mysqlExpectedTriggers } from "./schema";

type FailurePhase = "validation" | "identity" | "source-snapshot" | "artifact" | "target-restore" | "target-schema" | "reconciliation";
export class MysqlBackupRehearsalError extends Error {
  constructor(public readonly phase: FailurePhase = "validation") {
    super("MySQL backup rehearsal failed or requires approved isolated inputs. Existing data and artifacts were not reset; preserve any partial target for investigation.");
  }
}
const MAX_ROWS = 5_000;
const MAX_BYTES = 64 * 1024 * 1024;
const businessTables = mysqlExpectedTables.filter((name) => name !== "crm_app_lock");
type Value = null | string | number | { binary: string };
interface Column { tableName: string; name: string; position: number; type: string; nullable: string; defaultValue: unknown;
  extra: string; charset: string | null; collation: string | null; generation: string }
interface TableRows { name: string; columns: string[]; rows: Value[][]; rowCount: number; blobSha256: string[]; sha256: string }
interface Metadata { tables: Record<string, unknown>[]; columns: Column[]; indexes: Record<string, unknown>[];
  keys: Record<string, unknown>[]; references: Record<string, unknown>[]; checks: Record<string, unknown>[];
  triggers: Record<string, unknown>[]; sequences: Record<string, string> }
interface Snapshot { formatVersion: 1; kind: "current-application-logical-snapshot"; createdAt: string;
  schema: Metadata; ledger: Record<string, unknown>[]; tables: TableRows[] }
type Options = { source: MysqlMigrationSession; target: MysqlMigrationSession; sourceConfig: LocalMysqlConfig;
  targetConfig: LocalMysqlConfig; artifactRoot: string; applicationDirectory?: string; acknowledgeFrozenSource: true };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown) => digest(left) === digest(right);
function identifier(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)) throw new MysqlBackupRehearsalError();
  return "`" + value + "`";
}
function integer(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  throw new MysqlBackupRehearsalError();
}
async function rows(db: MysqlMigrationSession, sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const [result] = await db.execute(sql, values);
  if (!Array.isArray(result) || result.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new MysqlBackupRehearsalError();
  return result as Record<string, unknown>[];
}
function encode(value: unknown): Value {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (Buffer.isBuffer(value)) return { binary: value.toString("base64") };
  throw new MysqlBackupRehearsalError();
}
function decode(value: Value): string | number | null | Buffer {
  return value !== null && typeof value === "object" ? Buffer.from(value.binary, "base64") : value;
}
export function validateMysqlBackupPair(sourceInput: LocalMysqlConfig, targetInput: LocalMysqlConfig, acknowledged: unknown) {
  const source = validateLocalMysqlConfig(sourceInput), target = validateLocalMysqlConfig(targetInput);
  if (acknowledged !== true || source.environment !== "test" || target.environment !== "test"
    || source.host !== "127.0.0.1" || target.host !== "127.0.0.1" || source.port !== 3308 || target.port !== 3308
    || !/^crm_local_test_[a-z0-9_]{1,40}$/u.test(source.database) || !/^crm_local_restore_[a-z0-9_]{1,40}$/u.test(target.database)
    || source.database === target.database || source.user === target.user) throw new MysqlBackupRehearsalError();
  return { source, target };
}
async function identity(db: MysqlMigrationSession, expected: string) {
  const result = await rows(db, `SELECT DATABASE() AS selectedDatabase, VERSION() AS serverVersion,
    @@version_comment AS versionComment, @@port AS port, @@session.foreign_key_checks AS foreignKeys,
    @@session.autocommit AS autocommit`);
  const value = result[0];
  if (result.length !== 1 || !value || value.selectedDatabase !== expected || value.serverVersion !== "8.4.11"
    || typeof value.versionComment !== "string" || !/mysql/iu.test(value.versionComment) || /mariadb/iu.test(value.versionComment)
    || integer(value.port) !== 3308n || integer(value.foreignKeys) !== 1n || integer(value.autocommit) !== 1n) throw new MysqlBackupRehearsalError();
}
async function assertEmptyTarget(db: MysqlMigrationSession, database: string) {
  const definitions = [
    ["information_schema.TABLES", "TABLE_SCHEMA"], ["information_schema.TRIGGERS", "TRIGGER_SCHEMA"],
    ["information_schema.ROUTINES", "ROUTINE_SCHEMA"], ["information_schema.EVENTS", "EVENT_SCHEMA"],
  ] as const;
  for (const [table, column] of definitions) {
    const result = await rows(db, `SELECT CAST(COUNT(*) AS CHAR) AS n FROM ${table} WHERE ${column}=?`, [database]);
    if (result.length !== 1 || integer(result[0]?.n) !== 0n) throw new MysqlBackupRehearsalError();
  }
}

/** Captures structural metadata without DEFINER identities, statistics or row values. */
async function metadata(db: MysqlMigrationSession, database: string): Promise<Metadata> {
  const tableRows = await rows(db, `SELECT TABLE_NAME AS name,ENGINE AS engine,TABLE_COLLATION AS collation,
    CAST(AUTO_INCREMENT AS CHAR) AS nextId FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME`, [database]);
  const expected = [...mysqlExpectedTables, "crm_mysql_schema_migrations"].sort();
  if (!same(tableRows.map(({ name }) => name), expected) || tableRows.some(({ engine }) => engine !== "InnoDB")) throw new MysqlBackupRehearsalError();
  const sequences: Record<string, string> = {};
  for (const row of tableRows) if (row.nextId !== null) {
    const next = integer(row.nextId);
    if (next < 1n || next > 9_223_372_036_854_775_807n) throw new MysqlBackupRehearsalError();
    sequences[String(row.name)] = next.toString();
  }
  const columns = await rows(db, `SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,ORDINAL_POSITION AS position,
    COLUMN_TYPE AS type,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS defaultValue,EXTRA AS extra,
    CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,GENERATION_EXPRESSION AS generation
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION`, [database]);
  for (const column of columns) {
    if (typeof column.tableName !== "string" || !expected.includes(column.tableName as typeof expected[number])
      || typeof column.name !== "string" || typeof column.extra !== "string" || typeof column.type !== "string") throw new MysqlBackupRehearsalError();
    identifier(column.name); column.position = Number(integer(column.position));
  }
  const indexes = await rows(db, `SELECT TABLE_NAME AS tableName,INDEX_NAME AS name,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS position,
    COLUMN_NAME AS columnName,COLLATION AS ordering,SUB_PART AS prefixLength,INDEX_TYPE AS indexType,IS_VISIBLE AS visible,EXPRESSION AS expression
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`, [database]);
  const keys = await rows(db, `SELECT TABLE_NAME AS tableName,CONSTRAINT_NAME AS name,COLUMN_NAME AS columnName,
    ORDINAL_POSITION AS position,POSITION_IN_UNIQUE_CONSTRAINT AS referencedPosition,
    REFERENCED_TABLE_NAME AS referencedTable,REFERENCED_COLUMN_NAME AS referencedColumn,
    CASE WHEN REFERENCED_TABLE_SCHEMA IS NULL THEN NULL WHEN REFERENCED_TABLE_SCHEMA=? THEN 'SELF' ELSE 'EXTERNAL' END AS referenceScope
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`, [database, database]);
  if (keys.some(({ referenceScope }) => referenceScope === "EXTERNAL")) throw new MysqlBackupRehearsalError();
  const references = await rows(db, `SELECT TABLE_NAME AS tableName,CONSTRAINT_NAME AS name,UNIQUE_CONSTRAINT_NAME AS referencedKey,
    MATCH_OPTION AS matchOption,UPDATE_RULE AS updateRule,DELETE_RULE AS deleteRule,REFERENCED_TABLE_NAME AS referencedTable
    FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? ORDER BY TABLE_NAME,CONSTRAINT_NAME`, [database]);
  const checks = await rows(db, `SELECT t.TABLE_NAME AS tableName,t.CONSTRAINT_NAME AS name,t.ENFORCED AS enforced,c.CHECK_CLAUSE AS expression
    FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
      ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
    WHERE t.CONSTRAINT_SCHEMA=? AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.TABLE_NAME,t.CONSTRAINT_NAME`, [database]);
  const triggers = await rows(db, `SELECT TRIGGER_NAME AS name,EVENT_MANIPULATION AS event,EVENT_OBJECT_TABLE AS tableName,
    ACTION_ORDER AS actionOrder,ACTION_STATEMENT AS body,ACTION_ORIENTATION AS orientation,ACTION_TIMING AS timing,
    SQL_MODE AS sqlMode,CHARACTER_SET_CLIENT AS clientCharset,COLLATION_CONNECTION AS connectionCollation,DATABASE_COLLATION AS databaseCollation
    FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY TRIGGER_NAME`, [database]);
  if (!same(triggers.map(({ name }) => name), [...mysqlExpectedTriggers].sort())) throw new MysqlBackupRehearsalError();
  return { tables: tableRows.map(({ name, engine, collation }) => ({ name, engine, collation })), columns: columns as unknown as Column[],
    indexes, keys, references, checks, triggers, sequences };
}
function structural(value: Metadata) { const { sequences: _sequences, ...structure } = value; void _sequences; return structure; }
async function tableSnapshot(db: MysqlMigrationSession, name: string, meta: Metadata): Promise<TableRows> {
  const columns = meta.columns.filter((column) => column.tableName === name && !/\b(?:STORED|VIRTUAL) GENERATED\b/u.test(column.extra)).map(({ name: column }) => column);
  const keys = meta.keys.filter((key) => key.tableName === name && key.name === "PRIMARY").map(({ columnName }) => String(columnName));
  if (!columns.length || !keys.length || keys.some((key) => !columns.includes(key))) throw new MysqlBackupRehearsalError();
  const sizing = await rows(db, `SELECT CAST(COUNT(*) AS CHAR) AS n,
    CAST(COALESCE(SUM(${columns.map((column) => `COALESCE(OCTET_LENGTH(${identifier(column)}),0)`).join("+")}),0) AS CHAR) AS bytes FROM ${identifier(name)}`);
  if (sizing.length !== 1 || integer(sizing[0]?.n) > BigInt(MAX_ROWS) || integer(sizing[0]?.bytes) > BigInt(MAX_BYTES)) throw new MysqlBackupRehearsalError();
  const source = await rows(db, `SELECT ${columns.map(identifier).join(",")} FROM ${identifier(name)} ORDER BY ${keys.map(identifier).join(",")} LIMIT ${MAX_ROWS + 1}`);
  if (source.length > MAX_ROWS || BigInt(source.length) !== integer(sizing[0]?.n)) throw new MysqlBackupRehearsalError();
  const values = source.map((row) => columns.map((column) => encode(row[column])));
  const blobSha256: string[] = [];
  if (["task_attachment", "crm_department_log_attachments"].includes(name)) {
    for (const row of source) {
      if (!Buffer.isBuffer(row.content) || integer(row.file_size) !== BigInt(row.content.length)) throw new MysqlBackupRehearsalError();
      const hash = createHash("sha256").update(row.content).digest("hex");
      if (row.content_sha256 !== hash) throw new MysqlBackupRehearsalError();
      blobSha256.push(hash);
    }
  }
  const result = { name, columns, rows: values, rowCount: values.length, blobSha256 };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new MysqlBackupRehearsalError();
  return { ...result, sha256: digest(result) };
}
async function snapshot(db: MysqlMigrationSession, database: string): Promise<Snapshot> {
  await assertMysqlMigrationsCurrent(db, database);
  await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await db.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  try {
    const schema = await metadata(db, database), tables: TableRows[] = [];
    let count = 0, bytes = 0;
    for (const name of businessTables) {
      const table = await tableSnapshot(db, name, schema); tables.push(table); count += table.rowCount; bytes += Buffer.byteLength(JSON.stringify(table));
      if (count > MAX_ROWS || bytes > MAX_BYTES) throw new MysqlBackupRehearsalError();
    }
    const ledger = await rows(db, "SELECT version,name,checksum,state,started_at,completed_at FROM crm_mysql_schema_migrations ORDER BY version");
    await db.query("COMMIT");
    return { formatVersion: 1, kind: "current-application-logical-snapshot", createdAt: new Date().toISOString(), schema, ledger, tables };
  } catch { try { await db.query("ROLLBACK"); } catch { /* caller owns connection cleanup */ } throw new MysqlBackupRehearsalError(); }
}
function createArtifactDirectory(applicationDirectory: string, artifactRoot: string): string {
  const app = resolve(applicationDirectory), parent = resolve(artifactRoot);
  const within = relative(join(app, ".local-data", "test"), parent);
  if (within === ".." || within.startsWith(".." + sep) || resolve(parent) === app || /^[A-Za-z]:/u.test(within) || within.startsWith(sep)) throw new MysqlBackupRehearsalError();
  const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  let current = app;
  for (const segment of ["", ...relative(app, parent).split(sep)]) {
    if (segment) current = join(current, segment);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(current), current)) throw new MysqlBackupRehearsalError();
  }
  const directory = join(parent, "mysql-backup-rehearsal-" + randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}
function exclusiveJson(filename: string, value: unknown) {
  const descriptor = openSync(filename, "wx", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value) + "\n", "utf8"); }
  finally { closeSync(descriptor); }
}
function stableSnapshot(value: Snapshot) { const { createdAt: _createdAt, ...stable } = value; void _createdAt; return stable; }
async function verifyForeignKeys(db: MysqlMigrationSession, meta: Metadata) {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const key of meta.keys.filter(({ referencedTable }) => referencedTable !== null)) {
    const group = String(key.tableName) + ":" + String(key.name);
    groups.set(group, [...(groups.get(group) ?? []), key]);
  }
  for (const keys of groups.values()) {
    const table = identifier(String(keys[0]!.tableName)), parent = identifier(String(keys[0]!.referencedTable));
    const notNull = keys.map((key) => `c.${identifier(String(key.columnName))} IS NOT NULL`).join(" AND ");
    const joins = keys.map((key) => `p.${identifier(String(key.referencedColumn))}=c.${identifier(String(key.columnName))}`).join(" AND ");
    const violations = await rows(db, `SELECT CAST(COUNT(*) AS CHAR) AS n FROM ${table} c WHERE ${notNull} AND NOT EXISTS(SELECT 1 FROM ${parent} p WHERE ${joins})`);
    if (violations.length !== 1 || integer(violations[0]?.n) !== 0n) throw new MysqlBackupRehearsalError();
  }
}
async function restore(db: MysqlMigrationSession, database: string, backup: Snapshot) {
  await migrateMysqlApplicationSchema(db, { database, allowSchemaChanges: true });
  const fresh = await metadata(db, database);
  if (!same(structural(fresh), structural(backup.schema))) throw new MysqlBackupRehearsalError("target-schema");
  await db.query("START TRANSACTION");
  try {
    const locked = await rows(db, "SELECT id FROM crm_app_lock WHERE id=1 FOR UPDATE");
    if (locked.length !== 1 || integer(locked[0]?.id) !== 1n) throw new MysqlBackupRehearsalError();
    for (const table of backup.tables) {
      if (!businessTables.includes(table.name as typeof businessTables[number])) throw new MysqlBackupRehearsalError();
      const allowed = fresh.columns.filter((column) => column.tableName === table.name && !/\b(?:STORED|VIRTUAL) GENERATED\b/u.test(column.extra)).map(({ name }) => name);
      if (!same(allowed, table.columns)) throw new MysqlBackupRehearsalError();
      const sql = `INSERT INTO ${identifier(table.name)}(${table.columns.map(identifier).join(",")}) VALUES(${table.columns.map(() => "?").join(",")})`;
      const selfReference = table.name === "users" ? table.columns.indexOf("department_assigned_by") : -1;
      for (const row of table.rows) {
        const values = row.map(decode);
        if (selfReference >= 0) values[selfReference] = null;
        await db.execute(sql, values);
      }
      if (selfReference >= 0) {
        const id = table.columns.indexOf("id");
        if (id < 0) throw new MysqlBackupRehearsalError();
        for (const row of table.rows) if (row[selfReference] !== null) {
          await db.execute("UPDATE users SET department_assigned_by=? WHERE id=?", [decode(row[selfReference]!), decode(row[id]!)]);
        }
      }
    }
    for (const entry of backup.ledger) {
      const [result] = await db.execute(`UPDATE crm_mysql_schema_migrations SET started_at=?,completed_at=?
        WHERE version=? AND name=? AND checksum=? AND state='completed'`, [entry.started_at, entry.completed_at, entry.version, entry.name, entry.checksum]);
      if (!result || typeof result !== "object" || !("affectedRows" in result) || ![0, 1].includes(Number(result.affectedRows))) throw new MysqlBackupRehearsalError();
    }
    await verifyForeignKeys(db, fresh);
    for (const expected of backup.tables) {
      if (!same(await tableSnapshot(db, expected.name, fresh), expected)) throw new MysqlBackupRehearsalError();
    }
    await db.query("COMMIT");
  } catch { try { await db.query("ROLLBACK"); } catch { /* retain owned target for investigation */ } throw new MysqlBackupRehearsalError(); }
  // AUTO_INCREMENT state does not roll back and may exceed MAX(id)+1 after deleted
  // or rolled-back rows. Preserve captured positions on this new owned target only.
  for (const [table, value] of Object.entries(backup.schema.sequences)) {
    if (!businessTables.includes(table as typeof businessTables[number]) || integer(value) < 1n) throw new MysqlBackupRehearsalError();
    await db.query(`ALTER TABLE ${identifier(table)} AUTO_INCREMENT=${integer(value).toString()}`);
  }
}

/** Application-only, bounded logical backup and restore rehearsal. No network factory,
 * startup, database creation, import of arbitrary SQL, DROP/reset or deletion exists.
 * Caller must own both exclusive connections and the freeze/approval/access evidence.
 */
export async function rehearseMysqlApplicationBackup(options: Options) {
  let directory: string | undefined;
  let phase: FailurePhase = "validation";
  try {
    const configs = validateMysqlBackupPair(options.sourceConfig, options.targetConfig, options.acknowledgeFrozenSource);
    phase = "identity";
    await identity(options.source, configs.source.database); await identity(options.target, configs.target.database);
    for (const connection of [options.source, options.target]) {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.query("SET SESSION information_schema_stats_expiry = 0");
    }
    await assertEmptyTarget(options.target, configs.target.database);
    phase = "source-snapshot";
    const backup = await snapshot(options.source, configs.source.database);
    if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BYTES) throw new MysqlBackupRehearsalError();
    phase = "artifact";
    directory = createArtifactDirectory(options.applicationDirectory ?? process.cwd(), options.artifactRoot);
    const artifact = join(directory, "application-backup.json"); exclusiveJson(artifact, backup);
    const before = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    exclusiveJson(join(directory, "backup-complete.json"), { formatVersion: 1, completedAt: new Date().toISOString(), sha256: before,
      tables: backup.tables.map(({ name, rowCount, sha256 }) => ({ name, rowCount, sha256 })), schemaSha256: digest(backup.schema),
      connectionCredentialsIncluded: false, containsPrivateApplicationData: true });
    // Recheck immediately before additive target DDL; do not adopt even an owned
    // earlier partial restore or objects created after the first preflight.
    await identity(options.target, configs.target.database); await assertEmptyTarget(options.target, configs.target.database);
    const persisted = JSON.parse(readFileSync(artifact, "utf8")) as Snapshot;
    if (!same(persisted, backup)) throw new MysqlBackupRehearsalError();
    phase = "target-restore";
    await restore(options.target, configs.target.database, persisted);
    phase = "reconciliation";
    const restored = await snapshot(options.target, configs.target.database), sourceAfter = await snapshot(options.source, configs.source.database);
    if (!same(stableSnapshot(restored), stableSnapshot(backup)) || !same(stableSnapshot(sourceAfter), stableSnapshot(backup))
      || before !== createHash("sha256").update(readFileSync(artifact)).digest("hex")) throw new MysqlBackupRehearsalError();
    const result = { status: "PASS_APPLICATION_LOGICAL_RESTORE" as const, serverVersion: "8.4.11", completedAt: new Date().toISOString(),
      backupSha256: before, sourceUnchanged: true, backupUnchanged: true, foreignKeyViolations: 0, foreignKeysAlwaysEnabled: true,
      fullSelectedMetadataMatched: true, ledgerAndLockMatched: true, autoIncrementPositionsMatched: true,
      attachmentBlobsVerified: backup.tables.reduce((total, table) => total + table.blobSha256.length, 0),
      tables: backup.tables.map(({ name, rowCount, sha256 }) => ({ name, rowCount, sha256 })),
      artifactDirectory: relative(options.applicationDirectory ?? process.cwd(), directory).replaceAll("\\", "/"),
      limitations: ["Bounded current-application fixture backup only; not a full-server, historical-data or point-in-time backup.",
        "The private artifact includes application authentication hashes and uploaded bytes; never publish or log its contents.",
        "Trigger definers deliberately belong to the target operator; server accounts/grants and infrastructure are not copied.",
        "Caller owns source freeze and private filesystem access-control evidence; no application reconnect or staging gate is verified."],
      maximumRows: MAX_ROWS, maximumBytes: MAX_BYTES, originalsReplaced: false, applicationReconnected: false, stagingVerified: false };
    exclusiveJson(join(directory, "restore-complete.json"), result);
    return result;
  } catch (error) {
    if (error instanceof MysqlBackupRehearsalError && error.phase !== "validation") phase = error.phase;
    if (directory) {
      try { exclusiveJson(join(directory, "restore-incomplete.json"), { completed: false, phase, investigateRetainedTarget: true, at: new Date().toISOString() }); }
      catch { /* no overwrite and no driver/filesystem details */ }
    }
    throw new MysqlBackupRehearsalError(phase);
  }
}
