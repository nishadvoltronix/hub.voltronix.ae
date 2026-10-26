import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--manifest" || !/^\.local-data\/reports\/mysql-port-preservation-[a-f0-9-]{36}\.json$/.test(args[1]!)) throw new Error();
  const app = realpathSync(process.cwd()), workspace = app;
  const manifest = JSON.parse(readFileSync(resolve(app, args[1]!), "utf8")) as { files: { path: string; sha256: string }[] };
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error();
  let unchanged = 0;
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error();
    const filename = resolve(workspace, file.path), within = relative(workspace, filename);
    if (!within || isAbsolute(within) || within.startsWith("..")) throw new Error();
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    if (createHash("sha256").update(readFileSync(filename)).digest("hex") !== file.sha256) throw new Error();
    unchanged++;
  }
  console.log(JSON.stringify({ status: "PASS", existingDataAndEnvironmentFiles: manifest.files.length, unchanged,
    contentsDisclosed: false, note: "Existing pre-port files only; new owned synthetic fixtures are separate." }));
} catch { console.error("FAIL: preservation manifest or an existing data/environment file did not validate. No file contents or individual private hashes were logged."); process.exitCode = 1; }
