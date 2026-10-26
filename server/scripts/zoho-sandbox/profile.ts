import { z } from "zod";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { assertOrdinaryPath, HarnessFiles, privateAccess } from "../mysql-auth/files.js";

export const sandboxProfilePath = ".local-data/operators/zoho-sandbox.json";
const token = z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/);
const schema = z.object({ version: z.literal(1), environment: z.literal("sandbox"), clientId: token,
  clientSecret: token, refreshToken: token, organizationId: z.string().regex(/^[1-9][0-9]{0,29}$/),
  createdAt: z.iso.datetime() }).strict();
export type SandboxProfile = z.infer<typeof schema>;
export class SandboxSetupError extends Error {
  constructor(message = "Sandbox setup/check refused. Check the private sandbox profile and selected US sandbox organization; no production setting was changed.") {
    super(message); this.name = "SandboxSetupError";
  }
}
export function validateSandboxProfile(value: unknown): SandboxProfile {
  try { return schema.parse(value); } catch { throw new SandboxSetupError(); }
}
export function readSandboxProfile(packageRoot: string, privacy: (path: string) => void = privateAccess): SandboxProfile {
  let fd: number | undefined;
  try {
    const root = resolve(packageRoot), path = resolve(root, sandboxProfilePath);
    assertOrdinaryPath(root, path);
    if (!lstatSync(root).isDirectory()) throw new Error();
    for (const name of [".local-data", ".local-data/operators"]) {
      const directory = resolve(root, name);
      if (!lstatSync(directory).isDirectory()) throw new Error();
      privacy(directory);
    }
    privacy(path);
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > 16_384) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error();
    const bytes = Buffer.alloc(opened.size + 1); let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break; size += count;
    }
    if (size !== opened.size) throw new Error();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)).replace(/\r\n/g, "\n");
    const value: unknown = JSON.parse(source);
    if (source.trim() !== JSON.stringify(value, null, 2)) throw new Error();
    assertOrdinaryPath(root, path);
    for (const stat of [lstatSync(path), fstatSync(fd)]) {
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== opened.dev || stat.ino !== opened.ino
        || stat.size !== opened.size || stat.mtimeMs !== opened.mtimeMs || stat.ctimeMs !== opened.ctimeMs) throw new Error();
    }
    return validateSandboxProfile(value);
  } catch { throw new SandboxSetupError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function assertNewSandboxProfile(packageRoot: string): void {
  try {
    const root = resolve(packageRoot);
    if (new HarnessFiles(root).exists(sandboxProfilePath)) throw new Error();
    // Refuse unsafe existing parents before the operator consumes a short-lived
    // OAuth code. Missing containers are created privately only after consent.
    for (const name of [".local-data", ".local-data/operators"]) {
      const directory = resolve(root, name);
      let stat;
      try { stat = lstatSync(directory); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") break;
        throw error;
      }
      assertOrdinaryPath(root, directory);
      if (!stat.isDirectory()) throw new Error();
      privateAccess(directory);
    }
  } catch { throw new SandboxSetupError("A sandbox profile already exists or its path is unsafe. Use zoho:sandbox:check; no profile is replaced automatically."); }
}
/** Writes only a newly verified sandbox grant; never changes server/.env. */
export function saveNewSandboxProfile(root: string, value: unknown): void {
  const profile = validateSandboxProfile(value);
  try {
    const files = new HarnessFiles(root);
    assertNewSandboxProfile(root);
    files.ensureContainer(".local-data/operators");
    files.writeNew(sandboxProfilePath, profile);
  } catch { throw new SandboxSetupError("Sandbox profile could not be saved privately. Existing files were not overwritten; inspect the private profile path before retrying."); }
}
