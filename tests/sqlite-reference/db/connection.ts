import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { DatabaseConfigurationError, parseDatabaseConfig, type DatabaseConfig } from "../config/database";

export type SqliteDatabase = Database.Database;

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function infoIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reject reparse/symbolic links and hard-linked files, including SQLite sidecars. */
function checkFile(path: string): void {
  const info = infoIfPresent(path);
  if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || !samePath(realpathSync(path), path))) {
    throw new DatabaseConfigurationError(["SQLITE_DATABASE_PATH"]);
  }
}

/** Validate each directory before creating its child. Never follows directory junctions. */
export function localDirectory(applicationDirectory: string, segments: readonly string[], create = false): string {
  const root = resolve(/* turbopackIgnore: true */ applicationDirectory);
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(realpathSync(root), root)) {
    throw new DatabaseConfigurationError(["SQLITE_DATABASE_PATH"]);
  }
  let directory = root;
  for (const segment of segments) {
    if (!/^[a-zA-Z0-9._-]+$/.test(segment) || segment === "." || segment === "..") {
      throw new DatabaseConfigurationError(["SQLITE_DATABASE_PATH"]);
    }
    directory = join(directory, segment);
    let info = infoIfPresent(directory);
    if (!info && create) {
      mkdirSync(directory, { mode: 0o700 });
      info = lstatSync(directory);
    }
    if (info && (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(directory), directory))) {
      throw new DatabaseConfigurationError(["SQLITE_DATABASE_PATH"]);
    }
  }
  return directory;
}

export function validateDatabasePath(config: DatabaseConfig, createDirectories = false): void {
  const checked = parseDatabaseConfig({
    DATABASE_ENVIRONMENT: config.environment,
    SQLITE_DATABASE_PATH: relative(config.applicationDirectory, config.filename),
  }, config.applicationDirectory);
  if (!samePath(checked.filename, config.filename)) throw new DatabaseConfigurationError(["SQLITE_DATABASE_PATH"]);
  const segments = relative(config.applicationDirectory, dirname(config.filename)).split(sep);
  localDirectory(config.applicationDirectory, segments, createDirectories);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) checkFile(config.filename + suffix);
}

export function configureDatabase(db: SqliteDatabase, readonly = false): void {
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  if (readonly) db.pragma("query_only = ON");
  else {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
  }
}

/** Normal access requires an existing file. Only the explicit migration CLI creates it. */
export function openDatabase(config: DatabaseConfig, options: { readonly?: boolean; create?: boolean } = {}): SqliteDatabase {
  if (options.create && options.readonly) throw new Error("Read-only access cannot create a database.");
  validateDatabasePath(config, options.create === true);
  if (options.create && !infoIfPresent(config.filename)) {
    const descriptor = openSync(config.filename, "wx", 0o600);
    closeSync(descriptor);
  }
  validateDatabasePath(config);
  const db = new Database(config.filename, { readonly: options.readonly ?? false, fileMustExist: true, timeout: 5000 });
  try { configureDatabase(db, options.readonly); return db; } catch (error) { db.close(); throw error; }
}
