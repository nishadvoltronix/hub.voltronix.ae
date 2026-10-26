import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Offline foundation/auth evidence. Never imports application modules or opens private profiles/databases. */
class BoundaryFailure extends Error {
  constructor(readonly check: string) { super("Boundary verification failed."); }
}
function requireCheck(condition: unknown, check: string): asserts condition {
  if (!condition) throw new BoundaryFailure(check);
}
function object(value: unknown, check: string): Record<string, unknown> {
  requireCheck(value !== null && typeof value === "object" && !Array.isArray(value), check);
  return value as Record<string, unknown>;
}
const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(backendRoot, "..");
const contractsRoot = join(workspaceRoot, "shared", "contracts");
const builtinNames = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const backendImports = new Set(["express", "helmet", "bcryptjs", "zod", "mysql2/promise", "pdfkit", "fflate", "@voltronix/crm-contracts", "node:http", "node:net", "node:crypto", "node:async_hooks", "node:fs", "node:path", "node:url", "node:zlib", "node:child_process", "node:util", "node:timers/promises"]);
const pdfAssets = new Set(["databg.png", "switchgear_bg4.png", "sign.jpg", "stamp.jpg", "Roboto-Regular.ttf", "Roboto-Bold.ttf", "Roboto-LICENSE.txt", "DejaVuSansCondensed.ttf", "DejaVuSansCondensed-Bold.ttf", "DejaVuinfo.txt", "README.md"]);
const forbiddenSegments = new Set([
  ".local-data", ".private", ".private-legacy", ".local-dev", "backups", "node_modules", "nextjs", "frontend", "application", "system", "vendor",
]);
const sharedGlobals = new Set([
  "process", "Buffer", "global", "globalThis", "require", "Deno", "Bun", "__dirname", "__filename",
  "fetch", "WebSocket", "XMLHttpRequest", "eval", "Function",
]);

function contained(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}
function ordinaryPath(root: string, target: string): void {
  requireCheck(contained(root, target), "path-containment");
  const parts = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    requireCheck(existsSync(current), "required-path-missing");
    requireCheck(!lstatSync(current).isSymbolicLink(), "link-or-junction");
    requireCheck(contained(realpathSync(root), realpathSync(current)), "resolved-path-containment");
  }
}
function publicPath(name: string): boolean {
  const parts = name.replaceAll("\\", "/").split("/");
  return parts.every(part => !forbiddenSegments.has(part.toLowerCase()) && !part.toLowerCase().startsWith(".env"))
    && !/\.(?:php\d*|phtml|sqlite(?:3)?(?:[-.].*)?|db(?:[-.].*)?|sql|backup|bak|log)$/i.test(name);
}
function files(root: string, check: string): string[] {
  ordinaryPath(workspaceRoot, root);
  const result: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      ordinaryPath(root, target);
      requireCheck(publicPath(relative(root, target)), check);
      if (entry.isDirectory()) visit(target);
      else {
        requireCheck(entry.isFile(), "nonordinary-file");
        result.push(target);
      }
    }
  }
  visit(root);
  return result.sort();
}

function staticSpecifier(node: ts.Node): string {
  requireCheck(ts.isStringLiteralLike(node), "dynamic-import-specifier");
  return node.text;
}
function verifyImport(specifier: string, file: string, tree: string, shared: boolean, source: boolean): void {
  requireCheck(!specifier.includes("\\") && !specifier.includes("\0") && publicPath(specifier), "forbidden-import-path");
  requireCheck(!/^(?:next(?:\/|$)|server-only$|mysql(?:\/|$)|mariadb(?:\/|$)|better-sqlite3(?:\/|$)|sqlite3?(?:\/|$)|php(?:\/|$)|@\/server(?:\/|$))/i.test(specifier), "forbidden-runtime-import");
  if (specifier.startsWith("mysql2")) {
    requireCheck(!shared && specifier === "mysql2/promise" && /[\\/]db[\\/]mysql[\\/]driver\.(?:ts|js)$/.test(file), "mysql-driver-ownership");
  }
  if (specifier === "node:child_process") requireCheck(/[\\/]runtime[\\/]private-profile\.(?:ts|js)$/.test(file), "private-acl-process-ownership");
  if (specifier === "node:util") requireCheck(/[\\/]environment\.(?:ts|js)$/.test(file), "environment-parser-ownership");
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = resolve(dirname(file), specifier);
    requireCheck(contained(tree, target), "cross-package-relative-import");
    if (specifier === "./font-coverage.json" && /[\\/]crm[\\/]quotation-pdf[\\/]render\.(?:ts|js)$/.test(file)) {
      ordinaryPath(tree, target);
      return;
    }
    requireCheck(/\.js$/.test(target), "non-nodenext-relative-import");
    const candidates = source ? [target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".d.ts")] : [target];
    const existing = candidates.filter(candidate => existsSync(candidate));
    requireCheck(existing.length === 1, "relative-import-target");
    ordinaryPath(tree, existing[0]!);
    requireCheck(lstatSync(existing[0]!).isFile(), "relative-import-not-file");
    return;
  }
  requireCheck(!isAbsolute(specifier) && !specifier.startsWith("/") && !specifier.startsWith("#"), "absolute-or-aliased-import");
  if (shared) {
    requireCheck(!specifier.startsWith("node:") && !builtinNames.has(specifier), "shared-node-import");
    throw new BoundaryFailure("shared-external-import");
  }
  requireCheck(backendImports.has(specifier), "unreviewed-runtime-import");
}

