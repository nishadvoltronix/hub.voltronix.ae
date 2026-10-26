import { createHash } from "node:crypto";
import { mysqlApplicationSchemaStatements, mysqlExpectedIndexes, mysqlExpectedTables, mysqlExpectedTriggers } from "./schema.js";

/** Caller supplies one exclusively pinned connection, outside any application transaction. */
export interface MysqlMigrationSession {
  execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  query(sql: string): Promise<[unknown, unknown]>;
}

export class MysqlMigrationError extends Error {
  constructor(readonly stage?: string, readonly driverCode?: string) {
    super("MySQL application migrations are unavailable or require investigation. No automatic repair, rollback, import or schema adoption was performed.");
    this.name = "MysqlMigrationError";
  }
}

const ledger = "crm_mysql_schema_migrations";
const systemSchemas = new Set(["mysql", "sys", "information_schema", "performance_schema"]);
// Express migration access remains an explicit local operation, never runtime setup.
const approvedDatabase = (value: string) => value === "crm_local_dev" || /^crm_local_auth_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u.test(value);
const checksum = (statements: readonly string[]) => createHash("sha256").update(JSON.stringify(statements)).digest("hex");
export const mysqlMigrations = [{
  version: 1,
  name: "mysql_application_foundation",
  statements: mysqlApplicationSchemaStatements,
  checksum: checksum(mysqlApplicationSchemaStatements),
}] as const;

interface ObjectInventory { tables: string[]; triggers: string[]; routines: string[]; events: string[] }
interface HistoryRow { version: number | string; name: string; checksum: string; state: "applying" | "completed" }

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new MysqlMigrationError();
  return value as Record<string, unknown>[];
}
async function executeRows(connection: MysqlMigrationSession, sql: string, values: unknown[] = []) {
  return rows((await connection.execute(sql, values))[0]);
}
function scalarNumber(value: unknown): number {
  if (value !== 1 && value !== "1") throw new MysqlMigrationError();
  return 1;
}
function names(result: Record<string, unknown>[]) {
  if (result.some((row) => typeof row.name !== "string")) throw new MysqlMigrationError();
  return result.map(({ name }) => name as string).sort();
}
function sameNames(actual: readonly string[], expected: readonly string[]) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

async function identity(connection: MysqlMigrationSession, expectedDatabase?: string): Promise<string> {
  const result = await executeRows(connection, `SELECT DATABASE() AS selectedDatabase, VERSION() AS serverVersion,
    @@version_comment AS versionComment, @@session.autocommit AS autocommit, @@port AS port`);
  const row = result[0];
  if (result.length !== 1 || !row || typeof row.selectedDatabase !== "string"
    || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(row.selectedDatabase) || systemSchemas.has(row.selectedDatabase.toLowerCase())
    || !approvedDatabase(row.selectedDatabase) || String(row.port) !== "3308"
    || (expectedDatabase !== undefined && row.selectedDatabase !== expectedDatabase)
    || row.serverVersion !== "8.4.11" || typeof row.versionComment !== "string"
    || !/mysql/iu.test(row.versionComment) || /mariadb/iu.test(row.versionComment)) throw new MysqlMigrationError();
  scalarNumber(row.autocommit);
  return row.selectedDatabase;
}
async function inventory(connection: MysqlMigrationSession, database: string): Promise<ObjectInventory> {
  // A migration operator needs metadata visibility for the entire selected schema.
  // Counts seen through the SELECT-only preparation identity do not prove an empty schema.
  const tableRows = await executeRows(connection,
    "SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME", [database]);
  if (tableRows.some((row) => row.type !== "BASE TABLE" || row.engine !== "InnoDB")) throw new MysqlMigrationError();
  return {
    tables: names(tableRows),
    triggers: names(await executeRows(connection,
      "SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY TRIGGER_NAME", [database])),
    routines: names(await executeRows(connection,
      "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=? ORDER BY ROUTINE_NAME", [database])),
    events: names(await executeRows(connection,
      "SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA=? ORDER BY EVENT_NAME", [database])),
  };
}
async function history(connection: MysqlMigrationSession): Promise<HistoryRow[]> {
  const result = await executeRows(connection, `SELECT version,name,checksum,state FROM ${ledger} ORDER BY version`);
  for (const [index, row] of result.entries()) {
    const expected = mysqlMigrations[index];
    if (!expected || String(row.version) !== String(expected.version) || row.name !== expected.name
      || row.checksum !== expected.checksum || row.state !== "completed") throw new MysqlMigrationError();
  }
  return result as unknown as HistoryRow[];
}
function assertObjectsCurrent(objects: ObjectInventory) {
  if (!sameNames(objects.tables, [ledger, ...mysqlExpectedTables])
    || !sameNames(objects.triggers, mysqlExpectedTriggers) || objects.routines.length || objects.events.length) throw new MysqlMigrationError();
}

async function assertIndexesCurrent(connection: MysqlMigrationSession, database: string) {
  const indexes = await executeRows(connection,
    "SELECT TABLE_NAME AS tableName,INDEX_NAME AS name,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS position,COLUMN_NAME AS columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX", [database]);
  for (const index of mysqlExpectedIndexes) {
    const actual = indexes.filter((row) => row.tableName === index.table && row.name === index.name);
    if (actual.length !== index.columns.length || actual.some((row, position) => String(row.nonUnique) !== (index.unique ? "0" : "1")
      || String(row.position) !== String(position + 1) || row.columnName !== index.columns[position])) throw new MysqlMigrationError();
  }
}

