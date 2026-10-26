import { hash } from "bcryptjs";
import { z } from "zod";
import { PERMISSION_KEYS } from "../auth/permissions.js";
import { mysqlExpectedTables } from "../crm/db/mysql/schema.js";
import { createCrmRuntime } from "./composition.js";
import { assertValidatedRuntimeConfiguration, type RuntimeConfiguration } from "./configuration.js";

export const nativeAdminRequestPath = ".local-data/operators/native-admin-bootstrap.json";
export const administratorPermissions = Object.freeze(PERMISSION_KEYS.filter(key => key !== "leads.manage.agents"));
const requestSchema = z.object({
  version: z.literal(1), requestId: z.uuid(),
  reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$/),
  target: z.object({ database: z.string(), serverUuid: z.string() }).strict(),
  administrator: z.object({
    name: z.string().trim().min(1).max(120).refine(value => !/[\r\n\0]/.test(value)),
    email: z.email().max(254).transform(value => value.toLowerCase()),
    password: z.string().min(12).max(72).refine(value => Array.from(value).length >= 12
      && Buffer.byteLength(value, "utf8") <= 72 && !/[\r\n\0]/.test(value)),
  }).strict(),
}).strict();
export class NativeAdminBootstrapError extends Error {
  constructor(readonly code: "CONFIGURATION" | "NOT_EMPTY" | "DATABASE") {
    super("Native administrator bootstrap refused; no fallback or automatic retry was attempted.");
  }
}
export function validateNativeAdminRequest(config: RuntimeConfiguration, input: unknown) {
  try {
    assertValidatedRuntimeConfiguration(config);
    const request = requestSchema.parse(input);
    if (request.target.database !== config.mysql.database || request.target.serverUuid !== config.serverUuid) throw new Error();
    return request;
  } catch { throw new NativeAdminBootstrapError("CONFIGURATION"); }
}
const emptyApplicationSql = mysqlExpectedTables.filter(table => table !== "crm_app_lock")
  .map(table => `SELECT '${table}' AS tableName,COUNT(*) AS total FROM \`${table}\``).join(" UNION ALL ");
function requireEmpty(value: unknown) {
  if (!Array.isArray(value) || value.length !== mysqlExpectedTables.length - 1
    || value.some((row, index) => row.tableName !== mysqlExpectedTables.filter(table => table !== "crm_app_lock")[index]
      || String(row.total) !== "0")) throw new NativeAdminBootstrapError("NOT_EMPTY");
}
function inserted(value: unknown): string {
  const packet = value as { affectedRows?: unknown; warningStatus?: unknown; insertId?: unknown } | null;
  if (!packet || packet.affectedRows !== 1 || packet.warningStatus !== 0) throw new NativeAdminBootstrapError("DATABASE");
  const id = String(packet.insertId ?? 0);
  if (!/^(0|[1-9][0-9]{0,18})$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n) throw new NativeAdminBootstrapError("DATABASE");
  return id;
}
type Runtime = Pick<ReturnType<typeof createCrmRuntime>, "database" | "close">;

/** Explicit first-login provisioning only. The normal runtime verifies identity,
 * exact DML grants and current native migrations on the owned connection. There
 * is no DDL, imported identity, role bypass, default credential or startup hook. */
export async function bootstrapNativeAdministrator(config: RuntimeConfiguration, input: unknown, mode: "check" | "apply",
  createRuntime: (config: RuntimeConfiguration) => Runtime = createCrmRuntime) {
  const request = validateNativeAdminRequest(config, input);
  if (mode !== "check" && mode !== "apply") throw new NativeAdminBootstrapError("CONFIGURATION");
  let runtime: Runtime | undefined;
  const execute = async () => {
    runtime = createRuntime(config);
    if (mode === "check") {
      // One verified lease; SELECT only, without session/auth/audit writes.
      requireEmpty(await runtime.database.prepare(emptyApplicationSql).all());
      return { status: "EMPTY_NATIVE_READY" as const, databaseWrites: 0 };
    }
    const passwordHash = await hash(request.administrator.password, 12);
    // authTransaction uses the same global crm_app_lock as every application
    // transaction, rolls back known failures and destroys ambiguous commits.
    return await runtime.database.authTransaction(async connection => {
      requireEmpty((await connection.execute(emptyApplicationSql))[0]);
      const userId = inserted((await connection.execute("INSERT INTO users(username,email,password,status) VALUES(?,?,?,'active')",
        [request.administrator.name, request.administrator.email, passwordHash]))[0]);
      if (userId === "0") throw new NativeAdminBootstrapError("DATABASE");
      const groupId = inserted((await connection.execute("INSERT INTO permission_groups(`key`,label,sort_order) VALUES('crm','CRM permissions',0)"))[0]);
      if (groupId === "0") throw new NativeAdminBootstrapError("DATABASE");
      for (const key of PERMISSION_KEYS) {
        const permissionId = inserted((await connection.execute("INSERT INTO permissions(`key`,label,group_id) VALUES(?,?,?)", [key, key, groupId]))[0]);
        if (permissionId === "0") throw new NativeAdminBootstrapError("DATABASE");
        if (administratorPermissions.includes(key as typeof administratorPermissions[number])) inserted((await connection.execute(
          "INSERT INTO admin_user_permissions(admin_user_id,permission_id) VALUES(?,?)", [userId, permissionId]))[0]);
      }
      inserted((await connection.execute("INSERT INTO crm_audit_events(actor_user_id,target_type,target_id,action,changed_fields) VALUES(?,'users',?,'users.create',?)",
        [userId, userId, JSON.stringify(["name", "email", "password", "status", "permissions"])]))[0]);
      return { status: "ADMINISTRATOR_CREATED" as const, userId, permissionCount: PERMISSION_KEYS.length, grantedPermissions: administratorPermissions.length };
    });
  };
  try {
    const result = await execute();
    await runtime!.close();
    return result;
  } catch (error) {
    try { await runtime?.close(); } catch { /* preserve a safe operation failure */ }
    if (error instanceof NativeAdminBootstrapError) throw error;
    throw new NativeAdminBootstrapError("DATABASE");
  }
}
