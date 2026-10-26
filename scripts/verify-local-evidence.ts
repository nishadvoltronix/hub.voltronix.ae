import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { isPreservedFontNotice, originalFontNoticePath, preservedFontNoticePath } from "./preserved-font-notice";
import { ordinaryPath, preservedPath } from "../tools/preservation-paths.mjs";

// Read-only acceptance checks. Never load environment files or print file contents.
const app = process.cwd();
const root = resolve(app);
const baseline = "20d85bae695b3a122aefdb3ee27388a70c53dcbc253f6920e461540615e1b328";
let stage = "workspace";
function requireCheck(condition: unknown): asserts condition {
  if (!condition) throw new Error("Local evidence check failed");
}
function regularFile(filename: string) {
  const stat = lstatSync(filename);
  requireCheck(stat.isFile() && !stat.isSymbolicLink());
}
function walk(directory: string): string[] {
  const stat = lstatSync(directory);
  requireCheck(stat.isDirectory() && !stat.isSymbolicLink());
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    requireCheck(!entry.isSymbolicLink());
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) return walk(filename);
    regularFile(filename);
    return [filename];
  });
}
function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  requireCheck(!result.error && result.status === 0);
  return result.stdout;
}
function normalized(filename: string): string { return filename.replaceAll("\\", "/"); }
function privatePath(filename: string): boolean {
  const parts = normalized(filename).split("/");
  return parts.some((part) => /^(?:\.local-data|\.local-dev|\.private|\.private-legacy|backups|uploads)$/i.test(part)
    || (/^\.env(?:\.|$)/i.test(part) && ![".env.example", ".env.mysql.example"].includes(part))
    || /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(part)
    || /(?:-journal|\.(?:backup|bak|pem|key|php\d*|phtml|sql))$/i.test(part));
}

// These passive files intentionally preserve the original PHP asset bytes,
// including legacy formatting. Never grant style exemptions by directory alone.
function verifiedLegacyAssets(): Set<string> {
  const allowed = new Set([
    "css/hrms.css", "css/style.css", "css/style-preset.css", "css/jquery.dataTables.min.css", "css/select2.min.css",
    "css/plugins/phosphor-icons.css", "css/plugins/tabler-icons.min.css", "images/logo-voltronix.png",
    "images/voltronix_logo.png", "images/favicon_voltronix.png", "images/authentication/img-auth-bg-2.jpg",
    "css/plugins/Phosphor.woff2", "css/plugins/Phosphor.woff", "css/plugins/Phosphor.ttf", "css/plugins/Phosphor.svg",
    "css/plugins/fonts/tabler-icons.woff2", "css/plugins/fonts/tabler-icons.woff", "css/plugins/fonts/tabler-icons.ttf",
  ]);
  const manifest: unknown = JSON.parse(readFileSync(join(app, "public/legacy/manifest.json"), "utf8"));
  requireCheck(manifest && typeof manifest === "object" && "source" in manifest && manifest.source === "include/dist/assets"
    && "files" in manifest && Array.isArray(manifest.files) && manifest.files.length === allowed.size);
  const verified = new Set<string>();
  for (const entry of manifest.files) {
    requireCheck(entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string"
      && allowed.delete(entry.path) && "sha256" in entry && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256)
      && "bytes" in entry && Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
    const copy = `public/legacy/assets/${entry.path}`;
    for (const name of [`include/dist/assets/${entry.path}`, copy]) {
      const filename = preservedPath(root, name);
      regularFile(filename);
      requireCheck(realpathSync(filename).toLowerCase() === filename.toLowerCase());
      const content = readFileSync(filename);
      requireCheck(content.length === entry.bytes && createHash("sha256").update(content).digest("hex") === entry.sha256);
    }
    verified.add(copy);
  }
  requireCheck(allowed.size === 0);
  return verified;
}

