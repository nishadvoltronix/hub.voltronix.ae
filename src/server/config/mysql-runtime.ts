import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMysqlProfile } from "./mysql-profile";
import type { LocalMysqlConfig } from "./mysql";

type Environment = Record<string, string | undefined>;
export const browserMysqlAcknowledgement = "--allow-local-mysql-browser-tests --acknowledge-synthetic-fixtures-and-http-writes";
const browserBlocked = "Isolated MySQL browser configuration is missing, unsafe or invalid; no fallback was attempted.";
const runtimeBlocked = "MySQL runtime requires explicit reviewed local profile selection; no fallback was attempted.";

export function assertRuntimeMysqlTarget(config: LocalMysqlConfig): LocalMysqlConfig {
  if (config.provider !== "mysql" || config.environment !== "development" || config.host !== "127.0.0.1" ||
      config.port !== 3308 || config.database !== "crm_local_dev") {
    throw new Error("MySQL runtime requires the approved local development target; no fallback was attempted.");
  }
  return config;
}

/** A pure guard shared with the owned-browser runner; this cannot create a fixture. */
export function browserMysqlFixtureRelativeRoot(value: unknown): string {
  if (typeof value !== "string" || !/^\.local-data\/test\/mysql-browser-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error(browserBlocked);
  }
  return value;
}

/** Explicit synthetic test selection, never a development/profile fallback. No connection or writes. */
export function approvedMysqlBrowserFixture(applicationRoot: string, environment: Environment) {
  try {
    if (environment.CRM_MYSQL_RUNTIME_PROFILE !== "isolated-browser-fixture" ||
        environment.CRM_MYSQL_BROWSER_ACK !== browserMysqlAcknowledgement) throw new Error();
    const relativeRoot = browserMysqlFixtureRelativeRoot(environment.CRM_MYSQL_BROWSER_FIXTURE);
    const origin = environment.APP_ORIGIN;
    const port = typeof origin === "string" ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(origin) : null;
    if (!origin || !port || Number(port[1]) > 65_535 || new URL(origin).origin !== origin) throw new Error();
    const root = resolve(/* turbopackIgnore: true */ applicationRoot);
    const samePath = (left: string, right: string) => process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase() : left === right;
    let fixtureRoot = root;
    for (const segment of ["", ...relativeRoot.split("/")]) {
      if (segment) fixtureRoot = join(fixtureRoot, segment);
      const stat = lstatSync(/* turbopackIgnore: true */ fixtureRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          !samePath(realpathSync(/* turbopackIgnore: true */ fixtureRoot), fixtureRoot)) throw new Error();
    }
    const fixtureId = relativeRoot.slice(".local-data/test/mysql-browser-".length);
    const config = readMysqlProfile(["--profile", ".env.mysql.runtime.local"], fixtureRoot);
    if (config.provider !== "mysql" || config.environment !== "test" || config.host !== "127.0.0.1" ||
        config.port !== 3308 || config.database !== `crm_local_browser_${fixtureId.replaceAll("-", "")}`) throw new Error();
    return { config, fixtureRoot, fixtureId, origin };
  } catch { throw new Error(browserBlocked); }
}

function developmentProfileSelection(environment: Environment): ".env.mysql.local" | ".env.mysql.runtime.local" {
  if (environment.CRM_MYSQL_BROWSER_FIXTURE !== undefined || environment.CRM_MYSQL_BROWSER_ACK !== undefined) {
    throw new Error(runtimeBlocked);
  }
  const selected = environment.CRM_MYSQL_RUNTIME_PROFILE;
  if (selected !== undefined && selected !== ".env.mysql.local" && selected !== ".env.mysql.runtime.local") {
    throw new Error(runtimeBlocked);
  }
  return selected ?? ".env.mysql.local";
}

/** Preserve the original selection until the operator explicitly opts into the separate runtime profile. */
export function readDevelopmentRuntimeMysqlConfig(root = process.cwd(), environment: Environment = process.env): LocalMysqlConfig {
  return assertRuntimeMysqlTarget(readMysqlProfile(["--profile", developmentProfileSelection(environment)], root));
}

/** DDL approval names a separate private migration profile; runtime credentials are never substituted. */
export function readDevelopmentMigrationMysqlConfig(args: readonly string[], root = process.cwd(), environment: Environment = process.env): LocalMysqlConfig {
  if (args.length !== 3 || args[0] !== "--approve-local-application-schema" ||
      args[1] !== "--profile" || args[2] !== ".env.mysql.migration.local") throw new Error(runtimeBlocked);
  developmentProfileSelection(environment);
  return assertRuntimeMysqlTarget(readMysqlProfile(args.slice(1), root));
}

/** Credentials come only from an explicitly selected ignored profile, never SQLite, PHP or a fallback. */
export function readRuntimeMysqlConfig(root = process.cwd(), environment: Environment = process.env): LocalMysqlConfig {
  if (environment.CRM_MYSQL_RUNTIME_PROFILE === "isolated-browser-fixture") {
    return approvedMysqlBrowserFixture(root, environment).config;
  }
  return readDevelopmentRuntimeMysqlConfig(root, environment);
}
