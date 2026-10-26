import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMysqlProfile } from "../../src/server/config/mysql-profile";

export const liveMysqlAcknowledgements = ["--allow-local-mysql-tests", "--acknowledge-additive-ddl-and-retained-fixtures"] as const;
export const liveMysqlBlockedMessage = "BLOCKED: real MySQL tests require explicit acknowledgement, a manually started local MySQL 8.4.11 server and a separately approved empty test schema/private test profile. No server was started or database reset.";

/** Pure argument validation happens before reading any profile or making a connection. */
export function liveMysqlArguments(args: readonly string[]): string {
  if (args.length !== 4 || args[0] !== liveMysqlAcknowledgements[0] || args[1] !== liveMysqlAcknowledgements[1]
    || args[2] !== "--fixture-root" || !/^\.local-data\/test\/mysql-integration-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(args[3]!)) {
    throw new Error(liveMysqlBlockedMessage);
  }
  return args[3]!;
}

/** Profile stays private; original .env.local and .env.mysql.local are never selected. */
export function approvedLiveMysqlProfile(applicationRoot: string, args: readonly string[]) {
  const relativeRoot = liveMysqlArguments(args);
  try {
    const root = resolve(applicationRoot);
    const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    let current = root;
    for (const segment of ["", ...relativeRoot.split("/")]) {
      if (segment) current = join(current, segment);
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(current), current)) throw new Error();
    }
    const config = readMysqlProfile(["--profile", ".env.mysql.local"], current);
    if (config.environment !== "test" || config.host !== "127.0.0.1" || config.port !== 3308
      || !/^crm_local_test_[a-z0-9_]{1,40}$/u.test(config.database)) throw new Error();
    return { config, fixtureRoot: current };
  } catch { throw new Error(liveMysqlBlockedMessage); }
}
