import type { MysqlWireConnection } from "../../src/crm/db/mysql/driver.js";
import { mysqlRuntimePrivileges } from "../../src/crm/db/mysql/runtime-privileges.js";

/** Administrative preparation helpers. Importing this module opens nothing. The
 * caller must validate approval, pinned controller/target and private ownership
 * before supplying its existing operator connection. No rollback/DROP is used to
 * disguise MySQL DDL's implicit commits; partial targets are always retained.
 */
export interface HarnessTarget {
  database: string;
  runtimeUser: string;
  migrationUser: string;
  fixtureUser: string;
}
export class HarnessObserverError extends Error {
  constructor() { super("Isolated MySQL preflight refused; retain the target and review private evidence."); }
}
type Row = Record<string, unknown>;
const globalColumns = ["Select_priv", "Insert_priv", "Update_priv", "Delete_priv", "Create_priv", "Drop_priv",
  "Reload_priv", "Shutdown_priv", "Process_priv", "File_priv", "Grant_priv", "References_priv", "Index_priv", "Alter_priv",
  "Show_db_priv", "Super_priv", "Create_tmp_table_priv", "Lock_tables_priv", "Execute_priv", "Repl_slave_priv", "Repl_client_priv",
  "Create_view_priv", "Show_view_priv", "Create_routine_priv", "Alter_routine_priv", "Create_user_priv", "Event_priv",
  "Trigger_priv", "Create_tablespace_priv", "Create_role_priv", "Drop_role_priv"] as const;
const schemaColumns = ["Select_priv", "Insert_priv", "Update_priv", "Delete_priv", "Create_priv", "Drop_priv", "Grant_priv",
  "References_priv", "Index_priv", "Alter_priv", "Create_tmp_table_priv", "Lock_tables_priv", "Create_view_priv", "Show_view_priv",
  "Create_routine_priv", "Alter_routine_priv", "Execute_priv", "Event_priv", "Trigger_priv"] as const;
