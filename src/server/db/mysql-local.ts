import { createConnection, type ConnectionOptions } from "mysql2/promise";
import { z } from "zod";
import { validateLocalMysqlConfig, type LocalMysqlConfig } from "../config/mysql";

export const LOCAL_MYSQL_TIMEOUT_MS = 5_000;
export interface MysqlInspectionConnection {
  execute(query: { sql: string; timeout: number }, values: string[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  destroy(): void;
}
export type MysqlConnectionFactory = (options: ConnectionOptions) => Promise<MysqlInspectionConnection>;
export class LocalMysqlInspectionError extends Error {
  constructor() {
    super("Local MySQL inspection failed. Check the approved local profile and server; no schema or business records were changed.");
    this.name = "LocalMysqlInspectionError";
  }
}

const counter = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/);
const metadata = z.object({
  serverVersion: z.string().regex(/^[0-9][0-9A-Za-z_.+-]{0,119}$/),
  versionComment: z.string().max(200),
  selectedDatabase: z.string(),
  connectionCharset: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  connectionCollation: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  sessionTimeZone: z.string().regex(/^[A-Za-z0-9_+:/.-]{1,64}$/),
  autocommit: z.union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")]),
});
const objects = z.object({ tables: counter, views: counter });
function one<T>(schema: z.ZodType<T>, rows: unknown): T {
  const result = z.tuple([schema]).safeParse(rows);
  if (!result.success) throw new LocalMysqlInspectionError();
  return result.data[0];
}
const defaultConnect: MysqlConnectionFactory = async (options) => {
  const connection = await createConnection(options);
  return { execute: (query, values) => connection.execute(query, values), end: () => connection.end(), destroy: () => connection.destroy() };
};

/** Bounded, loopback-only metadata probe. Not an application adapter, migration or importer. */
export async function inspectLocalMysql(input: LocalMysqlConfig, options: { connect?: MysqlConnectionFactory } = {}) {
  const config = validateLocalMysqlConfig(input);
  const connect = options.connect ?? defaultConnect;
  let connection: MysqlInspectionConnection | undefined, expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const destroy = () => { try { connection?.destroy(); } catch { /* no driver details escape */ } connection = undefined; };
  const query = async (sql: string, values: string[] = []) => {
    if (expired || !connection) throw new LocalMysqlInspectionError();
    const [rows] = await connection.execute({ sql, timeout: LOCAL_MYSQL_TIMEOUT_MS }, values);
    if (expired) throw new LocalMysqlInspectionError();
    return rows;
  };
  const work = async () => {
    const opened = await connect({ host: config.host, port: config.port, database: config.database,
      user: config.user, password: config.password, connectTimeout: LOCAL_MYSQL_TIMEOUT_MS,
      multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false,
      dateStrings: true, charset: "utf8mb4", timezone: "Z", flags: ["-LOCAL_FILES"],
      namedPlaceholders: false, debug: false, trace: false, enableKeepAlive: false });
    if (expired) { try { opened.destroy(); } catch { /* late connection must not remain open */ } throw new LocalMysqlInspectionError(); }
    connection = opened;
    const session = one(metadata, await query(`SELECT VERSION() AS serverVersion, @@version_comment AS versionComment,
      DATABASE() AS selectedDatabase, @@session.character_set_connection AS connectionCharset,
      @@session.collation_connection AS connectionCollation, @@session.time_zone AS sessionTimeZone,
      @@session.autocommit AS autocommit`));
    if (session.selectedDatabase !== config.database) throw new LocalMysqlInspectionError();
    const counts = one(objects, await query(`SELECT CAST(COALESCE(SUM(TABLE_TYPE='BASE TABLE'),0) AS CHAR) AS tables,
      CAST(COALESCE(SUM(TABLE_TYPE='VIEW'),0) AS CHAR) AS views FROM information_schema.TABLES WHERE TABLE_SCHEMA=?`, [config.database]));
    const columns = one(z.object({ columns: counter }), await query(
      "SELECT CAST(COUNT(*) AS CHAR) AS columns FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?", [config.database])).columns;
    const triggers = one(z.object({ triggers: counter }), await query(
      "SELECT CAST(COUNT(*) AS CHAR) AS triggers FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?", [config.database])).triggers;
    if (expired) throw new LocalMysqlInspectionError();
    await connection.end();
    connection = undefined;
    const family = /mariadb/i.test(session.serverVersion + session.versionComment) ? "mariadb" :
      /mysql/i.test(session.versionComment) ? "mysql" : "unverified-mysql-compatible";
    return { status: "LOCAL_CONNECTION_VERIFIED" as const, environment: config.environment,
      host: config.host, port: config.port, database: config.database,
      server: { version: session.serverVersion, family },
      session: { charset: session.connectionCharset, collation: session.connectionCollation,
        timeZone: session.sessionTimeZone, autocommit: Number(session.autocommit) === 1 },
      objectsVisibleToCurrentUser: { ...counts, columns, triggers },
      limitations: ["Object counts are limited to metadata visible to the supplied account; they do not prove an empty or authoritative database.",
        "Only connection and metadata were checked. Business rows, schema compatibility, permissions for application writes, backup/recovery and CRM workflows were not verified.",
        "Server family is reported, not accepted as a supported application target. MariaDB is not silently certified as MySQL."],
      runtimeReady: false as const, historicalDataVerified: false as const, schemaChanged: false as const };
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new LocalMysqlInspectionError()); }, LOCAL_MYSQL_TIMEOUT_MS);
    })]);
  } catch {
    expired = true; destroy(); throw new LocalMysqlInspectionError();
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
