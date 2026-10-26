import nextEnvironment from "@next/env";
import { DatabaseConfigurationError, parseDatabaseConfig } from "../src/server/config/database";
import { openDatabase } from "../src/server/db/connection";
import { migrateDatabase } from "../src/server/db/migrations";

const { loadEnvConfig } = nextEnvironment;

try {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const db = openDatabase(parseDatabaseConfig(process.env), { create: true });
  try {
    const applied = migrateDatabase(db);
    console.log("SQLite migrations applied: " + applied + ". No users or business records were seeded.");
  } finally { db.close(); }
} catch (error: unknown) {
  console.error(error instanceof DatabaseConfigurationError ? error.message : "SQLite migration failed. Check database provenance and migration history; existing schema/data were not reset.");
  process.exitCode = 1;
}
