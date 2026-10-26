import nextEnvironment from "@next/env";
import { relative } from "node:path";
import { DatabaseConfigurationError, parseDatabaseConfig } from "../src/server/config/database";
import { backupDatabase } from "../src/server/db/backup";
import { openDatabase } from "../src/server/db/connection";

const { loadEnvConfig } = nextEnvironment;

async function main(): Promise<void> {
  try {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    const config = parseDatabaseConfig(process.env);
    const db = openDatabase(config, { readonly: true });
    try {
      const filename = await backupDatabase(db, config);
      console.log("Validated SQLite backup: " + relative(config.applicationDirectory, filename));
      console.log("Only backup folders containing complete.json represent successful backups.");
    } finally { db.close(); }
  } catch (error: unknown) {
    console.error(error instanceof DatabaseConfigurationError ? error.message : "SQLite backup failed. Any folder without complete.json is incomplete; existing files were not replaced.");
    process.exitCode = 1;
  }
}
void main();
