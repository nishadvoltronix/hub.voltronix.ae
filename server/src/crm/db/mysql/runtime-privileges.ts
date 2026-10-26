import type { MysqlMigrationSession } from "./migrations.js";

// Source-reviewed application SQL only. Migration/fixture operators use separate
// identities; do not expand this map to make operator work run as the application.
export const mysqlRuntimePrivileges: Readonly<Record<string, readonly string[]>> = Object.freeze({
  users: ["SELECT", "INSERT", "UPDATE"],
  permission_groups: ["SELECT", "INSERT", "UPDATE"],
  permissions: ["SELECT", "INSERT", "UPDATE"],
  admin_user_permissions: ["SELECT", "INSERT", "DELETE"],
  tasks: ["SELECT", "INSERT", "UPDATE"],
  departments_assign: ["SELECT", "INSERT", "UPDATE"],
  crm_sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  crm_login_attempts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  crm_audit_events: ["SELECT", "INSERT"],
  job_notes: ["SELECT", "INSERT", "UPDATE"],
  tasks_status_log: ["SELECT", "INSERT"],
  accounts: ["SELECT", "INSERT"],
  crm_job_audit_events: ["SELECT", "INSERT"],
  crm_lead_operations: ["SELECT", "INSERT", "UPDATE"],
  crm_lead_audit_events: ["SELECT", "INSERT"],
  crm_department_work_logs: ["SELECT", "INSERT"],
  crm_department_audit_events: ["SELECT", "INSERT"],
  task_attachment: ["SELECT", "INSERT"],
  crm_attachment_audit_events: ["SELECT", "INSERT"],
  products: ["SELECT", "INSERT", "UPDATE"],
  crm_quotations: ["SELECT", "INSERT", "UPDATE"],
  proposal_items: ["SELECT", "INSERT", "DELETE"],
  crm_commercial_operations: ["SELECT", "INSERT", "UPDATE"],
  crm_commercial_audit_events: ["SELECT", "INSERT"],
  crm_department_log_attachments: ["SELECT", "INSERT"],
  crm_department_log_attachment_audit_events: ["SELECT", "INSERT"],
  crm_local_tasks: ["SELECT", "INSERT"],
  crm_local_notes: ["SELECT", "INSERT", "UPDATE"],
  crm_local_operations: ["SELECT", "INSERT"],
  crm_local_audit: ["SELECT", "INSERT"],
  crm_percentage_quotations: ["SELECT", "INSERT", "UPDATE"],
  crm_zoho_quotations: ["SELECT", "INSERT", "UPDATE"],
  crm_zoho_quotation_items: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  crm_zoho_user_bindings: ["SELECT", "INSERT"],
  crm_zoho_user_binding_audit: ["SELECT", "INSERT"],
  crm_zoho_sync_source: ["SELECT", "INSERT", "UPDATE"],
  crm_zoho_sync_runs: ["SELECT", "INSERT"],
  crm_zoho_sync_records: ["SELECT", "INSERT", "UPDATE"],
  crm_zoho_sync_events: ["SELECT", "INSERT"],
  crm_zoho_inbound_quotations: ["SELECT", "INSERT", "UPDATE"],
  // Actual 8.4.11 rejects SELECT ... FOR UPDATE with SELECT alone. UPDATE is
  // required for the lock statement; application code never changes this row.
  crm_app_lock: ["SELECT", "UPDATE"],
  crm_mysql_schema_migrations: ["SELECT"],
});
for (const permissions of Object.values(mysqlRuntimePrivileges)) Object.freeze(permissions);

export class MysqlRuntimePrivilegeError extends Error {
  constructor() { super("MySQL runtime identity does not match the reviewed local privilege contract. No grant changes were made."); }
}

function rows(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result) || result.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new MysqlRuntimePrivilegeError();
  return result;
}

/** Read-only exact direct-grant verification. It never logs account/grant values.
 * SHOW GRANTS also exposes assigned roles and dynamic/global/routine privileges;
 * reject every statement outside the exact table-DML contract, not merely the
 * active role. Operator-side checks independently inspect system grant tables.
 */
export async function assertMysqlRuntimePrivileges(connection: MysqlMigrationSession, database: string, expectedPort = 3308): Promise<void> {
  try {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(database) || ![3306, 3308].includes(expectedPort)) throw new MysqlRuntimePrivilegeError();
    const identity = rows((await connection.query(`SELECT DATABASE() AS selectedDatabase,CURRENT_USER() AS identity,
      CURRENT_ROLE() AS activeRoles,@@global.mandatory_roles AS mandatoryRoles,
      VERSION() AS version,@@version_comment AS family,@@port AS port`))[0]);
    const value = identity[0];
    if (identity.length !== 1 || !value || value.selectedDatabase !== database || value.version !== "8.4.11"
      || typeof value.family !== "string" || !/mysql/iu.test(value.family) || /mariadb/iu.test(value.family)
      || String(value.port) !== String(expectedPort) || value.activeRoles !== "NONE" || value.mandatoryRoles !== ""
      || typeof value.identity !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}@127\.0\.0\.1$/u.test(value.identity)) throw new MysqlRuntimePrivilegeError();
    const user = value.identity.split("@")[0]!;
    const recipient = "`" + user + "`@`127.0.0.1`";
    const grants = rows((await connection.query("SHOW GRANTS"))[0]);
    const seen = new Set<string>();
    let usage = 0;
    for (const row of grants) {
      const fields = Object.values(row);
      if (fields.length !== 1 || typeof fields[0] !== "string" || fields[0].length > 4096) throw new MysqlRuntimePrivilegeError();
      const line = fields[0];
      if (line === "GRANT USAGE ON *.* TO " + recipient) { if (++usage > 1) throw new MysqlRuntimePrivilegeError(); continue; }
      const match = /^GRANT ([A-Z, ]+) ON `([a-z][a-z0-9_]*)`\.`([a-z][a-z0-9_]*)` TO (.+)$/u.exec(line);
      if (!match || match[2] !== database || match[4] !== recipient || seen.has(match[3]!)) throw new MysqlRuntimePrivilegeError();
      const expected = mysqlRuntimePrivileges[match[3]!];
      const actual = match[1]!.split(", ").sort();
      if (!expected || JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new MysqlRuntimePrivilegeError();
      seen.add(match[3]!);
    }
    if (seen.size !== Object.keys(mysqlRuntimePrivileges).length) throw new MysqlRuntimePrivilegeError();
  } catch { throw new MysqlRuntimePrivilegeError(); }
}
