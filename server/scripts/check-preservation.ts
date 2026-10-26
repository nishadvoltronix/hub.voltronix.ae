import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ordinaryPath, preservedPath } from "../../tools/preservation-paths.mjs";

// Read-only fingerprints against retained references. Never opens a database
// driver, creates a report/baseline, or prints private contents/fingerprints.
const workspace = resolve(fileURLToPath(new URL("../..", import.meta.url)));
interface Entry { path: string; sha256: string }
function ordinary(name: string): string {
  return ordinaryPath(workspace, name);
}
function json(name: string): unknown { return JSON.parse(readFileSync(ordinary(name), "utf8").replace(/^\uFEFF/, "")); }
function check(entries: Entry[], expected: number): number {
  if (!Array.isArray(entries) || entries.length !== expected) throw new Error();
  for (const entry of entries) {
    // This retained reference predates relative-path receipts. Convert only to a
    // workspace-relative name; the shared resolver rejects any outside target.
    const name = typeof entry.path === "string" && isAbsolute(entry.path) ? relative(workspace, entry.path) : entry.path;
    if (typeof entry.path !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)
      || createHash("sha256").update(readFileSync(preservedPath(workspace, name))).digest("hex") !== entry.sha256.toLowerCase()) throw new Error();
  }
  return entries.length;
}
try {
  if (process.argv.length !== 2) throw new Error();
  const original = json("nextjs/.local-data/reports/mysql-port-preservation-48911382-49c1-4369-a06e-a632ac0837bf.json") as { files: Entry[] };
  const recent = json("nextjs/.local-data/reports/express-auth-harness-offline-eb394a8c-7dd4-4710-8afa-7e2831a4cc30/unchanged-inputs.json") as Entry[];
  if (!Array.isArray(recent)) throw new Error();
  console.log(JSON.stringify({ status: "PASS", originalDataAndEnvironmentInputs: check(original.files, 46),
    newerEnvironmentInputs: check(recent.filter(entry => basename(entry.path).startsWith(".env")), 7),
    databaseConnections: 0, contentsDisclosed: false, limitation: "Retained reference fingerprints with explicit archived-template mapping; no database opened or baseline regenerated." }));
} catch {
  console.error(JSON.stringify({ status: "FAIL", check: "PRESERVED_INPUTS", databaseConnections: 0, contentsDisclosed: false }));
  process.exitCode = 1;
}
