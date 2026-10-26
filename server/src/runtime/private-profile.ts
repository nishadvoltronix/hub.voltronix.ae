import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { RuntimeConfigurationError, runtimeProfilePath } from "./configuration.js";

function samePath(a: string, b: string) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function ordinary(root: string, target: string): void {
  let current = root;
  for (const segment of ["", ...relative(root, target).split(sep).filter(Boolean)]) {
    if (segment) current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !samePath(realpathSync(current), current)) throw new RuntimeConfigurationError();
  }
}
/** Inspect effective ownership and restricted ACLs; this has no Set-Acl branch. */
export function assertPrivateAccess(path: string): void {
  if (process.platform !== "win32") {
    const stat = lstatSync(path);
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new RuntimeConfigurationError();
    return;
  }
  const script = `$ErrorActionPreference='Stop'; try {
    $target=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $acl=Get-Acl -LiteralPath $target; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }
    $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); $current=$false;
    foreach($rule in $rules) {
      if($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18')) { exit 2 }
      if($rule.IdentityReference.Value -eq $sid.Value -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)) { $current=$true }
    }; if(-not $current) { exit 2 }; exit 0
  } catch { exit 2 }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { input: path, stdio: ["pipe", "ignore", "ignore"], timeout: 10_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new RuntimeConfigurationError();
}

/** Read one explicitly selected private JSON file. Never create directories,
 * files or ACLs. Reject aliases, hard links, duplicate keys and changing files. */
function readPrivateProfile(packageRoot: string, name: string, expectedName: string): unknown {
  let descriptor: number | undefined;
  try {
    if (name !== expectedName) throw new Error();
    const root = resolve(packageRoot), path = resolve(root, name);
    ordinary(root, root);
    if (!lstatSync(root).isDirectory()) throw new Error();
    let parent = root;
    for (const segment of [".local-data", "operators"]) {
      parent = join(parent, segment); ordinary(root, parent);
      if (!lstatSync(parent).isDirectory()) throw new Error();
      assertPrivateAccess(parent);
    }
    ordinary(root, path); assertPrivateAccess(path);
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > 16_384) throw new Error();
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new Error();
    const source = readFileSync(descriptor, "utf8").replace(/\r\n/g, "\n");
    const value: unknown = JSON.parse(source);
    if (source.trim() !== JSON.stringify(value, null, 2).trim()) throw new Error();
    ordinary(root, path);
    const after = lstatSync(path), consumed = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || consumed.size !== opened.size || consumed.mtimeMs !== opened.mtimeMs) throw new Error();
    return value;
  } catch { throw new RuntimeConfigurationError(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function readPrivateRuntimeProfile(packageRoot: string, name: string): unknown {
  return readPrivateProfile(packageRoot, name, runtimeProfilePath);
}

/** Migration authority is selected separately and cannot be used by the API. */
export function readPrivateMigrationProfile(packageRoot: string, name: string): unknown {
  return readPrivateProfile(packageRoot, name, ".local-data/operators/mysql-crm-migration.json");
}

/** Separate explicit first-administrator request, never loaded by startup. */
export function readPrivateNativeAdminRequest(packageRoot: string, name: string): unknown {
  return readPrivateProfile(packageRoot, name, ".local-data/operators/native-admin-bootstrap.json");
}

/** Separate explicit verified custom Zoho user binding; never read by startup. */
export function readPrivateZohoBindingRequest(packageRoot: string, name: string): unknown {
  return readPrivateProfile(packageRoot, name, ".local-data/operators/zoho-user-binding.json");
}
