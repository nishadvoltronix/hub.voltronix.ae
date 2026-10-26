import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ordinaryPath, preservedPath } from "../../tools/preservation-paths.mjs";

// Read retained, immutable evidence only. No database drivers, writes, generated
// baselines, private filenames, fingerprints, or file contents in the output.
const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidence = "nextjs/.local-data/reports/gap-acceptance-f0a65126-a253-419f-af18-c4949ba65909";
function json(name: string): unknown {
  return JSON.parse(readFileSync(ordinaryPath(workspace, `${evidence}/${name}`), "utf8").replace(/^\uFEFF/, ""));
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}
function verify(value: unknown, expected: number): number {
  const entries = Object.entries(record(value));
  if (entries.length !== expected) throw new Error();
  for (const [name, digest] of entries) {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)
      || createHash("sha256").update(readFileSync(preservedPath(workspace, name))).digest("hex") !== digest) throw new Error();
  }
  return entries.length;
}

try {
  if (process.argv.length !== 2) throw new Error();
  const privateArtifacts = verify(record(json("private-artifacts-before.json")).files, 5979);
  const originalUploads = verify(record(json("original-upload-before.json")).files, 503);
  const source = record(record(json("source-before.json")).hashes);
  const original = Object.fromEntries(Object.entries(source).filter(([name]) => !/^(?:backend|docs|nextjs|shared)\//.test(name)));
  const originalSourceFiles = verify(original, 2631);
  const modified = ["application/libraries/Rbac.php", "application/models/Admin.php", "application/models/Reports_model.php"];
  const preExistingPhpModifications = verify(Object.fromEntries(modified.map(name => [name, source[name]])), 3);
  console.log(JSON.stringify({ status: "PASS", privateArtifacts, originalUploads, originalSourceFiles,
    preExistingPhpModifications, originalBaselineChanged: false, databaseConnections: 0, writes: 0, contentsDisclosed: false,
    limitation: "Historical byte preservation with explicit archive mapping; not historical ownership or target-host acceptance." }));
} catch {
  console.error(JSON.stringify({ status: "FAIL", check: "ARCHIVED_PRESERVATION", databaseConnections: 0, writes: 0, contentsDisclosed: false }));
  process.exitCode = 1;
}
