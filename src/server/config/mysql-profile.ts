import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { parseLocalMysqlConfig } from "./mysql";

const allowedKeys = new Set(["DATABASE_PROVIDER", "MYSQL_ENVIRONMENT", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD"]);
const allowedProfiles = new Set([".env.mysql.local", ".env.mysql.runtime.local", ".env.mysql.migration.local"]);

/** Explicit, bounded private profile; no ambient environment or legacy config fallback. */
export function readMysqlProfile(args: readonly string[], root = process.cwd()) {
  if (args.length !== 2 || args[0] !== "--profile" || !allowedProfiles.has(args[1]!)) {
    throw new Error("Use an explicitly supported private MySQL profile from its reviewed local directory.");
  }
  let descriptor: number | undefined;
  try {
    const app = resolve(/* turbopackIgnore: true */ root);
    const samePath = (left: string, right: string) => process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase() : left === right;
    if (!samePath(realpathSync(/* turbopackIgnore: true */ app), app) || lstatSync(/* turbopackIgnore: true */ app).isSymbolicLink()) throw new Error();
    const filename = resolve(app, args[1]!);
    const before = lstatSync(/* turbopackIgnore: true */ filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8192 ||
        !samePath(realpathSync(/* turbopackIgnore: true */ filename), filename)) throw new Error();
    descriptor = openSync(/* turbopackIgnore: true */ filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 8192 || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
    const contents = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(contents) > 8192 || contents.includes("\0")) throw new Error();
    const seen = new Set<string>();
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      // A deliberately single-line subset: reject duplicate keys and ignored
      // malformed lines rather than accepting an ambiguous database selection.
      const match = /^\s*([A-Z_]+)\s*=\s*(?:'[^'\r\n]*'|"[^"\r\n]*"|[^'"`\r\n]*?)\s*(?:#.*)?$/.exec(line);
      const key = match?.[1];
      if (!key || !allowedKeys.has(key) || seen.has(key)) throw new Error();
      seen.add(key);
    }
    const values = parseEnv(contents);
    if (Object.keys(values).length !== seen.size || Object.keys(values).some((key) => !allowedKeys.has(key))) throw new Error();
    return parseLocalMysqlConfig(values);
  } catch {
    // Node/driver errors can include credentials or profile contents. Never relay them.
    throw new Error("Local MySQL profile is missing, unsafe or invalid. Check the public template; no values were logged.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
