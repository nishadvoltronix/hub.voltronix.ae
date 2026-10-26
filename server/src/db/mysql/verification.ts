import { validateMysqlAuthConfig, type MysqlAuthConfig } from "./config.js";
import { mysqlMigrations } from "./migrations.js";

/** Read-only metadata interface; neither this verifier nor importing it opens a socket. */
export interface MysqlAuthVerifyConnection {
  execute(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  query(sql: string): Promise<[unknown, unknown]>;
}

/** A dedicated auth identity. Existing broad Next.js runtime grants are not reused. */
export const mysqlAuthPrivileges: Readonly<Record<string, readonly string[]>> = Object.freeze({
  users: Object.freeze(["SELECT"]),
  permissions: Object.freeze(["SELECT"]),
  admin_user_permissions: Object.freeze(["SELECT"]),
  crm_sessions: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]),
  crm_login_attempts: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]),
  crm_app_lock: Object.freeze(["SELECT", "UPDATE"]),
  crm_mysql_schema_migrations: Object.freeze(["SELECT"]),
});

export class MysqlAuthReadinessError extends Error {
  constructor() { super("MySQL authentication is unavailable. No schema or privilege changes were performed."); }
}

type Row = Record<string, unknown>;
function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new MysqlAuthReadinessError();
  return value as Row[];
}
async function executeRows(connection: MysqlAuthVerifyConnection, sql: string, values: unknown[] = []) {
  return rows((await connection.execute(sql, values))[0]);
}
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new MysqlAuthReadinessError();
}
const tableNames = Object.keys(mysqlAuthPrivileges).sort();
const placeholders = tableNames.map(() => "?").join(",");

/** Only columns read/written by authentication or its schema guards. Other business
 * columns remain governed by the immutable v1 migration, not an invented auth fork.
 */
const expectedColumns: Record<string, Record<string, [string, boolean, string | null]>> = {
  users: {
    id: ["bigint", false, null], user_id: ["varchar(100)", true, "utf8mb4_0900_bin"],
    username: ["varchar(120)", false, "utf8mb4_0900_bin"], email: ["varchar(254)", false, "utf8mb4_0900_as_ci"],
    password: ["varchar(255)", false, "utf8mb4_0900_bin"], status: ["varchar(16)", false, "utf8mb4_0900_bin"],
  },
  permissions: { id: ["bigint", false, null], key: ["varchar(120)", false, "utf8mb4_0900_bin"] },
  admin_user_permissions: { id: ["bigint", false, null], admin_user_id: ["bigint", false, null], permission_id: ["bigint", false, null] },
  crm_sessions: {
    token_hash: ["char(64)", false, "ascii_bin"], user_id: ["bigint", false, null],
    csrf_hash: ["char(64)", false, "ascii_bin"], password_fingerprint: ["char(64)", false, "ascii_bin"],
    created_at: ["bigint", false, null], expires_at: ["bigint", false, null],
  },
  crm_login_attempts: { bucket: ["varchar(80)", false, "ascii_bin"], window_start: ["bigint", false, null], attempts: ["int", false, null] },
  crm_app_lock: { id: ["tinyint", false, null] },
  crm_mysql_schema_migrations: {
    version: ["int", false, null], name: ["varchar(120)", false, "utf8mb4_0900_bin"],
    checksum: ["char(64)", false, "ascii_bin"], state: ["varchar(16)", false, "utf8mb4_0900_bin"],
  },
};

const expectedIndexes: { table: string; columns: string[]; unique: boolean; name?: string }[] = [
  ...["users", "permissions", "admin_user_permissions", "crm_app_lock"].map(table => ({ table, columns: ["id"], unique: true, name: "PRIMARY" })),
  { table: "users", columns: ["email"], unique: true },
  { table: "users", columns: ["user_id"], unique: true },
  { table: "permissions", columns: ["key"], unique: true },
  { table: "admin_user_permissions", columns: ["admin_user_id", "permission_id"], unique: true },
  { table: "crm_sessions", columns: ["token_hash"], unique: true, name: "PRIMARY" },
  { table: "crm_sessions", columns: ["user_id"], unique: false, name: "idx_sessions_user" },
  { table: "crm_sessions", columns: ["expires_at"], unique: false, name: "idx_sessions_expiry" },
  { table: "crm_login_attempts", columns: ["bucket"], unique: true, name: "PRIMARY" },
  { table: "crm_login_attempts", columns: ["window_start"], unique: false, name: "idx_login_attempts_window" },
  { table: "crm_mysql_schema_migrations", columns: ["version"], unique: true, name: "PRIMARY" },
];

