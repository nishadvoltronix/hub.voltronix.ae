import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DatabaseConfig } from "../config/database";
import { localDirectory, type SqliteDatabase, validateDatabasePath } from "./connection";

/** SQLite online backup includes committed WAL data. Never copy the main file alone. */
export async function backupDatabase(db: SqliteDatabase, config: DatabaseConfig): Promise<string> {
  validateDatabasePath(config);
  if (db.name !== config.filename) throw new Error("Backup source does not match the configured database.");
  const parent = localDirectory(config.applicationDirectory, [".local-data", "backups"], true);
  const directory = join(parent, config.environment + "-" + randomUUID());
  mkdirSync(directory, { mode: 0o700 }); // exclusive directory; no overwrite option
  const filename = join(directory, "crm.sqlite");
  const descriptor = openSync(filename, "wx", 0o600);
  closeSync(descriptor);
  await db.backup(filename);
  const copy = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    if (copy.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Backup integrity validation failed.");
  } finally { copy.close(); }
  const marker = openSync(join(directory, "complete.json"), "wx", 0o600);
  try { writeFileSync(marker, JSON.stringify({ formatVersion: 1, completedAt: new Date().toISOString(), environment: config.environment }) + "\n"); }
  finally { closeSync(marker); }
  return filename;
}
