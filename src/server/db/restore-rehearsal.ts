import { createHash } from "node:crypto";
import { constants, copyFileSync, createReadStream, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { parseDatabaseConfig } from "../config/database";
import { configureDatabase, localDirectory, openDatabase } from "./connection";
import { assertMigrationsCurrent, migrateDatabase } from "./migrations";
import { inspectSchema } from "./schema";

export class RestoreRehearsalError extends Error {
  constructor() { super("Backup rehearsal failed. Check the completed local backup and migration history; no existing database was restored or replaced."); }
}

function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function regularFile(filename: string) {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !samePath(realpathSync(filename), filename)) throw new RestoreRehearsalError();
  return info;
}
async function digest(filename: string) {
  regularFile(filename);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
async function snapshotSidecars(backup: string) {
  if (existsSync(backup + "-journal")) throw new RestoreRehearsalError();
  const result: Record<string, string | null> = {};
  for (const suffix of ["-wal", "-shm"]) {
    const filename = backup + suffix;
    if (!existsSync(filename)) { result[suffix] = null; continue; }
    const info = regularFile(filename);
    // Read-only validation may leave empty WAL/SHM files. A nonempty WAL can
    // contain newer committed pages and must never be omitted from a restore.
    if (suffix === "-wal" && info.size !== 0) throw new RestoreRehearsalError();
    result[suffix] = await digest(filename);
  }
  return JSON.stringify(result);
}
function assertCurrentSchema(db: Database.Database) {
  // A valid ledger alone cannot detect a dropped table, index or audit trigger.
  const expected = new Database(":memory:");
  try {
    configureDatabase(expected); migrateDatabase(expected);
    const definition = (connection: Database.Database) => JSON.stringify(connection.prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
    ).all());
    if (definition(db) !== definition(expected)) throw new RestoreRehearsalError();
  } finally { expected.close(); }
}
function removeOwnedCopy(directory: string, testRoot: string, root: string) {
  try {
    if (!samePath(localDirectory(root, [".local-data", "test"]), testRoot)
      || !samePath(realpathSync(testRoot), testRoot)) throw new RestoreRehearsalError();
    const info = lstatSync(directory), target = realpathSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(target, directory)
      || !samePath(dirname(target), testRoot) || !basename(target).startsWith("restore-check-")) throw new RestoreRehearsalError();
    rmSync(target, { recursive: true });
  } catch { throw new RestoreRehearsalError(); }
}

/** Copies only a completed offline snapshot into a new owned test directory.
 * Never opens the active development DB, changes a backup, migrates or imports rows.
 */
export async function rehearseBackup(applicationDirectory: string, relativeBackup: string) {
  let ownedDirectory: string | undefined, testRoot: string | undefined;
  try {
    const parts = relativeBackup.replaceAll("\\", "/").split("/");
    if (parts.length !== 4 || parts[0] !== ".local-data" || parts[1] !== "backups" || parts[3] !== "crm.sqlite"
      || !/^(development|test)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[2]!)) throw new RestoreRehearsalError();
    const root = resolve(applicationDirectory);
    const backupDirectory = localDirectory(root, parts.slice(0, 3));
    const backup = join(backupDirectory, "crm.sqlite"), marker = join(backupDirectory, "complete.json");
    regularFile(backup);
    if (regularFile(marker).size > 1024) throw new RestoreRehearsalError();
    // A completed online backup is self-contained. Refuse pending WAL pages.
    const sidecarsBefore = await snapshotSidecars(backup);
    const completion: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (!completion || typeof completion !== "object" || Array.isArray(completion)) throw new RestoreRehearsalError();
    const meta = completion as Record<string, unknown>;
    if (meta.formatVersion !== 1 || typeof meta.environment !== "string" || !["development", "test"].includes(meta.environment)
      || !parts[2]!.startsWith(`${meta.environment}-`) || typeof meta.completedAt !== "string"
      || !Number.isFinite(Date.parse(meta.completedAt))) throw new RestoreRehearsalError();
    const markerBefore = await digest(marker), before = await digest(backup);
    testRoot = localDirectory(root, [".local-data", "test"], true);
    ownedDirectory = mkdtempSync(join(testRoot, "restore-check-"));
    const copy = join(ownedDirectory, "crm.sqlite");
    copyFileSync(backup, copy, constants.COPYFILE_EXCL);
    if (await digest(copy) !== before || await digest(backup) !== before || await digest(marker) !== markerBefore
      || await snapshotSidecars(backup) !== sidecarsBefore) throw new RestoreRehearsalError();
    const config = parseDatabaseConfig({ DATABASE_ENVIRONMENT: "test", SQLITE_DATABASE_PATH: relative(root, copy) }, root);
    const db = openDatabase(config, { readonly: true });
    let report, versions: number[];
    try {
      assertMigrationsCurrent(db);
      assertCurrentSchema(db);
      if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new RestoreRehearsalError();
      report = inspectSchema(db, config);
      if (report.foreignKeyViolations !== 0) throw new RestoreRehearsalError();
      versions = (db.prepare("SELECT version FROM crm_schema_migrations ORDER BY version").all() as { version: number }[]).map((row) => row.version);
    } finally { db.close(); }
    regularFile(backup);
    if (await snapshotSidecars(backup) !== sidecarsBefore || await digest(backup) !== before
      || await digest(marker) !== markerBefore || await digest(copy) !== before) throw new RestoreRehearsalError();
    return { status: "PASS" as const, backup: parts.join("/"), sourceEnvironment: meta.environment as "development" | "test",
      backupSha256: before, versions, integrity: report.integrity, integrityCheck: "ok", foreignKeyViolations: 0,
      tables: report.tables.map(({ name, rowCount }) => ({ name, rowCount })),
      schemaMatchesCurrentMigrations: true, backupUnchanged: true, existingDatabaseReplaced: false, targetHostVerified: false };
  } catch { throw new RestoreRehearsalError(); }
  finally {
    if (ownedDirectory && testRoot) {
      removeOwnedCopy(ownedDirectory, testRoot, resolve(applicationDirectory));
    }
  }
}