function scanTree(root: string, shared: boolean, source: boolean) {
  const paths = files(root, "private-runtime-file");
  requireCheck(paths.length > 0, "empty-source-or-build");
  let imports = 0;
  for (const file of paths) {
    if (relative(root, file).replaceAll("\\", "/") === "crm/quotation-pdf/font-coverage.json" && !shared) {
      const points: unknown = JSON.parse(readFileSync(file, "utf8"));
      requireCheck(Array.isArray(points) && points.length > 0 && points.every(point => Number.isInteger(point) && point >= 0 && point <= 0x10ffff), "pdf-glyph-coverage-asset");
      continue;
    }
    requireCheck(source ? /\.ts$/.test(file) : /(?:\.js|\.d\.ts)$/.test(file), "unexpected-runtime-asset");
    const program = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true,
      file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    function inspect(node: ts.Node): void {
      let specifier: ts.Node | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier = node.moduleSpecifier;
      if (ts.isImportEqualsDeclaration(node)) {
        requireCheck(ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression, "indirect-import-equals");
        specifier = node.moduleReference.expression;
      }
      if (ts.isImportTypeNode(node)) {
        requireCheck(ts.isLiteralTypeNode(node.argument), "dynamic-type-import");
        specifier = node.argument.literal;
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        requireCheck(node.arguments.length === 1 && node.arguments[0], "dynamic-loader-arguments");
        specifier = node.arguments[0];
      }
      if (specifier) {
        verifyImport(staticSpecifier(specifier), file, root, shared, source);
        imports++;
      }
      if (shared) {
        // An erased DTO property (for example DashboardResult.global) is data,
        // not a reference to a runtime global. Executable references stay denied.
        const typeProperty = node.parent !== undefined && ts.isPropertySignature(node.parent) && node.parent.name === node;
        requireCheck(!(ts.isIdentifier(node) && sharedGlobals.has(node.text) && !typeProperty), "shared-runtime-global");
        requireCheck(!(ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword), "shared-import-meta");
        requireCheck(!(ts.isPropertyAccessExpression(node) && node.name.text === "env"), "shared-environment-access");
        requireCheck(!(ts.isElementAccessExpression(node) && node.argumentExpression
          && ts.isStringLiteralLike(node.argumentExpression) && ["env", "process"].includes(node.argumentExpression.text)), "shared-indirect-environment-access");
      }
      if (ts.isStringLiteralLike(node)) {
        requireCheck(!/\.php(?:[/?#]|$)|php-cgi|fastcgi|sqlite:|mysql:/i.test(node.text), "legacy-runtime-string");
      }
      ts.forEachChild(node, inspect);
    }
    inspect(program);
  }
  return { files: paths.length, imports };
}

function manifest(root: string, shared: boolean): void {
  const target = join(root, "package.json");
  ordinaryPath(workspaceRoot, target);
  const value = object(JSON.parse(readFileSync(target, "utf8")), "package-manifest");
  requireCheck(value.private === true && value.type === "module", "private-esm-package");
  requireCheck(value.bundledDependencies === undefined && value.bundleDependencies === undefined, "bundled-dependency");
  if (shared) {
    requireCheck(JSON.stringify(value.files) === '["dist"]', "package-files-allowlist");
    requireCheck(value.sideEffects === false && value.dependencies === undefined, "shared-runtime-dependency");
    requireCheck(JSON.stringify(value.exports) === '{".":{"types":"./dist/index.d.ts","import":"./dist/index.js","default":"./dist/index.js"}}', "shared-exports-boundary");
  } else {
    const dependencies = object(value.dependencies, "root-dependencies");
    const allowed = new Set(["@next/env", "@voltronix/crm-contracts", "bcryptjs", "better-sqlite3", "express", "fflate", "helmet",
      "mysql2", "next", "pdfkit", "react", "react-dom", "server-only", "zod"]);
    requireCheck(Object.keys(dependencies).every(name => allowed.has(name))
      && ["express", "helmet", "bcryptjs", "fflate", "mysql2", "pdfkit", "zod", "next", "react", "react-dom"]
        .every(name => typeof dependencies[name] === "string"), "root-dependency-allowlist");
    requireCheck(dependencies["@voltronix/crm-contracts"] === "file:./shared/contracts", "contracts-package-reference");
    requireCheck(!existsSync(join(backendRoot, "package.json")) && !existsSync(join(backendRoot, "package-lock.json")), "single-app-package-manifest");
  }
}

function npmCli(): string {
  // Executable metadata only; no application .env or private profile is read.
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
  const selected = candidates.find(candidate => candidate !== undefined && isAbsolute(candidate)
    && /(?:^|[\\/])npm-cli\.js$/.test(candidate) && existsSync(candidate));
  requireCheck(selected && lstatSync(selected).isFile() && !lstatSync(selected).isSymbolicLink(), "npm-cli-unavailable");
  return selected;
}
function packedFiles(root: string, cli: string): number {
  const result = spawnSync(process.execPath, [cli, "pack", "--dry-run", "--json", "--ignore-scripts", "--offline",
    "--audit=false", "--fund=false", "--loglevel=error"], {
    cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  requireCheck(!result.error && result.status === 0, "offline-pack-dry-run");
  // Do not print child stdout/stderr. Only aggregate safe filename checks are reported.
  const output: unknown = JSON.parse(result.stdout);
  requireCheck(Array.isArray(output) && output.length === 1, "pack-json-shape");
  const record = object(output[0], "pack-record");
  requireCheck(Array.isArray(record.files) && record.files.length > 0, "pack-file-list");
  const names = new Set<string>();
  let compiled = 0;
  for (const entry of record.files) {
    const name = object(entry, "pack-file-record").path;
    requireCheck(typeof name === "string" && name.length > 0 && !name.includes("\\") && !name.includes("\0")
      && !isAbsolute(name) && !name.split("/").includes("..") && publicPath(name), "unsafe-package-filename");
    requireCheck(!names.has(name), "duplicate-package-filename");
    names.add(name);
    const dist = name.startsWith("dist/");
    const asset = name.startsWith("assets/quotation-pdf/") && pdfAssets.has(name.slice("assets/quotation-pdf/".length));
    requireCheck(dist ? /(?:\.js|\.d\.ts)$/.test(name) || name === "dist/crm/quotation-pdf/font-coverage.json"
      : asset || /^(?:package\.json|README(?:\.[a-z]+)?|LICENSE(?:\.[a-z]+)?|LICENCE(?:\.[a-z]+)?)$/i.test(name), "package-content-allowlist");
    ordinaryPath(root, resolve(root, name));
    requireCheck(lstatSync(resolve(root, name)).isFile(), "nonordinary-package-file");
    if (dist) compiled++;
  }
  requireCheck(compiled > 0 && names.has("package.json"), "missing-package-runtime");
  return names.size;
}

/** The combined app is private and is not an npm distribution. Inspect Express
 * assets directly; do not pack Next build traces, private profiles or archives. */
function serverAssets(): number {
  const root = join(backendRoot, "assets", "quotation-pdf");
  ordinaryPath(workspaceRoot, root);
  const found = files(root, "private-server-asset");
  requireCheck(found.length === pdfAssets.size && found.every(file => pdfAssets.has(relative(root, file))), "server-asset-allowlist");
  return found.length;
}

function ignores(): number {
  const privateNames = [".env", ".env.boundary-probe.local", "node_modules/boundary-probe/index.js", "dist/boundary-probe.js",
    ".private/boundary-probe", ".local-data/boundary-probe", "backups/boundary-probe.sql", "boundary-probe.sqlite",
    "boundary-probe.sqlite-wal", "boundary-probe.sqlite-shm", "boundary-probe.db", "boundary-probe.db-wal",
    "boundary-probe.sql", "boundary-probe.backup", "boundary-probe.bak"];
  const probes = ["", "server", "shared/contracts"].flatMap(root => privateNames.map(name => root ? `${root}/${name}` : name));
  probes.push(".private-legacy/source-20261014/boundary-probe.php");
  const result = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: workspaceRoot, input: `${probes.join("\0")}\0`, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true,
  });
  requireCheck(!result.error && result.status === 0, "git-ignore-command");
  const ignored = new Set(result.stdout.split("\0").filter(Boolean));
  requireCheck(probes.every(probe => ignored.has(probe)) && ignored.size === probes.length, "private-ignore-probes");
  const template = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", "server/.env.example"], {
    cwd: workspaceRoot, timeout: 10_000, windowsHide: true,
  });
  requireCheck(!template.error && template.status === 1, "backend-template-includable");
  return probes.length;
}

function contractCoverage() {
  const apiRoot = join(workspaceRoot, "src", "app", "api");
  const routeFiles = files(apiRoot, "unexpected-api-source").filter(file => file.endsWith(`${sep}route.ts`));
  const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  const source: string[] = [];
  for (const file of routeFiles) {
    const route = `/api/${relative(apiRoot, file).replaceAll("\\", "/").replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, ":$1")}`;
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      if (ts.isFunctionDeclaration(node) && node.name && methods.has(node.name.text)
        && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        source.push(`${node.name.text} ${route}`);
      }
      if (ts.isVariableStatement(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && methods.has(declaration.name.text)) source.push(`${declaration.name.text} ${route}`);
        }
      }
    }
  }
  const docPath = join(workspaceRoot, "docs", "express-api-contracts.md");
  ordinaryPath(workspaceRoot, docPath);
  const mapped: string[] = [], destinations: string[] = [];
  for (const line of readFileSync(docPath, "utf8").split("\n")) {
    const row = line.match(/^\| (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \| `([^`]+)`[^|]*\| `([^`]+)`/);
    if (!row) continue;
    const method = row[1]!, original = row[2]!, destination = row[3]!;
    requireCheck(destination === original.replace(/^\/api\//, "/api/v1/"), "api-version-mapping");
    mapped.push(`${method} ${original}`); destinations.push(`${method} ${destination}`);
  }
  requireCheck(routeFiles.length === 55 && source.length === 70 && JSON.stringify(source.sort()) === JSON.stringify(mapped.sort())
    && new Set(mapped).size === mapped.length && new Set(destinations).size === destinations.length, "api-contract-coverage");
  return { sourceRoutes: routeFiles.length, explicitMethods: source.length, plannedDestinations: destinations.length };
}

try {
  manifest(workspaceRoot, false);
  manifest(contractsRoot, true);
  const backendSource = scanTree(join(backendRoot, "src"), false, true);
  const backendBuild = scanTree(join(backendRoot, "dist"), false, false);
  const contractsSource = scanTree(join(contractsRoot, "src"), true, true);
  const contractsBuild = scanTree(join(contractsRoot, "dist"), true, false);
  const coverage = contractCoverage();
  const privateIgnoreProbes = ignores();
  const cli = npmCli();
  const serverAssetFiles = serverAssets();
  const contractsPackFiles = packedFiles(contractsRoot, cli);
  console.log(JSON.stringify({ status: "PASS", scope: "single-root-express-crm-boundaries", backendSource, backendBuild,
    contractsSource, contractsBuild, serverAssetFiles, contractsPackFiles, privateIgnoreProbes,
    ...coverage, databaseConnections: 0, applicationModulesImported: 0, externalRequests: 0,
    limitation: "Static import/package evidence only; no workflow, database, host or deployment verification." }));
} catch (error) {
  console.error(JSON.stringify({ status: "FAIL", check: error instanceof BoundaryFailure ? error.check : "sanitized-verifier-failure" }));
  process.exitCode = 1;
}
