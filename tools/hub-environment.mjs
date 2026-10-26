import fs from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

const maximumBytes = 16 * 1024;
// Root storage is shared, but only the API receives these values from the launcher.
export const mysqlEnvironmentKeys = Object.freeze(["CRM_MYSQL_HOST", "CRM_MYSQL_PORT", "CRM_MYSQL_DATABASE",
  "CRM_MYSQL_USER", "CRM_MYSQL_PASSWORD", "CRM_MYSQL_SERVER_UUID", "CRM_MYSQL_APPROVED",
  "CRM_MYSQL_APPROVAL_REFERENCE", "CRM_MYSQL_PROVISIONING_REFERENCE", "CRM_MYSQL_ISSUER_COMPANY",
  "CRM_MYSQL_ISSUER_SALESPERSON"]);
export const nativeEnvironmentKeys = Object.freeze(["CRM_RUNTIME_ENABLE", "CRM_RUNTIME_SOURCE", ...mysqlEnvironmentKeys]);
export const zohoCredentialKeys = Object.freeze(["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN"]);
export const zohoRuntimeKeys = Object.freeze(["ZOHO_ORGANIZATION_ID", "ZOHO_ACCOUNT_OWNER_ID", "ZOHO_PROFILE",
  "ZOHO_DEAL_PIPELINE", "ZOHO_AUTOMATION_POLICY"]);
export const zohoSyncKeys = Object.freeze(["ZOHO_SYNC_ENABLED", "ZOHO_SYNC_INTERVAL_SECONDS", "ZOHO_SYNC_PRINCIPAL_ID"]);
const allowedKeys = new Set([
  "NODE_ENV", "APP_ORIGIN", "CRM_API_INSTANCE_ID", "CRM_DATABASE_MODE",
  "CRM_MYSQL_NETWORK_DISABLED", "ZOHO_ENABLED", "ZOHO_NETWORK_DISABLED", "NEXT_TELEMETRY_DISABLED",
  "CRM_WEB_HOST", "CRM_WEB_PORT", "CRM_FRONTEND_BACKEND", "CRM_EXPRESS_ORIGIN",
  "CRM_API_ENVIRONMENT", "CRM_API_HOST", "CRM_API_PORT",
  ...nativeEnvironmentKeys,
  ...zohoCredentialKeys, ...zohoRuntimeKeys, ...zohoSyncKeys,
]);
const comparable = value => process.platform === "win32" ? value.toLowerCase() : value;
function fail(message) { throw new Error(message); }
function metadata(path) {
  try { return fs.lstatSync(path, { bigint: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail("Cannot inspect the Hub environment file layout.");
  }
}
function ordinaryDirectory(path) {
  const stat = metadata(path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail("Hub environment directories must be ordinary directories without links.");
  try {
    if (comparable(fs.realpathSync(path)) !== comparable(path)) fail("Hub environment directories must not pass through links.");
  } catch { fail("Hub environment directories must not pass through links."); }
}
function ordinaryAncestors(root) {
  const paths = [];
  for (let path = root; ; path = dirname(path)) {
    paths.push(path);
    if (path === parse(path).root) break;
  }
  for (const path of paths.reverse()) ordinaryDirectory(path);
}
function ordinaryFile(stat) {
  return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n);
}
function sameFile(first, second) {
  return ordinaryFile(first) && ordinaryFile(second)
    && ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(key => first[key] === second[key]);
}

/** Next can load multiple dotenv names; Hub permits only the single root file. */
export function assertSingleEnvironmentFileLayout(root) {
  if (typeof root !== "string" || !root) fail("A Hub project directory is required.");
  const project = resolve(root);
  ordinaryAncestors(project);
  for (const directory of [project, join(project, "server")]) {
    if (!metadata(directory)) continue;
    ordinaryDirectory(directory);
    let names;
    try { names = fs.readdirSync(directory); }
    catch { fail("Cannot inspect the Hub environment file layout."); }
    for (const name of names) {
      if (!name.toLowerCase().startsWith(".env")) continue;
      if (name !== ".env.example" && !(directory === project && name === ".env")) {
        fail("Only the root .env is supported; remove other active .env files from the root and server directories.");
      }
      if (!ordinaryFile(metadata(join(directory, name)))) fail("Hub environment files must be ordinary files without links or hard links.");
    }
  }
}

function parseEnvironment(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("Root .env must contain valid UTF-8 text."); }
  if (/[^\S\r\n\t ]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\p{Cf}|\r(?!\n)/u.test(text)) {
    fail("Root .env contains unsupported control or whitespace characters.");
  }
  const environment = {};
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const assignment = /^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!assignment) fail("Root .env requires one simple KEY=value assignment per line.");
    const [, key, raw] = assignment;
    if (!allowedKeys.has(key)) fail("Root .env contains an unsupported setting. Only the settings in .env.example are allowed.");
    if (Object.hasOwn(environment, key)) fail("Root .env contains duplicate settings.");
    let value;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0];
      const closing = raw.indexOf(quote, 1);
      if (closing < 0 || !/^[ \t]*(?:#.*)?$/.test(raw.slice(closing + 1))) fail("Root .env contains invalid quoted or multiline values.");
      value = raw.slice(1, closing);
    } else {
      value = raw.split("#", 1)[0].trim();
      if (/["']/.test(value)) fail("Root .env contains invalid quotes.");
      if (/[ \t]/.test(value)) fail("Root .env requires one simple KEY=value assignment per line; quote values containing spaces.");
    }
    // Passwords are literal data: dollar signs, backslashes and backticks are
    // never interpolated or evaluated. Quote a value containing # or spaces.
    if (key !== "CRM_MYSQL_PASSWORD" && !zohoCredentialKeys.includes(key) && /[$`\\\r\n\t]/.test(value)) fail("Root .env does not support interpolation, escapes, commands or multiline values.");
    if (/[\r\n\t]/.test(value)) fail("Root .env does not support multiline values or tabs.");
    environment[key] = value;
  }
  return environment;
}

/** Reads only the root environment; explicit process settings take precedence. */
export function loadHubEnvironment(root, ambient = process.env) {
  assertSingleEnvironmentFileLayout(root);
  const project = resolve(root);
  const path = join(project, ".env");
  const before = metadata(path);
  let loaded = {};
  if (before) {
    if (!ordinaryFile(before) || before.size > BigInt(maximumBytes)) fail("Root .env must be an ordinary file of at most 16 KiB.");
    let descriptor;
    try {
      descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      if (!sameFile(before, fs.fstatSync(descriptor, { bigint: true }))) fail("Root .env changed while being inspected; retry with a stable ordinary file.");
      const buffer = Buffer.alloc(maximumBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
      }
      if (length > maximumBytes) fail("Root .env exceeds the 16 KiB limit.");
      if (!sameFile(before, fs.fstatSync(descriptor, { bigint: true })) || !sameFile(before, metadata(path))) {
        fail("Root .env changed while being read; retry with a stable ordinary file.");
      }
      assertSingleEnvironmentFileLayout(project);
      loaded = parseEnvironment(buffer.subarray(0, length));
    } catch (error) {
      // Filesystem errors include paths; parser errors contain only fixed diagnostics.
      if (error?.code) fail("Cannot safely read the root .env file.");
      throw error;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); }
        catch { fail("Cannot safely close the root .env file."); }
      }
    }
  }
  return { ...loaded, ...Object.fromEntries(Object.entries(ambient).filter(([, value]) => value !== undefined)) };
}
