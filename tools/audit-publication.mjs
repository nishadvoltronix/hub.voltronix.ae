import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is a read-only proposal, not an exporter or a promise of publication.
// No Git write, subprocess hook, network, copying, credential output or disk
// report-writing operation is implemented here. Private source bytes are never
// placed in the manifest, and unsafe candidates never receive a printed hash.
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const rootFiles = new Set([".editorconfig", "start-local.ps1", "start-sqlite-demo.ps1", "stop-local.ps1", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json", "tsconfig.server.build.json", "tsconfig.demo.json", "next.config.ts", "eslint.config.mjs", ".env.example"]);
const toolFiles = new Set([
  "tools/preservation-paths.mjs", "tools/preservation-paths.d.mts",
  "tools/audit-publication.mjs", "tools/audit-publication.test.mjs",
  "tools/audit-git-history.mjs", "tools/audit-git-history.test.mjs",
  "tools/publication-source-files.json",
  "tools/publication-reviewed-fixtures.json",
  "tools/deployment-templates.test.mjs",
  "tools/prepare-runtime-package.mjs", "tools/prepare-runtime-package.test.mjs",
  "tools/prepare-hub-package.mjs", "tools/prepare-hub-package.test.mjs",
  "tools/run-hub.mjs", "tools/run-hub.test.mjs",
  "tools/check-hub-zoho.mjs", "tools/check-hub-zoho.test.mjs",
  "tools/bootstrap-native-admin.mjs", "tools/bootstrap-native-admin.test.mjs",
  "tools/bind-zoho-user.mjs", "tools/bind-zoho-user.test.mjs",
  "tools/sync-zoho.mjs", "tools/sync-zoho.test.mjs",
  "tools/hub-foundation-smoke.mjs", "tools/development-smoke.mjs",
  "tools/hub-environment.mjs", "tools/hub-environment.test.mjs", "tools/singleproject-smoke.mjs",
  "tools/run-local.mjs", "tools/run-local.test.mjs", "tools/run-suite.mjs",
]);
// Reviewed placeholder deployment templates only; never admit arbitrary server
// configurations, EnvironmentFile contents, certificates or sibling files.
const deploymentFiles = new Set([
  "deploy/ubuntu/nginx.conf.example",
  "deploy/ubuntu/hub-crm.service",
]);
// Operational instructions contain placeholders, not actual target profiles or
// evidence. Other internal readiness reports and private handoffs stay excluded.
const deploymentDocuments = new Set([
  "docs/manual-deployment-guide.md", "docs/final-release-checklist.md",
  "docs/mysql-production-operator-guide.md", "docs/runtime-excluded-assets.md",
  "docs/staging-acceptance.md", "docs/backend-production-environment.md",
  "docs/legacy-production-compatibility.md", "docs/production-preparation-report.md",
  "docs/single-project-layout.md", "docs/hub-rename.md",
]);
const optionalProjectDocuments = new Set([
  "PROJECT-STRUCTURE.md", "docs/clean-project-verification.md", "docs/project-audit.md",
]);
const configNames = new Set(["package.json", "package-lock.json", ".gitignore", "eslint.config.mjs", "next.config.ts", "tsconfig.json", "tsconfig.build.json", "tsconfig.sqlite-demo.json"]);
const codeExtensions = new Set([".ts", ".tsx", ".mts", ".mjs", ".json", ".css", ".ps1"]);
const privateSegments = new Set([".git", "node_modules", ".next", "dist", "out", "coverage", "playwright-report", "test-results", ".local-data", ".local-dev", ".private", ".private-legacy", "uploads", "backups", ".credentials", "credentials", "secrets"]);
const sourceRoots = ["server/src", "server/tests", "server/scripts", "server/demo-sqlite", "src", "tests", "scripts", "shared/contracts/src"];
const sources = ["server", "src", "tests", "scripts", "public", "resources", "shared/contracts", "tools"];
const mappings = [
  { source: "docs/PUBLICATION-README.md", target: "README.md" },
  { source: "docs/PUBLICATION.gitignore", target: ".gitignore" },
];
const templates = {
  "server/.env.example": {
    CRM_API_ENVIRONMENT: "development", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3002", APP_ORIGIN: "http://127.0.0.1:3001",
    CRM_RUNTIME_ENABLE: "", CRM_RUNTIME_PROFILE: "", CRM_MYSQL_NETWORK_DISABLED: "1",
  },
  ".env.example": {
    NODE_ENV: "production", APP_ORIGIN: "https://hub.voltronix.ae", CRM_API_INSTANCE_ID: "hub-crm",
    CRM_DATABASE_MODE: "disabled", CRM_MYSQL_NETWORK_DISABLED: "1", ZOHO_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1",
    CRM_WEB_HOST: "127.0.0.1", CRM_WEB_PORT: "3301", CRM_FRONTEND_BACKEND: "express", CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3302",
    CRM_API_ENVIRONMENT: "production", CRM_API_HOST: "127.0.0.1", CRM_API_PORT: "3302",
  },
};

// Exact passive assets already used publicly by the local UI. An added binary,
// renamed upload or changed binary is refused, even if its extension looks safe.
// These are hashes of reviewed distributable assets, never credential hashes.
const assetHashes = new Map(Object.entries({
  "public/legacy/assets/css/plugins/Phosphor.svg": "0c1a7fffebe8e17ef8b60b1c6127e158b0ab4f1a948cd4fa22847a16ceebe77a",
  "public/legacy/assets/css/plugins/Phosphor.ttf": "06b91e022b7ee899a63efced879392a74f0bacbda54e4467e9f663220d173a10",
  "public/legacy/assets/css/plugins/Phosphor.woff": "396c5eae7f2dfb4d1f5432edd87109eda2f92a451b2167e43a26165b82770f75",
  "public/legacy/assets/css/plugins/Phosphor.woff2": "c2ea45ea05ff5c7df1936770c104725f2a68f43fd343f35f3da23a30b27de32a",
  "public/legacy/assets/css/plugins/fonts/tabler-icons.ttf": "b0d39c1acb6144884d8dfbd9ec9a40ce36db42dab592e63a187e1ca9bc445969",
  "public/legacy/assets/css/plugins/fonts/tabler-icons.woff": "a8b807ca0e7cbb913a28b20e36bb7af1013e1084371b6dc730427179473388dd",
  "public/legacy/assets/css/plugins/fonts/tabler-icons.woff2": "7d207e36cd664a55cffcb35e05beda0f761a66cfd79e9553157a1da554ce43ea",
  "public/legacy/assets/images/civilgif.gif": "26748c8a3e7e8a2a6e8ce195f38fd6db6645fc6869f20fb8fa7182323a571e3a",
  "public/legacy/assets/images/electricgif.gif": "8eeb93f28a20798776d407a16e6db4f3ad22aef0f4e0395cc030391a94a14d3d",
  "public/legacy/assets/images/favicon_voltronix.png": "23adf63d7c14b8e97206afd933c976bdc7ddfb1ce7ab318b6dbe9c50a332d037",
  "public/legacy/assets/images/logo-voltronix.png": "1f42753d22d5417639b261e7dde44f3fd507f0d2e72e2b6379910e5afbf76786",
  "public/legacy/assets/images/Maintenancemtn.gif": "ea82fe5065f6d1c4068ac91d099bf45b70e9ff39878469bc9b61015b9a019431",
  "public/legacy/assets/images/PM.gif": "f8a046fbc3f5aedb34dd34ab487fc5f86994631808aa483c748ae992f389c983",
  "public/legacy/assets/images/switchgear.gif": "9eb6b472ef2fa5ced5ca223e407e09f1bdc5b65bac137c2c9ac24441aebead87",
  "public/legacy/assets/images/voltronix_logo.png": "ba7fc202e7ea879151fa898c1e791ef2e1e387f87218f831f2462a8c2c4a3fa3",
  "public/legacy/assets/images/authentication/img-auth-bg-2.jpg": "4e628d3510fbdfbd7ac1a70f268c657f7285d620fb4350f0ffafa08fde1a6b0b",
}));
const fontHashes = {
  "Roboto-Regular.ttf": "92a62766331140ca5bc8bba52028422d276061ad5717c1ac508a118b619c6aec",
  "Roboto-Bold.ttf": "8e8cb127554bdd9c8685788dce557e2725a9b62e183d9151fb506b3007ca6a07",
  "DejaVuSansCondensed.ttf": "5d5bf19efa3fe5a0f77fbdb163668a6fa7e81ac9df470034f7c91ee863ba872d",
  "DejaVuSansCondensed-Bold.ttf": "ff6e1be053d61e93652a248c14930f5b777fe05a517ce783095e93f02e906c54",
  "Roboto-LICENSE.txt": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
  "DejaVuinfo.txt": "bc9b65c8952e1b2281819c5322adab87c27c330ff7b68434f063b59d219acdaf",
};
for (const root of ["resources/quotation-pdf", "server/assets/quotation-pdf"]) {
  for (const [name, hash] of Object.entries(fontHashes)) assetHashes.set(`${root}/${name}`, hash);
}
const themeTexts = new Set([
  "assets/css/hrms.css", "assets/css/style.css", "assets/css/style-preset.css", "assets/css/jquery.dataTables.min.css",
  "assets/css/select2.min.css", "assets/css/plugins/phosphor-icons.css", "assets/css/plugins/tabler-icons.min.css",
].map(name => `public/legacy/${name}`));

// Only the existing reviewed passive assets; callers cannot change their pins.
export const reviewedPassiveAssetPaths = Object.freeze([...assetHashes.keys()].sort());
export const reviewedThemeTextPaths = Object.freeze([...themeTexts].sort());

export function normalizePublicationPath(name) {
  if (typeof name !== "string" || !name || /[\\:\x00-\x1f\x7f]/.test(name) || isAbsolute(name)) throw new Error("Invalid publication path.");
  if (name.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error("Invalid publication path.");
  return name;
}

export function classifyPublicationPath(name) {
  try { normalizePublicationPath(name); } catch { return "invalid-path"; }
  const lower = name.toLowerCase(), parts = lower.split("/"), base = parts.at(-1);
  if (parts.some(part => privateSegments.has(part))) return "private-or-generated-path";
  if (Object.hasOwn(templates, name)) return "template";
  if (parts.some(part => /^\.env(?:\.|$)/.test(part)) || /(?:^|\/)config-templates\//.test(lower)) return "environment-not-approved";
  if (name.startsWith('shared/contracts/') && !name.slice('shared/contracts/'.length).includes('/') && configNames.has(name.slice('shared/contracts/'.length))) return "source";
  if (rootFiles.has(name)) return 'source';
  if (/\.(?:php\d*|phtml|phar|sql|sqlite\d*|db|bak|backup|zip|tgz|gz|7z|dump|pem|key|p12|pfx|log)(?:$|[-.])/.test(base)) return "private-or-legacy-file";
  if (deploymentDocuments.has(name) || optionalProjectDocuments.has(name)) return "source";
  if (/^(?:nextjs|assets|application|include|system|vendor|docs)\//.test(lower)) return "outside-positive-scope";
  if (rootFiles.has(name) || toolFiles.has(name) || deploymentFiles.has(name)) return "source";
  if (name === "public/legacy/manifest.json") return "private-original-derived-asset-or-provenance";
  if (assetHashes.has(name)) return "pinned-passive-asset";
  if (themeTexts.has(name)) return "source";
  if (/^(?:server\/assets|resources)\/quotation-pdf\//.test(name)) return "private-company-pdf-asset";
  if (sourceRoots.some(root => name.startsWith(`${root}/`)) && codeExtensions.has(extname(name))) {
    if (/\.(?:tsbuildinfo|map)$/.test(name) || /(?:credentials|secrets?|runtime[-_.]?profile|receipt|audit[-_.]?result)\.json$/i.test(base)) return "private-looking-data";
    return "source";
  }
  return "outside-positive-scope";
}

export function validateTemplate(path, bytes) {
  const expected = templates[path];
  if (!expected) return ["unapproved-environment-template"];
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return ["invalid-template-encoding"]; }
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || values.has(match[1]) || !Object.hasOwn(expected, match[1]) || expected[match[1]] !== match[2]) return ["unsafe-or-unexpected-template-value"];
    values.set(match[1], match[2]);
  }
  return values.size === Object.keys(expected).length ? [] : ["incomplete-template"];
}

const reviewableCategories = new Set(["literal-password-candidate", "literal-credential-candidate", "credential-bearing-url-candidate", "private-key-material", "environment-credential-candidate"]);
function fixturePath(path) {
  return /^(?:server\/tests\/|tests\/)/.test(path)
    || /^server\/demo-sqlite\/[^/]+\.test\.ts$/.test(path)
    || ["scripts/verify-mysql-offline-http.ts", "tools/audit-git-history.test.mjs", "tools/audit-publication.test.mjs", "tools/prepare-runtime-package.test.mjs",
      "tools/prepare-hub-package.test.mjs", "tools/run-hub.test.mjs", "tools/run-local.test.mjs", "tools/deployment-templates.test.mjs",
      "tools/hub-foundation-smoke.mjs", "tools/hub-environment.test.mjs", "tools/singleproject-smoke.mjs", "tools/check-hub-zoho.test.mjs",
      "tools/bootstrap-native-admin.test.mjs", "tools/bind-zoho-user.test.mjs", "tools/sync-zoho.test.mjs"].includes(path);
}
export function validateReviewedFixtures(records) {
  if (!Array.isArray(records)) throw new Error("Invalid reviewed fixture inventory.");
  const seen = new Set();
  for (const record of records) {
    normalizePublicationPath(record.path);
    if (!fixturePath(record.path) || seen.has(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256)
      || !Array.isArray(record.categories) || !record.categories.length || record.categories.some(value => !reviewableCategories.has(value))) throw new Error("Invalid reviewed fixture inventory.");
    seen.add(record.path);
  }
  return records;
}
export function reviewedFixtureFindings(path, bytes, findings, records) {
  const record = validateReviewedFixtures(records).find(row => row.path === path);
  return record && record.sha256 === sha256(bytes) ? findings.filter(category => !record.categories.includes(category)) : findings;
}

function increment(object, key) { object[key] = (object[key] ?? 0) + 1; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function samePath(a, b) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function ordinaryPath(root, name, expected) {
  normalizePublicationPath(name);
  let path = root;
  for (const part of name.split("/")) {
    path = resolve(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !samePath(realpathSync(path), path)) throw new Error("Nonordinary publication path.");
  }
  const stat = lstatSync(path);
  if (expected === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) throw new Error("Nonordinary publication path.");
  return { path, stat };
}

// All contents, including comments, are checked before hashing or reporting.
// Known credentials are kept only inside the supplied in-memory detector.
export function inspectCandidateContent(path, bytes, { knownCredentials = () => [], privateContent = () => [], genericCredentials = () => [] } = {}) {
  const kind = classifyPublicationPath(path);
  const findings = [...knownCredentials(bytes)];
  if (!["source", "template", "pinned-passive-asset"].includes(kind)) return [...findings, "path-not-allowlisted"];
  if (kind === "pinned-passive-asset") {
    const pinned = bytes.length <= MAX_ASSET_BYTES && sha256(bytes) === assetHashes.get(path);
    // The user requested this exact public favicon on 2026-10-19. Its reviewed
    // upload provenance alone is permitted; every other private/credential
    // finding, changed byte sequence and other asset path remains blocked.
    const approvedFavicon = pinned && path === "public/legacy/assets/images/favicon_voltronix.png";
    findings.push(...privateContent(bytes).filter(category => !(approvedFavicon && category === "historical-private-content:original-uploads")));
    if (!pinned) findings.push("unreviewed-passive-asset-bytes");
    return findings;
  }
  findings.push(...privateContent(bytes), ...genericCredentials(bytes));
  if (bytes.length > MAX_TEXT_BYTES) return [...findings, "content-size-limit"];
  if (bytes.includes(0) || /^(?:SQLite format 3|%PDF-|PK\x03\x04|\x1f\x8b)/.test(bytes.subarray(0, 32).toString("latin1"))) return [...findings, "binary-or-private-payload-in-source"];
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return [...findings, "invalid-source-encoding"]; }
  if (/^\s*(?:BEGIN TRANSACTION;|CREATE TABLE\s|INSERT INTO\s|-- MySQL dump|-- PostgreSQL database dump)/i.test(text)) findings.push("raw-database-export-content");
  if (extname(path) === ".json") {
    let data;
    try { data = JSON.parse(text); } catch { findings.push("invalid-json"); }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const keys = Object.keys(data);
      if (keys.some(key => /^(password|client_secret|access_token|refresh_token|session_token|serverUuid|approvedAt|expiresAt|approvals)$/i.test(key))) findings.push("private-profile-or-record-json");
    }
  }
  if (kind === "template") findings.push(...validateTemplate(path, bytes));
  return [...new Set(findings)];
}

function git(root, args) {
  return execFileSync("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function gitInventory(root, index = false) {
  const result = new Map();
  const bytes = git(root, index ? ["ls-files", "--stage", "-z"] : ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
  for (const entry of bytes.toString("utf8").split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"), metadata = entry.slice(0, tab).split(" "), path = entry.slice(tab + 1);
    const mode = metadata[0], hash = metadata[index ? 1 : 2];
    result.set(path, { mode, hash, stage: index ? metadata[2] : "0" });
  }
  return result;
}
function gitBlobHash(bytes) { return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"); }
function exclusionGroup(path) {
  const lower = path.toLowerCase();
  if (/^(assets\/photos|uploads)\//.test(lower)) return "original-uploads-and-company-assets";
  if (/(?:^|\/)\.env(?:\.|$)|(?:credentials|secret|zoho)/.test(lower)) return "credential-related-or-environment-paths";
  if (/\.(?:db|sqlite\d*|sql|dump)(?:$|[-.])/.test(lower)) return "database-paths";
  if (/^(application|include|system|vendor)\//.test(lower) || /\.php\d*$/.test(lower)) return "legacy-source";
  if (/^(\.local-dev|\.private-legacy|nextjs|docs)\//.test(lower)) return "private-or-internal-material";
  if (lower.startsWith("assets/")) return "other-original-assets";
  return "other-outside-publication-scope";
}

export function auditPublication(root, options = {}) {
  const workspace = resolve(root);
  if (!samePath(realpathSync(workspace), workspace) || lstatSync(workspace).isSymbolicLink()) throw new Error("Nonordinary publication workspace.");
  const files = [], rejected = [], excluded = {}, inventories = [], visitedSources = new Set(), reviewedSyntheticMatches = [];
  const detectors = options.detectors ?? {};
  const reviewedFixtures = validateReviewedFixtures(options.reviewedFixtures ?? []);
  const inventoryEntries = options.inventory === null ? null : options.inventory ?? JSON.parse(readFileSync(ordinaryPath(workspace, "tools/publication-source-files.json", "file").path, "utf8"));
  if (inventoryEntries !== null && (!Array.isArray(inventoryEntries) || new Set(inventoryEntries).size !== inventoryEntries.length)) throw new Error("Invalid frozen source inventory.");
  const inventory = inventoryEntries === null ? null : new Set(inventoryEntries);
  if (inventory) for (const name of inventory) normalizePublicationPath(name);
  function add(source, target = source, mapped = false) {
    visitedSources.add(source);
    if (inventory && !inventory.has(source)) { rejected.push({ path: target, reasons: ["source-not-in-frozen-review-inventory"] }); return; }
    let bytes, stat;
    try {
      ({ stat } = ordinaryPath(workspace, source, "file"));
      if (stat.size > (assetHashes.has(target) ? MAX_ASSET_BYTES : MAX_TEXT_BYTES)) throw new Error("Publication size limit.");
      bytes = readFileSync(resolve(workspace, ...source.split("/")));
    } catch {
      rejected.push({ path: target, reasons: ["missing-nonordinary-or-oversized-source"] });
      return;
    }
    const pathFindings = detectors.knownCredentials?.(Buffer.from(source)) ?? [];
    const reportPath = pathFindings.length ? "[redacted-unsafe-path]" : target;
    const contextualDetectors = { ...detectors, genericCredentials: content => {
      const findings = detectors.genericCredentials?.(content) ?? [];
      const remaining = reviewedFixtureFindings(source, content, findings, reviewedFixtures);
      if (remaining.length < findings.length) reviewedSyntheticMatches.push({ path: target, categories: findings.filter(category => !remaining.includes(category)) });
      return remaining;
    } };
    const reasons = inspectCandidateContent(mapped ? ".editorconfig" : target, bytes, contextualDetectors);
    if (reasons.length || pathFindings.length) { rejected.push({ path: reportPath, reasons: [...new Set([...reasons, ...pathFindings])] }); return; }
    files.push({ path: target, source, bytes: bytes.length, sha256: sha256(bytes) });
    inventories.push({ path: target, gitHash: gitBlobHash(bytes) });
  }
  function walk(name) {
    let path;
    try { ({ path } = ordinaryPath(workspace, name, "directory")); } catch { rejected.push({ path: name, reasons: ["nonordinary-source-directory"] }); return; }
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const child = `${name}/${entry.name}`;
      // Exclusion before opening means actual environment values/private roots
      // are not read, let alone copied, by this publication checker.
      if (privateSegments.has(entry.name.toLowerCase())) { increment(excluded, "private-or-generated-subtree"); continue; }
      if (entry.isSymbolicLink()) { rejected.push({ path: child, reasons: ["nonordinary-source-path"] }); continue; }
      if (entry.isDirectory()) {
        if (/^(?:server\/(?:src|tests|scripts|demo-sqlite|assets)|src|tests|scripts|public|resources)(?:\/|$)/.test(child) || child === "shared/contracts/src") walk(child);
        else increment(excluded, "outside-positive-subtree");
      } else {
        const kind = classifyPublicationPath(child);
        if (["source", "template", "pinned-passive-asset"].includes(kind)) add(child);
        else increment(excluded, kind);
      }
    }
  }
  for (const root of sources) walk(root);
  for (const path of rootFiles) add(path);
  for (const path of deploymentFiles) add(path);
  for (const path of deploymentDocuments) add(path);
  for (const path of optionalProjectDocuments) {
    try { lstatSync(resolve(workspace, path)); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    add(path);
  }
  for (const mapping of mappings) add(mapping.source, mapping.target, true);
  if (inventory) for (const source of inventory) if (!visitedSources.has(source)) rejected.push({ path: source, reasons: ["reviewed-source-missing-or-no-longer-eligible"] });
  for (const record of [...rejected, ...reviewedSyntheticMatches]) {
    if (detectors.knownCredentials?.(Buffer.from(record.path)).length) record.path = "[redacted-unsafe-path]";
  }
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  rejected.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const lowerPaths = new Set();
  for (const file of files) {
    const folded = file.path.toLowerCase();
    if (lowerPaths.has(folded)) rejected.push({ path: file.path, reasons: ["case-colliding-publication-target"] });
    lowerPaths.add(folded);
  }
  let diff = null;
  if (options.git !== false) {
    const head = gitInventory(workspace), index = gitInventory(workspace, true);
    const proposed = new Map(inventories.map(file => [file.path, file.gitHash]));
    const headExclusions = {}, indexExclusions = {}, changes = [];
    for (const [path] of head) if (!proposed.has(path)) increment(headExclusions, exclusionGroup(path));
    for (const [path] of index) if (!proposed.has(path)) increment(indexExclusions, exclusionGroup(path));
    for (const [path, hash] of proposed) {
      const classify = record => !record ? "add" : record.stage !== "0" || !["100644", "100755"].includes(record.mode) ? "unsafe-index-mode" : record.hash === hash ? "unchanged" : "modify";
      changes.push({ path, comparedWithHead: classify(head.get(path)), comparedWithIndex: classify(index.get(path)) });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path, "en"));
    diff = { trackedHeadFiles: head.size, trackedIndexFiles: index.size, excludedHeadFiles: headExclusions, excludedIndexFiles: indexExclusions, proposedFiles: changes };
  }
  return {
    version: 1, mode: "read-only-positive-allowlist-proposal", publicationDecision: "NO-GO",
    candidateContentChecks: rejected.length ? "FAIL-CLOSED" : ["knownCredentials", "privateContent", "genericCredentials"].some(key => typeof detectors[key] !== "function") ? "INCOMPLETE-SCANNERS" : "PASS-WITH-LIMITATIONS",
    scanners: { knownCommittedCredential: typeof detectors.knownCredentials === "function", historicalPrivateContent: typeof detectors.privateContent === "function", genericCredentials: typeof detectors.genericCredentials === "function" },
    candidateFiles: files.length, candidateBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    manifestSha256: sha256(Buffer.from(JSON.stringify(files))), excluded, rejected, reviewedSyntheticMatches, files, diff,
    limitations: [
      "No export, commit, history rewrite, credential use or external verification occurred.",
      "Credential rotation/revocation and a new authorized sanitized repository are still required.",
      "Company quotation images/signatures/stamps are excluded; approved private provisioning and fresh-checkout PDF verification are required.",
      "The requested public favicon is included only at its reviewed path and exact hash; its internal provenance manifest and all other unapproved historical uploads remain excluded.",
      "Internal docs, original uploads, private databases, archived PHP and actual environments are excluded; preservation/source-parity harnesses require the retained private workspace.",
      "This is bounded source scanning plus exact known credential/private-copy checks, not proof that every unknown or transformed secret is absent.",
      "Fresh exported-tree install/build/security verification and approved license/asset distribution decisions remain required before publication.",
    ],
  };
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== "--manifest")) throw new Error("Unsupported publication audit arguments.");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { createKnownCredentialDetector, scanCredentialPatterns, createPublicationContentDetector } = await import("./audit-git-history.mjs");
  const detectors = {
    knownCredentials: createKnownCredentialDetector(root),
    genericCredentials: scanCredentialPatterns,
    privateContent: createPublicationContentDetector(root),
  };
  const reviewedFixtures = JSON.parse(readFileSync(ordinaryPath(root, "tools/publication-reviewed-fixtures.json", "file").path, "utf8"));
  const result = auditPublication(root, { detectors, reviewedFixtures });
  const output = process.argv.includes("--manifest") ? result : {
    ...result, files: undefined,
    diff: result.diff ? { ...result.diff, proposedFiles: result.diff.proposedFiles.reduce((counts, row) => { increment(counts, row.comparedWithHead); return counts; }, {}) } : null,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (result.rejected.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Publication audit failed safely; no source or credential contents are displayed.\n"); process.exitCode = 1; });
}