/** Metadata/ledger guard only. No automatic migration, database creation or import. */
export async function assertMysqlMigrationsCurrent(connection: MysqlMigrationSession, expectedDatabase?: string): Promise<void> {
  try {
    const database = await identity(connection, expectedDatabase);
    // Runtime accounts must not receive TRIGGER/DDL privileges merely to inspect
    // definitions. The migration operator separately verifies trigger inventories.
    const tables = await executeRows(connection,
      "SELECT TABLE_NAME AS name,TABLE_TYPE AS type,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME", [database]);
    if (tables.some((row) => row.type !== "BASE TABLE" || row.engine !== "InnoDB")
      || !sameNames(names(tables), [ledger, ...mysqlExpectedTables])) throw new MysqlMigrationError();
    if ((await history(connection)).length !== mysqlMigrations.length) throw new MysqlMigrationError();
    await assertIndexesCurrent(connection, database);
    const lock = await executeRows(connection, "SELECT id FROM crm_app_lock ORDER BY id");
    if (lock.length !== 1) throw new MysqlMigrationError();
    scalarNumber(lock[0]?.id);
  } catch { throw new MysqlMigrationError(); }
}

/**
 * Explicit additive migration operation only. MySQL DDL implicitly commits:
 * 'applying' is committed BEFORE DDL and a failure stays blocked for investigation.
 * This function never pretends a failed DDL batch was rolled back or resumes one.
 * Caller must establish an approved schema/account and recovery procedure first.
 */
export async function migrateMysqlApplicationSchema(connection: MysqlMigrationSession,
  options: { database: string; allowSchemaChanges: true }): Promise<number> {
  if (!options || options.allowSchemaChanges !== true || !approvedDatabase(options.database)
    || systemSchemas.has(options.database.toLowerCase())) throw new MysqlMigrationError();
  let acquired = false, failed = false, appliedCount = 0;
  let stage = "identity", failureCode: string | undefined;
  const lockName = "crm-migrate:" + createHash("sha256").update(options.database).digest("hex").slice(0, 48);
  try {
    const database = await identity(connection, options.database);
    const locked = await executeRows(connection, "SELECT GET_LOCK(?, 5) AS acquired", [lockName]);
    if (locked.length !== 1) throw new MysqlMigrationError();
    scalarNumber(locked[0]?.acquired); acquired = true;
    const objects = await inventory(connection, database);
    stage = "ledger";
    if (!objects.tables.includes(ledger)) {
      if (objects.tables.length || objects.triggers.length || objects.routines.length || objects.events.length) throw new MysqlMigrationError();
      await connection.query(`CREATE TABLE ${ledger} (
        version INT NOT NULL PRIMARY KEY, name VARCHAR(120) NOT NULL, checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        state VARCHAR(16) NOT NULL CHECK (state IN ('applying','completed')),
        started_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), completed_at TIMESTAMP(3) NULL
      ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    }
    const applied = await history(connection);
    if (applied.length === mysqlMigrations.length) {
      assertObjectsCurrent(objects);
    }
    // An empty ledger accompanied by objects cannot be accepted after interrupted DDL.
    if (applied.length === 0 && (objects.tables.some((name) => name !== ledger) || objects.triggers.length
      || objects.routines.length || objects.events.length)) throw new MysqlMigrationError();
    for (const migration of mysqlMigrations.slice(applied.length)) {
      await connection.execute(`INSERT INTO ${ledger}(version,name,checksum,state) VALUES(?,?,?,'applying')`,
        [migration.version, migration.name, migration.checksum]);
      for (const [index, statement] of migration.statements.entries()) {
        stage = `migration-${migration.version}-statement-${index + 1}`;
        await connection.query(statement);
      }
      stage = "schema-inventory";
      assertObjectsCurrent(await inventory(connection, database));
      const [result] = await connection.execute(`UPDATE ${ledger} SET state='completed',completed_at=CURRENT_TIMESTAMP(3)
        WHERE version=? AND checksum=? AND state='applying'`, [migration.version, migration.checksum]);
      if (!result || typeof result !== "object" || !("affectedRows" in result) || result.affectedRows !== 1) throw new MysqlMigrationError();
    }
    stage = "final-schema-check";
    await assertMysqlMigrationsCurrent(connection, database);
    appliedCount = mysqlMigrations.length - applied.length;
  } catch (error) {
    failed = true;
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^ER_[A-Z0-9_]{1,60}$/.test(error.code)) failureCode = error.code;
  }
  finally {
    if (acquired) {
      try {
        const released = await executeRows(connection, "SELECT RELEASE_LOCK(?) AS released", [lockName]);
        if (released.length !== 1 || (released[0]?.released !== 1 && released[0]?.released !== "1")) failed = true;
      } catch { failed = true; }
    }
  }
  if (failed) throw new MysqlMigrationError(stage, failureCode);
  return appliedCount;
}
