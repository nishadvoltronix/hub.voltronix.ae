import type { LocalMysqlConfig } from "../src/server/config/mysql";

export const mysqlBrowserFlags = ["--allow-local-mysql-browser-tests", "--acknowledge-synthetic-fixtures-and-http-writes"] as const;
export const mysqlBrowserBlocked = "BLOCKED: authenticated MySQL browser verification requires explicit acknowledgement, a manually started approved local server, and a new isolated fixture with separate operator and application profiles. No database was selected or server started.";

/** Validate all arguments before profile reads, database sockets, DDL or fixtures. */
export function mysqlBrowserArguments(args: readonly string[]) {
  if (args.length !== 4 || args[0] !== mysqlBrowserFlags[0] || args[1] !== mysqlBrowserFlags[1] || args[2] !== "--fixture-root") {
    throw new Error(mysqlBrowserBlocked);
  }
  const relativeRoot = args[3]!;
  const match = /^\.local-data\/test\/mysql-browser-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.exec(relativeRoot);
  if (!match) throw new Error(mysqlBrowserBlocked);
  return { relativeRoot, fixtureId: match[1]!, database: `crm_local_browser_${match[1]!.replaceAll("-", "")}` };
}

/** Application requests must never run under the migration/provisioning identity. */
export function assertMysqlBrowserProfilePair(operator: LocalMysqlConfig, runtime: LocalMysqlConfig, database: string) {
  if (!/^crm_local_browser_[a-f0-9]{32}$/u.test(database) || operator.user === runtime.user || operator.password === runtime.password) {
    throw new Error(mysqlBrowserBlocked);
  }
  for (const config of [operator, runtime]) {
    if (config.provider !== "mysql" || config.environment !== "test" || config.host !== "127.0.0.1" || config.port !== 3308 || config.database !== database) {
      throw new Error(mysqlBrowserBlocked);
    }
  }
}
