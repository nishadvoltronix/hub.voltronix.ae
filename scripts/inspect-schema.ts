import nextEnvironment from "@next/env";
import { relative } from "node:path";
import { DatabaseConfigurationError, parseDatabaseConfig } from "../src/server/config/database";
import { openDatabase } from "../src/server/db/connection";
import { inspectSchema, writeSchemaReport } from "../src/server/db/schema";

const { loadEnvConfig } = nextEnvironment;

try {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const config = parseDatabaseConfig(process.env);
  const db = openDatabase(config, { readonly: true });
  try {
    const report = inspectSchema(db, config);
    const filename = writeSchemaReport(config.applicationDirectory, report);
    console.log("Read-only SQLite metadata/counts report: " + relative(config.applicationDirectory, filename));
    console.log("No application record values or credentials were exported.");
  } finally { db.close(); }
} catch (error: unknown) {
  console.error(error instanceof DatabaseConfigurationError ? error.message : "SQLite schema inspection failed. No successful report was produced.");
  process.exitCode = 1;
}