const migrationPrivileges = ["SELECT", "INSERT", "UPDATE", "CREATE", "ALTER", "REFERENCES", "TRIGGER"] as const;
const fixturePrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
const retainedProvisioning = new WeakMap<MysqlWireConnection, { target: string; uuid: string; provisioned: boolean; runtimeGranted: boolean }>();
function fail(): never { throw new HarnessObserverError(); }
function rowList(value: unknown): Row[] {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object" || Array.isArray(row))) fail();
  return value as Row[];
}
async function rows(connection: MysqlWireConnection, sql: string, values: readonly unknown[] = []) {
  return rowList((await connection.execute(sql, values))[0]);
}
function only(values: Row[]): Row { if (values.length !== 1 || !values[0]) fail(); return values[0]; }
function same(actual: readonly string[], expected: readonly string[]) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) fail();
}
function validTarget(target: HarnessTarget): string {
  if (!target || typeof target.database !== "string") fail();
  const match = /^crm_local_crm_([a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15})$/u.exec(target.database);
  if (!match || target.runtimeUser !== `crm_r_${match[1]!.slice(0, 24)}`
    || target.migrationUser !== `crm_m_${match[1]!.slice(0, 24)}` || target.fixtureUser !== `crm_f_${match[1]!.slice(0, 24)}`) fail();
  return JSON.stringify([target.database, target.runtimeUser, target.migrationUser, target.fixtureUser]);
}
function snapshotTarget(target: HarnessTarget): HarnessTarget {
  if (!target || typeof target !== "object") fail();
  const copy = { database: target.database, runtimeUser: target.runtimeUser, migrationUser: target.migrationUser, fixtureUser: target.fixtureUser };
  validTarget(copy);
  return Object.freeze(copy);
}
function validDatabase(database: string) {
  if (!/^crm_local_crm_[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u.test(database)) fail();
}
function account(user: string) {
  if (!/^crm_[rmf]_[a-f0-9]{24}$/u.test(user)) fail();
  return `'${user}'@'127.0.0.1'`;
}
function flags(row: Row, columns: readonly string[], expected: readonly string[]) {
  const present: string[] = [];
  for (const column of columns) {
    if (row[column] !== "Y" && row[column] !== "N") fail();
    if (row[column] === "Y") present.push(column.slice(0, -5).toUpperCase());
  }
  same(present, expected);
}
function privilegeSet(value: unknown): string[] {
  if (typeof value !== "string") fail();
  return value === "" ? [] : value.split(",").map(part => part.trim().toUpperCase());
}
async function noRows(connection: MysqlWireConnection, sql: string, values: readonly unknown[]) {
  if ((await rows(connection, sql, values)).length !== 0) fail();
}

/** Root is the pre-existing controller's operator, never an application account.
 * Its global authority is inspected, not created/granted. TCP stays pinned by the
 * caller to 127.0.0.1; the controller's documented CURRENT_USER is root@localhost.
 * This function returns no credentials, grants, row values or private paths.
 */
export async function observeOperator(connection: MysqlWireConnection, expectedUser: string): Promise<{ serverUuid: string }> {
  try {
    if (expectedUser !== "root") fail();
    const value = only(await rows(connection, `SELECT DATABASE() AS selectedDatabase,CURRENT_USER() AS identity,
      CURRENT_ROLE() AS activeRoles,@@global.mandatory_roles AS mandatoryRoles,VERSION() AS version,
      @@version_comment AS family,@@server_uuid AS uuid,@@port AS port,@@global.partial_revokes AS partialRevokes,
      @@global.general_log AS generalLog,@@global.slow_query_log AS slowLog,@@global.log_bin AS binaryLog,
      @@session.autocommit AS autocommit,@@session.foreign_key_checks AS foreignKeyChecks,@@session.unique_checks AS uniqueChecks`));
    if (value.selectedDatabase !== "crm_local_dev" || value.identity !== "root@localhost" || value.activeRoles !== "NONE"
      || value.mandatoryRoles !== "" || value.version !== "8.4.11" || String(value.port) !== "3308"
      || !["MySQL Community Server - GPL", "MySQL Enterprise Server - Commercial"].includes(String(value.family))
      || typeof value.uuid !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.uuid)
      || ["partialRevokes", "autocommit", "foreignKeyChecks", "uniqueChecks"].some(key => String(value[key]) !== "1")
      || ["generalLog", "slowLog", "binaryLog"].some(key => String(value[key]) !== "0")) fail();
    const operator = only(await rows(connection, `SELECT User,Host,${globalColumns.join(",")},account_locked
      FROM mysql.user WHERE User=? AND Host=?`, [expectedUser, "localhost"]));
    if (operator.User !== "root" || operator.Host !== "localhost" || operator.account_locked !== "N"
      || globalColumns.some(column => operator[column] !== "Y" && operator[column] !== "N")) fail();
    // Existing authority sufficient for the exact new-schema/new-account grants.
    for (const name of ["Select", "Insert", "Update", "Delete", "Create", "References", "Trigger", "Create_user", "Grant"]) {
      if (operator[`${name}_priv`] !== "Y") fail();
    }
    await noRows(connection, "SELECT TO_USER FROM mysql.role_edges WHERE TO_USER=? AND TO_HOST=?", [expectedUser, "localhost"]);
    await noRows(connection, "SELECT USER FROM mysql.default_roles WHERE USER=? AND HOST=?", [expectedUser, "localhost"]);
    return { serverUuid: value.uuid };
  } catch { throw new HarnessObserverError(); }
}

async function objectInventoryEmpty(connection: MysqlWireConnection, database: string) {
  for (const [table, field] of [["TABLES", "TABLE_SCHEMA"], ["TRIGGERS", "TRIGGER_SCHEMA"], ["ROUTINES", "ROUTINE_SCHEMA"], ["EVENTS", "EVENT_SCHEMA"]]) {
    // Select constant metadata only: no business rows or stored routine bodies.
    await noRows(connection, `SELECT 1 AS present FROM information_schema.${table} WHERE ${field}=?`, [database]);
  }
}
export async function assertTargetAbsent(connection: MysqlWireConnection, target: HarnessTarget): Promise<void> {
  try {
    target = snapshotTarget(target);
    await observeOperator(connection, "root");
    await noRows(connection, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [target.database]);
    await objectInventoryEmpty(connection, target.database);
    for (const user of [target.runtimeUser, target.migrationUser, target.fixtureUser]) {
      // All host variants must be absent, not merely the requested 127.0.0.1 row.
      await noRows(connection, "SELECT User,Host FROM mysql.user WHERE User=?", [user]);
    }
  } catch { throw new HarnessObserverError(); }
}

