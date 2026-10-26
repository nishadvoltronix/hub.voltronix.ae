import mysql, { type ConnectionOptions } from "mysql2/promise";
import { validateLocalMysqlConfig, type LocalMysqlConfig } from "../../config/mysql";

// mysql2 exposes TypedParameter via a CommonJS getter, not a native named export.
const { createConnection, TypedParameter } = mysql;

export const MYSQL_TIMEOUT_MS = 5_000;
export interface MysqlWireConnection {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  query(sql: string): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
  destroy(): void;
}
export type MysqlConnector = (config: LocalMysqlConfig) => Promise<MysqlWireConnection>;

/** Explicit integer wire types keep LIMIT/OFFSET independent of server type hints. */
export function mysqlParameterValues(values: readonly unknown[]) {
  return values.map((value) => {
    if (value === null || typeof value === "string" || Buffer.isBuffer(value) || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (Number.isSafeInteger(value)) return TypedParameter.LONGLONG(value);
      if (!Number.isInteger(value)) return value;
    }
    if (typeof value === "bigint" && value >= -9_223_372_036_854_775_808n && value <= 9_223_372_036_854_775_807n) {
      return TypedParameter.LONGLONG(value);
    }
    throw new Error("Invalid MySQL parameter.");
  });
}

export function mysqlConnectionOptions(input: LocalMysqlConfig): ConnectionOptions {
  const config = validateLocalMysqlConfig(input);
  return { host: config.host, port: config.port, database: config.database, user: config.user,
    password: config.password, connectTimeout: MYSQL_TIMEOUT_MS, multipleStatements: false,
    supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true,
    // The initial handshake has a one-byte collation field. MySQL's 0900_bin
    // identifier is 309; select it with SET NAMES only after authentication.
    charset: "utf8mb4_bin", timezone: "Z", flags: ["-LOCAL_FILES", "-FOUND_ROWS"],
    namedPlaceholders: false, debug: false, trace: false, enableKeepAlive: false };
}

/** The only production driver factory. No connection is opened at module evaluation. */
export const connectMysql: MysqlConnector = async (config) => {
  if (process.env.CRM_MYSQL_NETWORK_DISABLED === "1") throw new Error("MySQL networking is disabled for this process.");
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let openedConnection: Awaited<ReturnType<typeof createConnection>> | undefined;
  try {
    const connection = await Promise.race([
      createConnection(mysqlConnectionOptions(config)).then((opened) => {
        if (expired) { try { opened.destroy(); } catch { /* redacted */ } throw new Error("MySQL connection expired."); }
        return opened;
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        expired = true; reject(new Error("MySQL connection unavailable."));
      }, MYSQL_TIMEOUT_MS); }),
    ]);
    openedConnection = connection;
    if (timer) clearTimeout(timer);
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work(), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => { try { connection.destroy(); } catch { /* redacted */ } reject(new Error("MySQL operation expired.")); }, MYSQL_TIMEOUT_MS);
      })]); } finally { if (deadline) clearTimeout(deadline); }
    };
    const query = (sql: string) => bounded(() => connection.query({ sql, timeout: MYSQL_TIMEOUT_MS }));
    await query("SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin");
    await query("SET SESSION time_zone = '+00:00'");
    return {
      execute: (sql, values = []) => bounded(() => connection.execute({ sql, timeout: MYSQL_TIMEOUT_MS }, mysqlParameterValues(values))),
      query,
      beginTransaction: async () => { await query("START TRANSACTION"); },
      commit: async () => { await query("COMMIT"); },
      rollback: async () => { await query("ROLLBACK"); },
      end: () => bounded(() => connection.end()), destroy: () => connection.destroy(),
    };
  } catch {
    try { openedConnection?.destroy(); } catch { /* initialization failures stay redacted */ }
    throw new Error("MySQL connection unavailable; no fallback was attempted.");
  }
  finally { if (timer) clearTimeout(timer); }
};
