import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// Historical references keep their original names and hashes. Only the owner's
// explicit source relocation is translated; there is no fallback or rebasing.
export const legacyArchive = ".private-legacy/source-20261014";
const archivedTrees = new Set(["application", "include", "system", "vendor"]);
const archivedCopies = new Set([
  ".gitignore", "start-local.ps1", "start-sqlite-demo.ps1", "stop-local.ps1",
  "nextjs/.env.example", "nextjs/.env.mysql.example",
]);
const archivedFiles = new Set(["index.php", "composer.json", "composer.lock", ".htaccess", "readme.rst"]);

function safeRelative(name) {
  if (typeof name !== "string" || !name || /[:\0-\x1f\x7f]/.test(name) || isAbsolute(name)) throw new Error("Invalid preservation path.");
  const normalized = name.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error("Invalid preservation path.");
  return normalized;
}

export function historicalRelativePath(name) {
  const normalized = safeRelative(name);
  const [first, second] = normalized.split("/");
  if (archivedTrees.has(first) || archivedFiles.has(normalized) || archivedCopies.has(normalized)) return `${legacyArchive}/${normalized}`;
  if (first === "nextjs" && second && ![".local-data", ".private", "backups"].includes(second)
    && !/^\.env(?:\.|$)/.test(second)) {
    const current = normalized.slice("nextjs/".length);
    return current.startsWith('assets/quotation-pdf/') ? `resources/${current.slice('assets/'.length)}` : current;
  }
  if (first === 'frontend') {
    const current = normalized.slice('frontend/'.length);
    return current.startsWith('assets/quotation-pdf/') ? `resources/${current.slice('assets/'.length)}` : current;
  }
  if (first === 'backend') return `server/${normalized.slice('backend/'.length)}`;
  return normalized;
}

export function ordinaryPath(workspace, name, kind = "file") {
  if (!["file", "directory"].includes(kind)) throw new Error("Invalid preservation path kind.");
  const normalized = safeRelative(name);
  const root = resolve(workspace), target = resolve(root, ...normalized.split("/"));
  const within = relative(root, target);
  if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) throw new Error("Invalid preservation path.");
  const comparable = value => process.platform === "win32" ? value.toLowerCase() : value;
  let current = root;
  for (const part of ["", ...within.split(sep)]) {
    if (part) current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || comparable(realpathSync(current)) !== comparable(current)) throw new Error("Nonordinary preservation path.");
  }
  const stat = lstatSync(target);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new Error("Unexpected preservation path kind.");
  return target;
}

export function preservedPath(workspace, name, kind = "file") {
  return ordinaryPath(workspace, historicalRelativePath(name), kind);
}
