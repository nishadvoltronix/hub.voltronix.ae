import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { mysqlEnvironmentKeys, zohoEnvironmentKeys } from "./runtime/environment-settings.js";
import { assertPrivateAccess } from "./runtime/private-profile.js";

const supportedKeys = new Set(["CRM_API_ENVIRONMENT", "CRM_API_HOST", "CRM_API_PORT", "CRM_API_INSTANCE_ID", "APP_ORIGIN", "CRM_DATABASE_MODE",
  "CRM_RUNTIME_ENABLE", "CRM_RUNTIME_PROFILE", "CRM_RUNTIME_SOURCE", "CRM_MYSQL_NETWORK_DISABLED",
  ...mysqlEnvironmentKeys, ...zohoEnvironmentKeys]);
const optionalKeys = new Set(["CRM_RUNTIME_ENABLE", "CRM_RUNTIME_PROFILE", "CRM_RUNTIME_SOURCE", "CRM_MYSQL_NETWORK_DISABLED",
  ...mysqlEnvironmentKeys, ...zohoEnvironmentKeys]);
const maximumBytes = 16_384;

export class EnvironmentFileError extends Error {
  constructor() { super("Invalid backend environment file; no server or database connection was started."); }
}

/** A deliberately small dotenv contract: one assignment per line, comments and
 * optional single/double quotes. No interpolation, extra keys or multiline values.
 * Production may explicitly select backend environment credentials instead of JSON. */
export function parseBackendEnvironment(source: string): Readonly<Record<string, string>> {
  try {
    if (Buffer.byteLength(source, "utf8") > maximumBytes || source.includes("\0")) throw new Error();
    const selected = new Set<string>();
    for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'[^'\r\n]*'|"[^"\r\n]*"|[^#'"\r\n]*)(?:\s*#.*)?$/.exec(line);
      const key = match?.[1];
      if (!key || !supportedKeys.has(key) || selected.has(key)) throw new Error();
      selected.add(key);
    }
    const parsed = parseEnv(source.replace(/^\uFEFF/, ""));
    if (Object.keys(parsed).length !== selected.size) throw new Error();
    const validated: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!selected.has(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) throw new Error();
      if (optionalKeys.has(key) && !value.trim()) continue;
      validated[key] = value;
    }
    if (validated.CRM_MYSQL_NETWORK_DISABLED !== undefined && validated.CRM_MYSQL_NETWORK_DISABLED !== "1") throw new Error();
    if (validated.CRM_API_INSTANCE_ID !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(validated.CRM_API_INSTANCE_ID)) throw new Error();
    // Explicit Hub modes cannot be dropped as blank selectors or activate the native adapter.
    isMysqlRuntimeSelected(validated);
    return Object.freeze(validated);
  } catch { throw new EnvironmentFileError(); }
}

/** Called only by executable boundaries. Source and built entrypoints resolve
 * this same backend-owned .env, regardless of the caller's working directory.
 * Missing files are allowed for explicit launcher/container process settings.
 * Never searches parent/frontend files or replaces an explicit process value. */
export function loadBackendEnvironment(environment: Record<string, string | undefined> = process.env,
  file: URL = new URL("../.env", import.meta.url)): void {
  let descriptor: number | undefined;
  try {
    let before;
    try { before = lstatSync(file); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) throw new Error();
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new Error();
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(descriptor);
    if (bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.nlink !== 1) throw new Error();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const values = parseBackendEnvironment(source);
    if (["CRM_MYSQL_PASSWORD", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"].some(key => values[key])) {
      assertPrivateAccess(fileURLToPath(file));
    }
    const current = lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== opened.dev
      || current.ino !== opened.ino || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw new Error();
    for (const [key, value] of Object.entries(values)) {
      if (environment[key] === undefined) environment[key] = value;
    }
  } catch { throw new EnvironmentFileError(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function isMysqlRuntimeSelected(environment: Readonly<Record<string, string | undefined>>): boolean {
  if (environment.CRM_DATABASE_MODE !== undefined) {
    if (environment.CRM_DATABASE_MODE !== "disabled"
      || (environment.CRM_MYSQL_NETWORK_DISABLED !== undefined && environment.CRM_MYSQL_NETWORK_DISABLED !== "1")
      || Object.entries(environment).some(([key, value]) => value?.trim()
        && (key.startsWith("CRM_RUNTIME_") || (key.startsWith("CRM_MYSQL_") && key !== "CRM_MYSQL_NETWORK_DISABLED")))) {
      throw new EnvironmentFileError();
    }
    return false;
  }
  return Boolean(environment.CRM_RUNTIME_ENABLE?.trim() || environment.CRM_RUNTIME_PROFILE?.trim()
    || environment.CRM_RUNTIME_SOURCE?.trim() || mysqlEnvironmentKeys.some(key => environment[key]?.trim()));
}