const expectedChecks: Record<string, readonly string[]> = {
  users: ["status in ('active','inactive')", "quote_access in (0,1)",
    "version >= 1 and version <= 9007199254740991", "grants_version >= 1 and grants_version <= 9007199254740991"],
  permissions: ["version >= 1 and version <= 9007199254740991"],
  admin_user_permissions: [],
  crm_sessions: ["created_at >= 0 and created_at <= 9007199254740991", "expires_at > created_at and expires_at <= 9007199254740991"],
  crm_login_attempts: ["window_start >= 0 and window_start <= 9007199254740991", "attempts >= 0"],
  crm_app_lock: ["id=1"],
  crm_mysql_schema_migrations: ["state in ('applying','completed')"],
};
// MySQL adds harmless identifier quoting, parentheses and charset introducers.
// These source constraints contain no OR/arithmetic; no general SQL equivalence is asserted.
function normalizeCheck(value: string): string {
  // Literal contents are data, including case, spaces, punctuation and escapes.
  // Never fold them together with SQL keywords/identifier formatting: for the
  // binary status/state columns that would hide a changed set of allowed values.
  const parts = value.split(/('(?:[^'\\]|\\.|'')*')/gu);
  return parts.map((part, index) => {
    if (index % 2 === 1) return part;
    if (part.includes("'")) throw new MysqlAuthReadinessError();
    const normalized = part.toLowerCase().replace(/[\s`()]/gu, "");
    return index < parts.length - 1 ? normalized.replace(/_(?:utf8mb4|ascii)$/u, "") : normalized;
  }).join("");
}

async function assertIdentityAndGrants(connection: MysqlAuthVerifyConnection, config: Readonly<MysqlAuthConfig>) {
  const identity = executeRows(connection, `SELECT DATABASE() AS selectedDatabase,CURRENT_USER() AS identity,
    CURRENT_ROLE() AS activeRoles,@@global.mandatory_roles AS mandatoryRoles,
    VERSION() AS version,@@version_comment AS family,@@port AS port,
    @@session.autocommit AS autocommit,@@session.foreign_key_checks AS foreignKeyChecks,@@session.unique_checks AS uniqueChecks`);
  const values = await identity, value = values[0];
  if (values.length !== 1 || !value || value.selectedDatabase !== config.database || value.identity !== `${config.user}@127.0.0.1`
    || value.activeRoles !== "NONE" || value.mandatoryRoles !== "" || value.version !== "8.4.11"
    || !["MySQL Community Server - GPL", "MySQL Enterprise Server - Commercial"].includes(String(value.family))
    || String(value.port) !== "3308" || String(value.autocommit) !== "1" || String(value.foreignKeyChecks) !== "1"
    || String(value.uniqueChecks) !== "1") throw new MysqlAuthReadinessError();
  const recipient = `\`${config.user}\`@\`127.0.0.1\``;
  const grants = rows((await connection.query("SHOW GRANTS"))[0]);
  const seen = new Set<string>(); let usage = 0;
  for (const row of grants) {
    const fields = Object.values(row);
    if (fields.length !== 1 || typeof fields[0] !== "string" || fields[0].length > 4096) throw new MysqlAuthReadinessError();
    const line = fields[0];
    if (line === `GRANT USAGE ON *.* TO ${recipient}`) { usage++; continue; }
    const match = /^GRANT ([A-Z, ]+) ON `([a-z][a-z0-9_]*)`\.`([a-z][a-z0-9_]*)` TO (.+)$/u.exec(line);
    if (!match || match[2] !== config.database || match[4] !== recipient || seen.has(match[3]!)) throw new MysqlAuthReadinessError();
    const expected = mysqlAuthPrivileges[match[3]!];
    if (!expected) throw new MysqlAuthReadinessError();
    equal(match[1]!.split(", ").sort(), [...expected].sort());
    seen.add(match[3]!);
  }
  if (usage !== 1 || seen.size !== tableNames.length) throw new MysqlAuthReadinessError();
}

async function assertSchema(connection: MysqlAuthVerifyConnection, database: string) {
  const values = [database, ...tableNames];
  const tables = await executeRows(connection, `SELECT TABLE_NAME AS name,TABLE_TYPE AS type,ENGINE AS engine,TABLE_COLLATION AS collation
    FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${placeholders}) ORDER BY TABLE_NAME`, values);
  equal(tables.map(row => row.name).sort(), tableNames);
  if (tables.some(row => row.type !== "BASE TABLE" || row.engine !== "InnoDB" || row.collation !== "utf8mb4_0900_bin")) throw new MysqlAuthReadinessError();
  const columns = await executeRows(connection, `SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,COLUMN_TYPE AS type,
    IS_NULLABLE AS nullable,COLLATION_NAME AS collation,EXTRA AS extra
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${placeholders}) ORDER BY TABLE_NAME,ORDINAL_POSITION`, values);
  for (const [table, fields] of Object.entries(expectedColumns)) for (const [name, [type, nullable, collation]] of Object.entries(fields)) {
    const matches = columns.filter(row => row.tableName === table && row.name === name);
    const column = matches[0];
    if (matches.length !== 1 || !column || column.type !== type || column.nullable !== (nullable ? "YES" : "NO")
      || column.collation !== collation || (column.extra !== "" && !(name === "id" && ["users", "permissions", "admin_user_permissions"].includes(table) && column.extra === "auto_increment"))) throw new MysqlAuthReadinessError();
  }
  const indexes = await executeRows(connection, `SELECT TABLE_NAME AS tableName,INDEX_NAME AS name,NON_UNIQUE AS nonUnique,
    SEQ_IN_INDEX AS position,COLUMN_NAME AS columnName,SUB_PART AS prefixLength,IS_VISIBLE AS visible,EXPRESSION AS expression,COLLATION AS direction
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${placeholders}) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`, values);
  for (const expected of expectedIndexes) {
    const candidates = [...new Set(indexes.filter(row => row.tableName === expected.table && (!expected.name || row.name === expected.name)).map(row => row.name))];
    if (!candidates.some(name => {
      const fields = indexes.filter(row => row.tableName === expected.table && row.name === name);
      return fields.length === expected.columns.length && fields.every((row, i) => row.columnName === expected.columns[i]
        && String(row.position) === String(i + 1) && String(row.nonUnique) === (expected.unique ? "0" : "1")
        && row.prefixLength === null && row.visible === "YES" && row.expression === null && row.direction === "A");
    })) throw new MysqlAuthReadinessError();
  }
  const foreignKeys = await executeRows(connection, `SELECT k.TABLE_NAME AS tableName,k.COLUMN_NAME AS columnName,k.ORDINAL_POSITION AS position,
    k.REFERENCED_TABLE_SCHEMA AS referencedSchema,k.REFERENCED_TABLE_NAME AS referencedTable,k.REFERENCED_COLUMN_NAME AS referencedColumn,
    r.DELETE_RULE AS deleteRule,r.UPDATE_RULE AS updateRule
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME IN (?,?) ORDER BY k.TABLE_NAME,k.COLUMN_NAME`, [database, "admin_user_permissions", "crm_sessions"]);
  const expectedForeignKeys = [
    ["admin_user_permissions", "admin_user_id", "users", "id"],
    ["admin_user_permissions", "permission_id", "permissions", "id"],
    ["crm_sessions", "user_id", "users", "id"],
  ];
  if (foreignKeys.length !== expectedForeignKeys.length) throw new MysqlAuthReadinessError();
  for (const [tableName, columnName, referencedTable, referencedColumn] of expectedForeignKeys) {
    const matches = foreignKeys.filter(row => row.tableName === tableName && row.columnName === columnName);
    const row = matches[0];
    if (matches.length !== 1 || !row || row.referencedSchema !== database || row.referencedTable !== referencedTable || row.referencedColumn !== referencedColumn
      || String(row.position) !== "1" || row.deleteRule !== "CASCADE" || !["NO ACTION", "RESTRICT"].includes(String(row.updateRule))) throw new MysqlAuthReadinessError();
  }
  const checks = await executeRows(connection, `SELECT t.TABLE_NAME AS tableName,t.ENFORCED AS enforced,c.CHECK_CLAUSE AS expression
    FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
    ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
    WHERE t.TABLE_SCHEMA=? AND t.TABLE_NAME IN (${placeholders}) AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.TABLE_NAME,t.CONSTRAINT_NAME`, values);
  if (checks.some(row => row.enforced !== "YES" || typeof row.expression !== "string" || typeof row.tableName !== "string" || !expectedChecks[row.tableName])) throw new MysqlAuthReadinessError();
  for (const [table, expected] of Object.entries(expectedChecks)) equal(
    checks.filter(row => row.tableName === table).map(row => normalizeCheck(row.expression as string)).sort(), expected.map(normalizeCheck).sort());
  const ledger = await executeRows(connection, "SELECT version,name,checksum,state FROM crm_mysql_schema_migrations ORDER BY version");
  equal(ledger.map(row => ({ version: String(row.version), name: row.name, checksum: row.checksum, state: row.state })),
    mysqlMigrations.map(row => ({ version: String(row.version), name: row.name, checksum: row.checksum, state: "completed" })));
  const lock = await executeRows(connection, "SELECT id FROM crm_app_lock ORDER BY id");
  if (lock.length !== 1 || String(lock[0]?.id) !== "1") throw new MysqlAuthReadinessError();
}

/** Must run on each exclusively owned connection before beginning its transaction.
 * Read-only, no schema repair/grant modification/import/seed or implicit migration.
 * Metadata visibility is intentionally limited: this is auth readiness, not full
 * application-schema or backup validation. Administrative DDL must be frozen while
 * serving; future live tests must prove these MySQL metadata/grant assumptions.
 */
export async function assertMysqlAuthReady(connection: MysqlAuthVerifyConnection, input: Readonly<MysqlAuthConfig>): Promise<void> {
  try {
    const config = validateMysqlAuthConfig(input);
    await assertIdentityAndGrants(connection, config);
    await assertSchema(connection, config.database);
  } catch { throw new MysqlAuthReadinessError(); }
}