try {
  requireCheck(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).name === "voltronix-crm");
  stage = "original-file preservation";
  // The established hash includes Windows separators for recursively discovered names,
  // but literal forward slashes for the appended paths. Preserve that exact contract.
  const originals = ["application", "system", "assets", "include"].flatMap((directory) => {
    const originalDirectory = preservedPath(root, directory, "directory");
    return walk(originalDirectory).map((filename) => win32.join(directory, ...normalized(relative(originalDirectory, filename)).split("/")));
  });
  originals.push("index.php", "readme.rst", "composer.json", "composer.lock", ".gitignore", ".htaccess",
    "start-local.ps1", "stop-local.ps1", ".local-dev/crm.sqlite", ".local-dev/schema.sql");
  const digest = createHash("sha256");
  for (const name of originals.sort()) {
    const filename = preservedPath(root, name);
    regularFile(filename);
    digest.update(name);
    digest.update(readFileSync(filename));
  }
  const originalSha256 = digest.digest("hex");
  requireCheck(originals.length === 2638 && originalSha256 === baseline);

  stage = "production file traces";
  // Next's .next/node_modules contains generated dependency junctions. Traces are
  // emitted at the build root and below server; do not traverse those junctions.
  const build = join(app, ".next");
  const manifests = [...walk(join(build, "server")), ...readdirSync(build, { withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(build, entry.name))]
    .filter((filename) => filename.endsWith(".nft.json"));
  requireCheck(manifests.length > 0);
  stage = "quotation trace presence";
  const pdfManifest = join(app, ".next/server/app/api/quotations/[taskId]/pdf/route.js.nft.json");
  requireCheck(manifests.includes(pdfManifest));
  const pdfFiles = new Set<string>();
  stage = "trace privacy";
  for (const filename of manifests) {
    const manifest: unknown = JSON.parse(readFileSync(filename, "utf8"));
    requireCheck(manifest && typeof manifest === "object" && "files" in manifest && Array.isArray(manifest.files));
    for (const entry of manifest.files) {
      requireCheck(typeof entry === "string" && !privatePath(entry));
      // Resolve too: a harmless-looking relative name must not resolve into private data.
      const target = resolve(dirname(filename), entry);
      requireCheck(!privatePath(target));
      // Dependency junctions are normal, but their actual targets must also be
      // present and public. Lexical path checks alone can conceal private data.
      const actualTarget = realpathSync(target);
      requireCheck(!privatePath(actualTarget));
      // SQLite remains installed for preserved tests/tools, never a runtime fallback.
      requireCheck(!/(?:^|\/)(?:better-sqlite3|sqlite-reference)(?:\/|$)/i.test(normalized(actualTarget)));
      const targetStat = lstatSync(actualTarget);
      // Turbopack traces its external-package directory junctions alongside files.
      requireCheck(!targetStat.isSymbolicLink() && (targetStat.isFile() || targetStat.isDirectory()));
      if (filename === pdfManifest) pdfFiles.add(target);
    }
  }
  const requiredPdfFiles = [
    ...walk(join(app, "resources/quotation-pdf")),
    ...walk(join(app, "node_modules/pdfkit/js/data")),
  ];
  stage = "quotation trace assets";
  requireCheck(requiredPdfFiles.length > 0 && requiredPdfFiles.every((filename) => pdfFiles.has(filename)));

  stage = "private-file Git exclusions";
  const packagePrivateProbes = [".env.local", ".env.mysql.local", ".env.mysql.runtime.local", ".env.mysql.migration.local", ".local-data/mysql-server/probe", ".local-data/development/crm.sqlite", "probe.sqlite", "probe.sqlite3", "probe.db",
    "probe.sqlite-wal", "probe.sqlite-shm", "probe.sqlite-journal", "backups/probe.sqlite", ".private/probe", "probe.backup"];
  const ignoreProbes = ["", "server", "nextjs"].flatMap(directory => packagePrivateProbes.map(filename => directory ? `${directory}/${filename}` : filename));
  ignoreProbes.push(".private-legacy/source-20261014/probe.php", "assets/photos/probe.pdf", ".local-dev/probe.sqlite");
  const ignored = new Set(git(["check-ignore", "--no-index", "--", ...ignoreProbes]).trim().split(/\r?\n/));
  requireCheck(ignoreProbes.every((filename) => ignored.has(filename)));
  ordinaryPath(root, ".env.example");
  const envExample = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", ".env.example"], { cwd: root, windowsHide: true });
  requireCheck(!envExample.error && envExample.status === 1);
  requireCheck(!readdirSync(app).some(name => /^\.env(?:\.|$)/i.test(name) && name !== ".env.example"));

  stage = "preserved legacy visual assets";
  const legacyAssets = verifiedLegacyAssets();
  stage = "preserved font legal notice";
  for (const name of [originalFontNoticePath, preservedFontNoticePath]) {
    const filename = preservedPath(root, name);
    regularFile(filename);
    requireCheck(realpathSync(filename).toLowerCase() === filename.toLowerCase());
  }
  requireCheck(isPreservedFontNotice(preservedFontNoticePath,
    readFileSync(preservedPath(root, preservedFontNoticePath)), readFileSync(preservedPath(root, originalFontNoticePath))));
  stage = "deliverable hygiene";
  const deliverables = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "docs", "src", "tests", "scripts", "public", "resources",
    "package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "eslint.config.mjs", ".env.example"])
    .split("\0").filter(Boolean))];
  requireCheck(deliverables.length > 0);
  let textFiles = 0, preservedAssetWhitespaceFiles = 0, preservedLicenseWhitespaceFiles = 0;
  for (const name of deliverables) {
    requireCheck(!privatePath(name));
    const filename = resolve(root, name);
    regularFile(filename);
    if (!/\.(?:md|rst|[cm]?js|tsx?|ps1|json|css|html|txt|yml|yaml)$|(?:^|\/)(?:\.gitignore|\.htaccess|\.env(?:\.mysql)?\.example)$/i.test(name)) continue;
    const content = readFileSync(filename, "utf8");
    textFiles++;
    const legacyWhitespace = /[\t ]+\r?$/m.test(content);
    requireCheck(!legacyWhitespace || legacyAssets.has(name) || name === preservedFontNoticePath);
    if (legacyWhitespace && legacyAssets.has(name)) preservedAssetWhitespaceFiles++;
    if (legacyWhitespace && name === preservedFontNoticePath) preservedLicenseWhitespaceFiles++;
    // Deliberately limited signatures, not a claim to recognize arbitrary secrets.
    requireCheck(!/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(content));
    requireCheck(!/\b1000\.[a-f\d]{32}\.[a-f\d]{32}\b/i.test(content));
  }
  console.log(JSON.stringify({ status: "PASS", originalFiles: originals.length, originalBaselineMatched: true,
    buildTraceManifests: manifests.length, privateTraceReferences: 0, sqliteRuntimeTraceReferences: 0, requiredPdfFiles: requiredPdfFiles.length,
    gitIgnoreProbes: ignoreProbes.length, envExampleIncludable: true, frontendRuntimeEnvFiles: 0, deliverableFiles: deliverables.length,
    textFilesChecked: textFiles, trailingWhitespaceFiles: 0, byteIdenticalLegacyAssets: legacyAssets.size,
    preservedAssetWhitespaceFiles, preservedLicenseWhitespaceFiles, privateDeliverables: 0, limitedSecretSignatureMatches: 0,
    targetHostVerified: false }, null, 2));
} catch {
  console.error(`Local evidence verification failed during ${stage}. No files were changed; file contents were not logged.`);
  process.exitCode = 1;
}
