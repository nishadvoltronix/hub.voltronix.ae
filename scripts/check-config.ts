import nextEnvironment from "@next/env";
import { DatabaseConfigurationError, parseDatabaseConfig } from "../src/server/config/database";
import { validateDatabasePath } from "../src/server/db/connection";
import { parseWebConfig } from "../src/server/config/web";

const { loadEnvConfig } = nextEnvironment;

try {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  validateDatabasePath(parseDatabaseConfig(process.env));
  parseWebConfig(process.env);
  console.log("SQLite path and APP_ORIGIN configuration are valid. No database was opened or created.");
} catch (error: unknown) {
  console.error(error instanceof DatabaseConfigurationError ? error.message : "SQLite/APP_ORIGIN configuration validation failed.");
  process.exitCode = 1;
}
