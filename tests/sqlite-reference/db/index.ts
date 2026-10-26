import "server-only";
import { parseDatabaseConfig } from "../config/database";
import { openDatabase, type SqliteDatabase } from "./connection";
import { assertMigrationsCurrent } from "./migrations";

const globalDatabase = globalThis as typeof globalThis & { crmDatabase?: SqliteDatabase; crmDatabasePath?: string };

/** Node boundary. Opening the application never creates tables, migrates, or seeds. */
export function getDatabase(): SqliteDatabase {
  const config = parseDatabaseConfig(process.env);
  if (globalDatabase.crmDatabase && globalDatabase.crmDatabasePath !== config.filename) {
    throw new Error("Database configuration changed; restart the application.");
  }
  if (!globalDatabase.crmDatabase) {
    const db = openDatabase(config);
    try { assertMigrationsCurrent(db); } catch (error) { db.close(); throw error; }
    globalDatabase.crmDatabase = db;
    globalDatabase.crmDatabasePath = config.filename;
  }
  return globalDatabase.crmDatabase;
}

export type { SqliteDatabase } from "./connection";
