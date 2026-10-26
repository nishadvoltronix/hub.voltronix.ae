import mysql, { type ConnectionOptions } from "mysql2/promise";
import { MysqlAuthDatabaseError, validateMysqlAuthConfig, type MysqlAuthConfig } from "./config.js";

export const MYSQL_TIMEOUT_MS = 5_000;
export interface MysqlAuthWireConnection {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
  query(sql: string): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
  destroy(): void;
}
export type MysqlAuthConnector = (config: Readonly<MysqlAuthConfig>) => Promise<MysqlAuthWireConnection>;

/** Prepared protocol values only; BIGINT identity must never pass through a JS float. */
export function mysqlAuthParameters(values: readonly unknown[]) {
  return values.map(value => {
    if (value === null || typeof value === "string") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return mysql.TypedParameter.LONGLONG(value);
    throw new MysqlAuthDatabaseError();
  });
}
export function mysqlAuthConnectionOptions(input: unknown): ConnectionOptions {
  const config = validateMysqlAuthConfig(input);
  return { host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
    connectTimeout: MYSQL_TIMEOUT_MS, multipleStatements: false, namedPlaceholders: false,
    supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, dateStrings: true,
    charset: "utf8mb4_bin", timezone: "Z", flags: ["-LOCAL_FILES", "-FOUND_ROWS"],
    debug: false, trace: false, enableKeepAlive: false };
}

/** The only live connector. Importing it opens nothing; the CLI does not select it. */
export const connectMysqlAuth: MysqlAuthConnector = async config => {
  if (process.env.CRM_MYSQL_NETWORK_DISABLED === "1") throw new MysqlAuthDatabaseError();
  const options = mysqlAuthConnectionOptions(config);
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  let openedConnection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
  try {
    const connection = await Promise.race([
      mysql.createConnection(options).then(opened => {
        if (expired) { try { opened.destroy(); } catch { /* private cleanup */ } throw new MysqlAuthDatabaseError(); }
        return opened;
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        expired = true; reject(new MysqlAuthDatabaseError());
      }, MYSQL_TIMEOUT_MS); }),
    ]);
    openedConnection = connection;
    if (timer) clearTimeout(timer);
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work(), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => { try { connection.destroy(); } catch { /* private cleanup */ }
          reject(new MysqlAuthDatabaseError()); }, MYSQL_TIMEOUT_MS);
      })]); } catch { throw new MysqlAuthDatabaseError(); }
      finally { if (deadline) clearTimeout(deadline); }
    };
    const query = (sql: string) => bounded(() => connection.query({ sql, timeout: MYSQL_TIMEOUT_MS }));
    await query("SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin");
    return {
      execute: (sql, values = []) => bounded(() => connection.execute({ sql, timeout: MYSQL_TIMEOUT_MS }, mysqlAuthParameters(values))),
      query, beginTransaction: async () => { await query("START TRANSACTION"); },
      commit: async () => { await query("COMMIT"); }, rollback: async () => { await query("ROLLBACK"); },
      end: () => bounded(() => connection.end()), destroy: () => connection.destroy(),
    };
  } catch {
    try { openedConnection?.destroy(); } catch { /* never expose driver errors */ }
    throw new MysqlAuthDatabaseError();
  } finally { if (timer) clearTimeout(timer); }
};
