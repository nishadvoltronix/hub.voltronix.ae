import { z } from "zod";
import { validateLocalMysqlConfig, type LocalMysqlConfig } from "../crm/config/mysql.js";
import { connectMysql, type MysqlConnector, type MysqlWireConnection } from "../crm/db/mysql/driver.js";
import { inspectMysqlApplicationSchema, migrateMysqlApplicationSchema } from "../crm/db/mysql/migrations.js";

export const migrationProfilePath = ".local-data/operators/mysql-crm-migration.json";
export const migrationAcknowledgement = "--acknowledge-additive-mysql-ddl-and-retained-failures";
// Matches the existing isolated migration identity. No DROP, DELETE, grants,
// file access, global privileges, roles, provisioning or application-user reuse.
export const mysqlMigrationPrivileges = Object.freeze(["SELECT", "INSERT", "UPDATE", "CREATE", "ALTER", "REFERENCES", "TRIGGER"]);
const reference = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9 .:_/-]*$/);
const user = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/);
const profileSchema = z.object({
  version: z.literal(1),
  mysql: z.object({ provider: z.literal("mysql"), environment: z.literal("production"), host: z.literal("127.0.0.1"),
    port: z.union([z.literal(3306), z.literal(3308)]), database: z.string(), user, password: z.string() }).strict(),
  runtimeUser: user,
  approval: z.object({ approved: z.literal(true), reference, validFrom: z.iso.datetime(), validUntil: z.iso.datetime(),
    serverUuid: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    exclusiveOperatorWindow: z.literal(true), schemaChanges: z.literal(true), backupReference: reference, rollbackPlanReference: reference }).strict(),
}).strict();
export class MysqlOperatorError extends Error {
  constructor(readonly stage: "ARGUMENTS" | "CONFIGURATION" | "IDENTITY_PRIVILEGES" | "SCHEMA" | "MIGRATION" | "CONNECTION") {
    super(`MySQL operator command refused at ${stage}. No automatic provision, retry, import or rollback; preserve the target and review the approved private prerequisites.`);
    this.name = "MysqlOperatorError";
  }
}
export function parseMysqlOperatorArguments(arguments_: readonly string[]): "inspect" | "migrate" {
  if (arguments_.length === 1 && arguments_[0] === "inspect") return "inspect";
  if (arguments_.length === 2 && arguments_[0] === "migrate" && arguments_[1] === migrationAcknowledgement) return "migrate";
  throw new MysqlOperatorError("ARGUMENTS");
}
export interface MysqlOperatorProfile {
  readonly mysql: Readonly<LocalMysqlConfig>;
  readonly serverUuid: string;
  readonly validFrom: number;
  readonly validUntil: number;
}
export function validateMysqlOperatorProfile(input: unknown, now = Date.now()): MysqlOperatorProfile {
  try {
    const parsed = profileSchema.parse(input), mysql = validateLocalMysqlConfig(parsed.mysql);
    const validFrom = Date.parse(parsed.approval.validFrom), validUntil = Date.parse(parsed.approval.validUntil);
    // References record actual independent approval/backup evidence. This code
    // cannot establish that a restore rehearsal occurred merely from a string.
    if (parsed.runtimeUser === mysql.user || ["root", "mysql.sys", "mysql.session", "mysql.infoschema"].includes(parsed.runtimeUser.toLowerCase())
      || !Number.isFinite(now) || validFrom > now || validUntil <= now || validUntil - validFrom > 86_400_000) throw new Error();
    return Object.freeze({ mysql: Object.freeze(mysql), serverUuid: parsed.approval.serverUuid, validFrom, validUntil });
  } catch { throw new MysqlOperatorError("CONFIGURATION"); }
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error();
  return value;
}
/** Read-only independent server identity and exact direct schema rights. */
export async function verifyMysqlOperator(connection: MysqlWireConnection, profile: MysqlOperatorProfile): Promise<void> {
  try {
    const found = rows((await connection.query(`SELECT DATABASE() AS selectedDatabase,CURRENT_USER() AS identity,
      @@server_uuid AS serverUuid,VERSION() AS version,@@version_comment AS family,@@port AS port,
      CURRENT_ROLE() AS activeRoles,@@global.mandatory_roles AS mandatoryRoles,@@global.partial_revokes AS partialRevokes,
      @@global.log_bin AS binaryLog,@@global.log_bin_trust_function_creators AS trustedCreators,
      @@session.autocommit AS autocommit,@@session.foreign_key_checks AS foreignKeyChecks,@@session.unique_checks AS uniqueChecks`))[0]);
    const value = found[0], config = profile.mysql;
    if (found.length !== 1 || !value || value.selectedDatabase !== config.database || value.identity !== `${config.user}@127.0.0.1`
      || value.serverUuid !== profile.serverUuid || value.version !== "8.4.11" || String(value.port) !== String(config.port)
      || !["MySQL Community Server - GPL", "MySQL Enterprise Server - Commercial"].includes(String(value.family))
      || value.activeRoles !== "NONE" || value.mandatoryRoles !== ""
      || ["partialRevokes", "autocommit", "foreignKeyChecks", "uniqueChecks"].some(key => String(value[key]) !== "1")
      || !["0", "1"].includes(String(value.binaryLog))
      || (String(value.binaryLog) === "1" && String(value.trustedCreators) !== "1")) throw new Error();
    const recipient = `\`${config.user}\`@\`127.0.0.1\``, grants = rows((await connection.query("SHOW GRANTS"))[0]);
    let usage = 0, schema = 0;
    for (const grant of grants) {
      const fields = Object.values(grant);
      if (fields.length !== 1 || typeof fields[0] !== "string" || fields[0].length > 4096) throw new Error();
      const line = fields[0];
      if (line === "GRANT USAGE ON *.* TO " + recipient) { if (++usage > 1) throw new Error(); continue; }
      const match = /^GRANT ([A-Z, ]+) ON `([a-z][a-z0-9_]*)`\.\* TO (.+)$/.exec(line);
      if (!match || match[2] !== config.database || match[3] !== recipient || ++schema !== 1
        || JSON.stringify(match[1]!.split(", ").sort()) !== JSON.stringify([...mysqlMigrationPrivileges].sort())) throw new Error();
    }
    if (schema !== 1) throw new Error();
  } catch { throw new MysqlOperatorError("IDENTITY_PRIVILEGES"); }
}

