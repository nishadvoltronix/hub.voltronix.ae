import { createHash } from "node:crypto";
import { mysqlApplicationSchemaStatements, mysqlExpectedIndexes, mysqlExpectedTables } from "./schema.js";
import { mysqlDepartmentAttachmentSchemaStatements, mysqlLocalWorkflowSchemaStatements } from "./workflow-schema.js";
import { mysqlZohoWorkflowSchemaStatements } from "./zoho-schema.js";
import { mysqlInboundSchemaStatements } from "./inbound-schema.js";

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
const checksum = (statements: readonly string[]) => createHash("sha256").update(JSON.stringify(statements)).digest("hex");
export const mysqlMigrations = [{
  version: 1,
  name: "mysql_application_foundation",
  statements: mysqlApplicationSchemaStatements,
  checksum: checksum(mysqlApplicationSchemaStatements),
}, {
  version: 2,
  name: "mysql_local_workflows_percentage_v2",
  statements: mysqlLocalWorkflowSchemaStatements,
  checksum: checksum(mysqlLocalWorkflowSchemaStatements),
}, {
  version: 3,
  name: "mysql_department_attachment_limits",
  statements: mysqlDepartmentAttachmentSchemaStatements,
  checksum: checksum(mysqlDepartmentAttachmentSchemaStatements),
}, {
  version: 4,
  name: "mysql_verified_zoho_v8_workflows",
  statements: mysqlZohoWorkflowSchemaStatements,
  checksum: checksum(mysqlZohoWorkflowSchemaStatements),
}, {
  version: 5,
  name: "mysql_zoho_inbound_sync",
  statements: mysqlInboundSchemaStatements,
  checksum: checksum(mysqlInboundSchemaStatements),
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
    @@version_comment AS versionComment, @@session.autocommit AS autocommit`);
  const row = result[0];
  if (result.length !== 1 || !row || typeof row.selectedDatabase !== "string"
    || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(row.selectedDatabase) || systemSchemas.has(row.selectedDatabase.toLowerCase())
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
function assertObjectsCurrent(objects: ObjectInventory, version: number = mysqlMigrations.length) {
  const statements = mysqlMigrations.slice(0, version).flatMap(migration => migration.statements);
  const tables = statements.flatMap(statement => /^CREATE TABLE ([a-z_]+) /u.exec(statement)?.[1] ?? []);
  const triggers = statements.flatMap(statement => /^CREATE TRIGGER ([a-z_]+) /u.exec(statement)?.[1] ?? []);
  if (!sameNames(objects.tables, [ledger, ...tables])
    || !sameNames(objects.triggers, triggers) || objects.routines.length || objects.events.length) throw new MysqlMigrationError();
}

async function assertIndexesCurrent(connection: MysqlMigrationSession, database: string, version: number = mysqlMigrations.length) {
  const indexes = await executeRows(connection,
    "SELECT TABLE_NAME AS tableName,INDEX_NAME AS name,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS position,COLUMN_NAME AS columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX", [database]);
  const tables = new Set(mysqlMigrations.slice(0, version).flatMap(migration => migration.statements)
    .flatMap(statement => /^CREATE TABLE ([a-z_]+) /u.exec(statement)?.[1] ?? []));
  for (const index of mysqlExpectedIndexes.filter(index => tables.has(index.table))) {
    const actual = indexes.filter((row) => row.tableName === index.table && row.name === index.name);
    if (actual.length !== index.columns.length || actual.some((row, position) => String(row.nonUnique) !== (index.unique ? "0" : "1")
      || String(row.position) !== String(position + 1) || row.columnName !== index.columns[position])) throw new MysqlMigrationError();
  }
}

/** The only changed v1 constraint is checked before ALTER and on every lease.
 * A renamed/weakened/unenforced constraint is not silently adopted or repaired. */
async function assertDepartmentAttachmentShape(connection: MysqlMigrationSession, database: string, upgraded: boolean) {
  const columns = await executeRows(connection, `SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='crm_department_log_attachments'
      AND COLUMN_NAME IN ('file_size','content') ORDER BY COLUMN_NAME`, [database]);
  if (columns.length !== 2 || !columns.some(row => row.name === "content" && row.type === (upgraded ? "longblob" : "mediumblob") && row.nullable === "NO")
    || !columns.some(row => row.name === "file_size" && row.type === "int" && row.nullable === "NO")) throw new MysqlMigrationError();
  const checks = await executeRows(connection, `SELECT tc.CONSTRAINT_NAME AS name,tc.ENFORCED AS enforced,cc.CHECK_CLAUSE AS expression
    FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
    WHERE tc.TABLE_SCHEMA=? AND tc.TABLE_NAME='crm_department_log_attachments' AND tc.CONSTRAINT_TYPE='CHECK'`, [database]);
  // Keep operator grouping: stripping all parentheses could accept a different
  // boolean expression that merely shares the same token sequence.
  const compact = (value: unknown) => typeof value === "string" ? value.toLowerCase().replace(/[\s\x60]/gu, "") : "";
  const limit = upgraded ? 52428800 : 16384000;
  const sizeExpressions = [`file_size>0andfile_size<=${limit}`, `(file_size>0andfile_size<=${limit})`,
    `(file_size>0)and(file_size<=${limit})`, `((file_size>0)and(file_size<=${limit}))`];
  // Oracle MySQL canonicalizes OCTET_LENGTH to its byte-length synonym LENGTH
  // in CHECK_CLAUSE. CHAR_LENGTH is deliberately excluded: it counts characters.
  const lengthExpressions = ["octet_length", "length"].flatMap(name => [
    `${name}(content)=file_size`, `(${name}(content)=file_size)`,
  ]);
  if (checks.length !== 2 || !checks.some(row => row.name === (upgraded ? "crm_log_attachment_size_v3" : "crm_department_log_attachments_chk_1")
    && row.enforced === "YES" && sizeExpressions.includes(compact(row.expression)))
    || !checks.some(row => row.name === "crm_department_log_attachments_chk_2" && row.enforced === "YES"
      && lengthExpressions.includes(compact(row.expression)))) throw new MysqlMigrationError();
}

/** Preserve exact prior capacity before the additive v5 widening. Current
 * catalog names and either quotation lineage must retain the same full label. */
async function assertProductNameShape(connection:MysqlMigrationSession,database:string,version:number) {
  const columns=await executeRows(connection,`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,COLUMN_TYPE AS type,
    IS_NULLABLE AS nullable,COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?
    AND TABLE_NAME IN ('products','proposal_items','crm_zoho_quotation_items') AND COLUMN_NAME='product_name'`,[database]);
  const tables=version>=4?["products","proposal_items","crm_zoho_quotation_items"]:["products","proposal_items"];
  if(columns.length!==tables.length||tables.some(table=>!columns.some(row=>row.tableName===table&&row.name==="product_name"
    &&row.type===(version>=5?"varchar(255)":"varchar(200)")&&row.nullable==="NO"&&row.collation==="utf8mb4_0900_bin")))throw new MysqlMigrationError();
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
    await assertDepartmentAttachmentShape(connection, database, true);
    await assertProductNameShape(connection,database,mysqlMigrations.length);
    const lock = await executeRows(connection, "SELECT id FROM crm_app_lock ORDER BY id");
    if (lock.length !== 1) throw new MysqlMigrationError();
    scalarNumber(lock[0]?.id);
  } catch { throw new MysqlMigrationError(); }
}

/** Read-only operator inspection of empty, exact-prefix or current schemas.
 * Refuses unknown objects and interrupted/drifted ledgers; never adopts data.
 * Caller must first establish complete selected-schema metadata visibility. */
export async function inspectMysqlApplicationSchema(connection: MysqlMigrationSession, expectedDatabase: string): Promise<{ installed: number; pending: number }> {
  try {
    const database = await identity(connection, expectedDatabase), objects = await inventory(connection, database);
    if (!objects.tables.includes(ledger)) {
      if (objects.tables.length || objects.triggers.length || objects.routines.length || objects.events.length) throw new MysqlMigrationError();
      return { installed: 0, pending: mysqlMigrations.length };
    }
    const applied = await history(connection);
    assertObjectsCurrent(objects, applied.length);
    await assertIndexesCurrent(connection, database, applied.length);
    if (applied.length > 0) {
      await assertDepartmentAttachmentShape(connection, database, applied.length >= 3);
      await assertProductNameShape(connection,database,applied.length);
    }
    if (applied.length === mysqlMigrations.length) await assertMysqlMigrationsCurrent(connection, database);
    return { installed: applied.length, pending: mysqlMigrations.length - applied.length };
  } catch { throw new MysqlMigrationError("read-only-inspection"); }
}

/**
 * Explicit additive migration operation only. MySQL DDL implicitly commits:
 * 'applying' is committed BEFORE DDL and a failure stays blocked for investigation.
 * This function never pretends a failed DDL batch was rolled back or resumes one.
 * Caller must establish an approved schema/account and recovery procedure first.
 */
export async function migrateMysqlApplicationSchema(connection: MysqlMigrationSession,
  options: { database: string; allowSchemaChanges: true }): Promise<number> {
  if (!options || options.allowSchemaChanges !== true || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(options.database)
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
    if (applied.length > 0) {
      // Reject altered/extra/missing objects before extending an existing lineage.
      assertObjectsCurrent(objects, applied.length);
      await assertIndexesCurrent(connection, database, applied.length);
      await assertProductNameShape(connection,database,applied.length);
    }
    // An empty ledger accompanied by objects cannot be accepted after interrupted DDL.
    if (applied.length === 0 && (objects.tables.some((name) => name !== ledger) || objects.triggers.length
      || objects.routines.length || objects.events.length)) throw new MysqlMigrationError();
    for (const migration of mysqlMigrations.slice(applied.length)) {
      if (migration.version === 3) {
        stage = "department-attachment-preflight";
        await assertDepartmentAttachmentShape(connection, database, false);
      }
      if(migration.version===5) {
        stage="product-name-preflight";
        await assertProductNameShape(connection,database,4);
      }
      await connection.execute(`INSERT INTO ${ledger}(version,name,checksum,state) VALUES(?,?,?,'applying')`,
        [migration.version, migration.name, migration.checksum]);
      for (const [index, statement] of migration.statements.entries()) {
        stage = `migration-${migration.version}-statement-${index + 1}`;
        await connection.query(statement);
      }
      stage = "schema-inventory";
      assertObjectsCurrent(await inventory(connection, database), migration.version);
      if(migration.version===5)await assertProductNameShape(connection,database,5);
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
