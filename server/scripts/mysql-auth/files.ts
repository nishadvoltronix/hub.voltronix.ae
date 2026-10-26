import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { HarnessRefusal, targetFor } from "./guard.js";

const equalPath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(root: string, path: string): boolean { const r = relative(root, path); return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); }
export function assertOrdinaryPath(root: string, path: string): void {
  try {
    if (!inside(root, path)) throw new Error();
    let current = root;
    for (const segment of ["", ...relative(root, path).split(sep).filter(Boolean)]) {
      if (segment) current = join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !equalPath(realpathSync(current), current)) throw new Error();
    }
  } catch { throw new HarnessRefusal("PRIVATE_FILE"); }
}

/** Native ACL checks emit no ACL values or path/contents. Only newly created
 * directories may be restricted; existing ACLs are inspected, never changed.
 */
export function privateAccess(path: string, newlyCreated = false): void {
  try {
    if (process.platform !== "win32") {
      const stat = lstatSync(path);
      if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error();
      return;
    }
    const script = `$ErrorActionPreference='Stop'; try {
      $target=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');
      ${newlyCreated ? `$acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false);
      foreach($principal in @($sid,$system)) { $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }
      Set-Acl -LiteralPath $target -AclObject $acl;` : ""}
      $acl=Get-Acl -LiteralPath $target; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }
      $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); $current=$false;
      foreach($rule in $rules) {
        if($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid.Value,$system.Value)) { exit 2 }
        if($rule.IdentityReference.Value -eq $sid.Value -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)) { $current=$true }
      }; if(-not $current) { exit 2 }; exit 0
    } catch { exit 2 }`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { input: path, stdio: ["pipe", "ignore", "ignore"], timeout: 10_000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error();
  } catch { throw new HarnessRefusal("PRIVATE_FILE"); }
}
export function canonicalJson(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }
export function fingerprint(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

/** Explicit backend-relative private tree, never Next profiles or cwd discovery. */
export class HarnessFiles {
  readonly root: string;
  constructor(root: string, private readonly privacy = privateAccess) {
    this.root = resolve(root); assertOrdinaryPath(this.root, this.root);
  }
  approvalPath(id: string) { targetFor(id); return `.local-data/approvals/mysql-auth-${id}.json`; }
  fixtureRoot(id: string) { targetFor(id); return `.local-data/test/mysql-auth-${id}`; }
  operatorPath = ".local-data/operators/mysql-auth-operator.json";
  path(name: string): string {
    if (!/^\.local-data\/(?:approvals|operators|test)(?:\/[A-Za-z0-9_.-]+)+$/.test(name) || name.split("/").some(part => part === "..")) throw new HarnessRefusal("PRIVATE_FILE");
    return resolve(this.root, name);
  }
  exists(name: string): boolean {
    const path = this.path(name);
    if (!existsSync(path)) return false;
    assertOrdinaryPath(this.root, path); return true;
  }
  privateAncestors(path: string): void {
    const parent = resolve(path, ".."); let current = this.root;
    for (const segment of relative(this.root, parent).split(sep).filter(Boolean)) {
      current = join(current, segment); assertOrdinaryPath(this.root, current); this.privacy(current);
    }
  }
  ensureContainer(name: ".local-data" | ".local-data/approvals" | ".local-data/operators" | ".local-data/test") {
    let current = this.root;
    for (const part of name.split("/")) {
      current = join(current, part);
      if (!existsSync(current)) { mkdirSync(current, { mode: 0o700 }); this.privacy(current, true); }
      assertOrdinaryPath(this.root, current);
      if (!lstatSync(current).isDirectory()) throw new HarnessRefusal("PRIVATE_FILE");
      this.privacy(current);
    }
  }
  createFixture(id: string): string {
    this.ensureContainer(".local-data/test");
    const relativeRoot = this.fixtureRoot(id), path = this.path(relativeRoot);
    try { mkdirSync(path, { mode: 0o700 }); } catch { throw new HarnessRefusal("OWNERSHIP"); }
    this.privacy(path, true); assertOrdinaryPath(this.root, path); return relativeRoot;
  }
  read(name: string): unknown {
    let fd: number | undefined;
    try {
      const path = this.path(name); assertOrdinaryPath(this.root, path); this.privateAncestors(path); this.privacy(path);
      const before = lstatSync(path);
      if (!before.isFile() || before.nlink !== 1 || before.size > 16_384) throw new Error();
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size > 16_384) throw new Error();
      const source = readFileSync(fd, "utf8").replace(/\r\n/g, "\n");
      const parsed: unknown = JSON.parse(source);
      // Canonical templates reject duplicate keys and ignored/ambiguous syntax.
      if (source.trim() !== canonicalJson(parsed).trim()) throw new Error();
      assertOrdinaryPath(this.root, path);
      const after = lstatSync(path), consumed = fstatSync(fd);
      if (after.ino !== opened.ino || after.dev !== opened.dev || after.nlink !== 1
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || consumed.size !== opened.size || consumed.mtimeMs !== opened.mtimeMs) throw new Error();
      return parsed;
    } catch { throw new HarnessRefusal("PRIVATE_FILE"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  writeNew(name: string, value: unknown): void {
    let fd: number | undefined;
    try {
      const path = this.path(name), parent = resolve(path, "..");
      assertOrdinaryPath(this.root, parent); this.privateAncestors(path); this.privacy(parent);
      const bytes = Buffer.from(canonicalJson(value)); if (bytes.length > 16_384) throw new Error();
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd); this.privacy(path); assertOrdinaryPath(this.root, path);
    } catch { throw new HarnessRefusal("STATE"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}

/** Public source/lock fingerprint is retained privately, never printed. */
export function harnessDigest(root: string): string {
  const workspace = resolve(root, ".."), digest = createHash("sha256");
  function visit(path: string) {
    assertOrdinaryPath(workspace, path); const stat = lstatSync(path);
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); return; }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2_000_000) throw new HarnessRefusal("PRIVATE_FILE");
    digest.update(relative(workspace, path).replaceAll("\\", "/") + "\0").update(readFileSync(path)).update("\0");
  }
  for (const part of ["src", "scripts", "tests"]) visit(join(root, part));
  for (const part of ["package.json", "package-lock.json", "tsconfig.server.json", "tsconfig.server.build.json"]) visit(join(workspace, part));
  return digest.digest("hex");
}