export async function assertEmptySchema(connection: MysqlWireConnection, database: string): Promise<void> {
  try {
    validDatabase(database);
    await observeOperator(connection, "root");
    const schema = only(await rows(connection, `SELECT SCHEMA_NAME,DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME
      FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?`, [database]));
    if (schema.SCHEMA_NAME !== database || schema.DEFAULT_CHARACTER_SET_NAME !== "utf8mb4" || schema.DEFAULT_COLLATION_NAME !== "utf8mb4_0900_bin") fail();
    await objectInventoryEmpty(connection, database);
  } catch { throw new HarnessObserverError(); }
}

/** Additive DDL only, after caller approval. Generated secrets use an exact
 * 64-character base64url alphabet, excluding quotes/backslashes regardless of
 * SQL mode. Account DDL uses text protocol (not all account DDL is preparable).
 * Never retain/log the generated SQL. Failure retains every completed DDL step.
 */
export async function provisionTarget(connection: MysqlWireConnection, target: HarnessTarget,
  passwords: { runtime: string; migration: string; fixture: string }): Promise<void> {
  try {
    target = snapshotTarget(target);
    const key = validTarget(target);
    if (retainedProvisioning.has(connection) || !passwords || Object.keys(passwords).sort().join(",") !== "fixture,migration,runtime") fail();
    // Capture inputs before the first await so caller mutation cannot replace an
    // already validated identifier/secret while asynchronous inspection runs.
    const secrets = Object.freeze({ runtime: passwords.runtime, migration: passwords.migration, fixture: passwords.fixture });
    if (Object.values(secrets).some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{64}$/u.test(value))
      || new Set(Object.values(secrets)).size !== 3) fail();
    await assertTargetAbsent(connection, target);
    const observed = await observeOperator(connection, "root");
    // Track attempted ownership before first DDL: partial execution cannot retry.
    const ownership = { target: key, uuid: observed.serverUuid, provisioned: false, runtimeGranted: false };
    retainedProvisioning.set(connection, ownership);
    await connection.query(`CREATE DATABASE \`${target.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    for (const [user, password] of [[target.runtimeUser, secrets.runtime], [target.migrationUser, secrets.migration], [target.fixtureUser, secrets.fixture]]) {
      await connection.query(`CREATE USER ${account(user!)} IDENTIFIED WITH caching_sha2_password BY '${password}'`);
    }
    await connection.query(`GRANT ${migrationPrivileges.join(",")} ON \`${target.database}\`.* TO ${account(target.migrationUser)}`);
    await connection.query(`GRANT ${fixturePrivileges.join(",")} ON \`${target.database}\`.* TO ${account(target.fixtureUser)}`);
    await assertEmptySchema(connection, target.database);
    await assertScopedAccounts(connection, target, "provisioned");
    ownership.provisioned = true;
  } catch { throw new HarnessObserverError(); }
}

/** Only the same invocation's newly created target can receive runtime grants,
 * after a separate approved migration has created the reviewed full CRM tables. */
export async function grantRuntimePrivileges(connection: MysqlWireConnection, target: HarnessTarget): Promise<void> {
  try {
    target = snapshotTarget(target);
    const key = validTarget(target), own = retainedProvisioning.get(connection);
    if (!own || own.target !== key || !own.provisioned || own.runtimeGranted) fail();
    if ((await observeOperator(connection, "root")).serverUuid !== own.uuid) fail();
    await assertScopedAccounts(connection, target, "provisioned");
    const tables = await rows(connection, "SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=?", [target.database]);
    for (const table of Object.keys(mysqlRuntimePrivileges)) {
      const matches = tables.filter(row => row.TABLE_NAME === table);
      if (matches.length !== 1 || matches[0]?.TABLE_TYPE !== "BASE TABLE") fail();
    }
    own.runtimeGranted = true; // An uncertain/partial GRANT must never be retried.
    for (const [table, privileges] of Object.entries(mysqlRuntimePrivileges)) {
      await connection.query(`GRANT ${privileges.join(",")} ON \`${target.database}\`.\`${table}\` TO ${account(target.runtimeUser)}`);
    }
    await assertScopedAccounts(connection, target, "ready");
  } catch { throw new HarnessObserverError(); }
}

