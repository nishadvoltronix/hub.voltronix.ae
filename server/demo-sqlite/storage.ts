import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localDirectory, openDatabase } from "../../tests/sqlite-reference/db/connection.ts";
import { parseDatabaseConfig } from "../../tests/sqlite-reference/config/database.ts";
import { assertMigrationsCurrent } from "../../tests/sqlite-reference/db/migrations.ts";
import { assertOrdinaryPath, privateAccess } from "../scripts/mysql-auth/files.js";
import type { DemoFixture } from "./fixture.js";

export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const workspaceRoot = resolve(backendRoot, "..");
export const relativeData = ".local-data/development/sqlite-demo";
export const dataRoot = join(backendRoot, relativeData);
export const databaseRelative = `${relativeData}/crm-demo.sqlite`;
export const databaseConfig = parseDatabaseConfig({ DATABASE_PROVIDER: "sqlite", DATABASE_ENVIRONMENT: "development",
  SQLITE_DATABASE_PATH: databaseRelative }, backendRoot);
export const acknowledgement = "isolated-local-sqlite-demo";
export const demoInstanceId = "sqlite-demo";

export function demoConfiguration(environment: Record<string, string | undefined>, execArguments: readonly string[] = process.execArgv) {
  if (environment.CRM_SQLITE_DEMO !== acknowledgement || environment.CRM_RUNTIME_ENABLE !== undefined
    || environment.CRM_RUNTIME_PROFILE !== undefined || environment.CRM_API_ENVIRONMENT !== "development"
    || environment.CRM_API_HOST !== "127.0.0.1" || environment.CRM_API_PORT !== "3002"
    || environment.APP_ORIGIN !== "http://127.0.0.1:3001"
    || (environment.NODE_ENV !== undefined && environment.NODE_ENV !== "development")
    || ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "PWDEBUG", "NODE_OPTIONS"].some(key => !!environment[key])
    || execArguments.some(arg => arg.startsWith("--inspect"))) throw new Error("Explicit local SQLite demo configuration required.");
  return { environment: "development" as const, host: "127.0.0.1" as const, port: 3002,
    appOrigin: "http://127.0.0.1:3001", instanceId: demoInstanceId };
}

export function privateDirectory(parts: readonly string[] = [], create = false): string {
  const directory = localDirectory(backendRoot, [...relativeData.split("/"), ...parts], create);
  // New directories inherit the already private backend container. Never set
  // or repair an ACL; unexpected access stops before any secret/database write.
  let current = backendRoot;
  for (const part of [...relativeData.split("/"), ...parts]) {
    current = join(current, part); assertOrdinaryPath(backendRoot, current); privateAccess(current, false);
  }
  return directory;
}

export function writePrivateNew(filename: string, value: unknown): void {
  assertOrdinaryPath(dataRoot, dirname(filename)); privateAccess(dirname(filename), false);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  if (bytes.length > 262144) throw new Error("Private demo record too large.");
  const descriptor = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); bytes.fill(0); }
  privateAccess(filename, false);
}

export function readPrivate(filename: string): unknown {
  assertOrdinaryPath(dataRoot, filename); privateAccess(filename, false);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) throw new Error("Invalid private demo record.");
  const descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1) throw new Error("Invalid private demo record.");
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    const after = lstatSync(filename);
    if (after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("Private demo record changed.");
    return value;
  } finally { closeSync(descriptor); }
}

export interface DemoAccess { version: 1; provider: "sqlite-demo"; database: string; fixture: DemoFixture }
export function access(): DemoAccess {
  privateDirectory();
  const value = readPrivate(join(dataRoot, "access.json")) as DemoAccess;
  if (value.version !== 1 || value.provider !== "sqlite-demo" || value.database !== databaseRelative
    || !value.fixture?.identities?.operator || value.fixture.marker !== `SYNTHETIC SQLITE DEMO ${value.fixture.fixtureId}`) throw new Error("Demo provenance unavailable.");
  return value;
}

export function openDemo(readonly = false) {
  access();
  if (!existsSync(databaseConfig.filename)) throw new Error("Initialize the new demo explicitly first.");
  privateAccess(databaseConfig.filename, false);
  const db = openDatabase(databaseConfig, { readonly });
  try { assertMigrationsCurrent(db); return db; } catch (error) { db.close(); throw error; }
}