/** Inert until explicitly invoked. No provisioning, env lookup, seeds or retry.
 * Production CLI uses real effects; injected effects are offline test doubles. */
export async function runMysqlOperator(arguments_: readonly string[], input: unknown, options: {
  connect?: MysqlConnector;
  now?: () => number;
  inspect?: typeof inspectMysqlApplicationSchema;
  migrate?: typeof migrateMysqlApplicationSchema;
} = {}) {
  const mode = parseMysqlOperatorArguments(arguments_), now = options.now ?? Date.now;
  const profile = validateMysqlOperatorProfile(input, now());
  const current = () => { if (now() < profile.validFrom || now() >= profile.validUntil) throw new MysqlOperatorError("CONFIGURATION"); };
  let connection: MysqlWireConnection | undefined, stage: ConstructorParameters<typeof MysqlOperatorError>[0] = "CONNECTION";
  let failure: MysqlOperatorError | undefined;
  let result: { status: string; installed: number; pending: number; migrationsApplied: number } | undefined;
  try {
    current(); connection = await (options.connect ?? connectMysql)(profile.mysql);
    const bounded: MysqlWireConnection = {
      query: sql => { current(); return connection!.query(sql); },
      execute: (sql, values) => { current(); return connection!.execute(sql, values); },
      beginTransaction: () => { throw new MysqlOperatorError("MIGRATION"); },
      commit: () => { throw new MysqlOperatorError("MIGRATION"); },
      rollback: () => { throw new MysqlOperatorError("MIGRATION"); },
      end: () => connection!.end(), destroy: () => connection!.destroy(),
    };
    stage = "IDENTITY_PRIVILEGES"; await verifyMysqlOperator(bounded, profile);
    stage = "SCHEMA";
    const before = await (options.inspect ?? inspectMysqlApplicationSchema)(bounded, profile.mysql.database);
    if (mode === "inspect") {
      result = { status: "PASS_READ_ONLY_TARGET_INSPECTION", installed: before.installed, pending: before.pending, migrationsApplied: 0 };
    } else {
      stage = "MIGRATION";
      const applied = await (options.migrate ?? migrateMysqlApplicationSchema)(bounded, { database: profile.mysql.database, allowSchemaChanges: true });
      stage = "SCHEMA";
      const after = await (options.inspect ?? inspectMysqlApplicationSchema)(bounded, profile.mysql.database);
      if (after.pending !== 0 || applied !== before.pending) throw new Error();
      result = { status: "PASS_EXPLICIT_MIGRATION", installed: after.installed, pending: after.pending, migrationsApplied: applied };
    }
  } catch { failure = new MysqlOperatorError(stage); }
  finally {
    if (connection) {
      try { await connection.end(); }
      catch {
        try { connection.destroy(); } catch { /* Driver detail must remain private. */ }
        failure ??= new MysqlOperatorError("CONNECTION");
      }
    }
  }
  if (failure) throw failure;
  if (!result) throw new MysqlOperatorError(stage);
  return result;
}