/** Complete administrative grant inventory. SHOW GRANTS under the restricted
 * runtime identity alone cannot establish absence of hidden privilege paths.
 * No authentication_string, password, row bodies or grants are returned/logged.
 */
export async function assertScopedAccounts(connection: MysqlWireConnection, target: HarnessTarget,
  stage: "provisioned" | "ready" = "ready"): Promise<void> {
  try {
    target = snapshotTarget(target);
    if (stage !== "provisioned" && stage !== "ready") fail();
    await observeOperator(connection, "root");
    for (const [kind, user] of [["runtime", target.runtimeUser], ["migration", target.migrationUser], ["fixture", target.fixtureUser]]) {
      const scoped = only(await rows(connection, `SELECT User,Host,${globalColumns.join(",")},plugin,account_locked,password_expired,
        JSON_CONTAINS_PATH(COALESCE(User_attributes,JSON_OBJECT()),'one','$.Restrictions') AS hasRestrictions
        FROM mysql.user WHERE User=?`, [user]));
      if (scoped.User !== user || scoped.Host !== "127.0.0.1" || scoped.plugin !== "caching_sha2_password"
        || scoped.account_locked !== "N" || scoped.password_expired !== "N" || String(scoped.hasRestrictions) !== "0") fail();
      flags(scoped, globalColumns, []);
      const values = [user, "127.0.0.1"];
      const forbidden: [string, readonly unknown[]][] = [
        ["SELECT USER FROM mysql.global_grants WHERE USER=? AND HOST=?", values],
        ["SELECT User FROM mysql.proxies_priv WHERE (User=? AND Host=?) OR (Proxied_user=? AND Proxied_host=?)", [...values, ...values]],
        ["SELECT TO_USER FROM mysql.role_edges WHERE (TO_USER=? AND TO_HOST=?) OR (FROM_USER=? AND FROM_HOST=?)", [...values, ...values]],
        ["SELECT USER FROM mysql.default_roles WHERE (USER=? AND HOST=?) OR (DEFAULT_ROLE_USER=? AND DEFAULT_ROLE_HOST=?)", [...values, ...values]],
        ["SELECT User FROM mysql.columns_priv WHERE User=? AND Host=?", values],
        ["SELECT User FROM mysql.procs_priv WHERE User=? AND Host=?", values],
      ];
      for (const [sql, params] of forbidden) await noRows(connection, sql, params);
      const schema = await rows(connection, `SELECT Db,${schemaColumns.join(",")} FROM mysql.db WHERE User=? AND Host=?`, values);
      const tables = await rows(connection, "SELECT Db,Table_name,Table_priv,Column_priv FROM mysql.tables_priv WHERE User=? AND Host=?", values);
      if (kind === "runtime") {
        if (schema.length !== 0) fail();
        const expected = stage === "ready" ? Object.keys(mysqlRuntimePrivileges) : [];
        if (tables.length !== expected.length) fail();
        for (const table of expected) {
          const grant = only(tables.filter(row => row.Table_name === table));
          if (grant.Db !== target.database || grant.Column_priv !== "") fail();
          same(privilegeSet(grant.Table_priv), mysqlRuntimePrivileges[table]!);
        }
      } else {
        if (tables.length !== 0) fail();
        const grant = only(schema);
        if (grant.Db !== target.database) fail();
        flags(grant, schemaColumns, kind === "migration" ? migrationPrivileges : fixturePrivileges);
      }
    }
  } catch { throw new HarnessObserverError(); }
}
