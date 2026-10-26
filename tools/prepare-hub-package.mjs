import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { scanCredentialPatterns } from './audit-git-history.mjs';
import { classifyPublicationPath, inspectCandidateContent, normalizePublicationPath, reviewedFixtureFindings,
  reviewedPassiveAssetPaths, reviewedThemeTextPaths, validateReviewedFixtures, validateTemplate } from './audit-publication.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const status = 'HUB_SOURCE_CANDIDATE_NOT_PRODUCTION_ACCEPTED';
const maxFileBytes = 8 * 1024 * 1024, maxPackageBytes = 128 * 1024 * 1024;
const maxFiles = 4096;
const sourceRoots = ['src', 'server/src', 'server/tests', 'server/scripts', 'server/demo-sqlite', 'tests', 'scripts', 'shared/contracts/src', 'tools'];
const privateSegments = new Set(['.git', 'node_modules', '.next', 'dist', 'out', 'coverage', 'playwright-report', 'test-results',
  '.local-data', '.local-dev', '.private', '.private-legacy', 'uploads', 'sessions', 'backups', 'credentials', '.credentials', 'secrets', 'release']);
export const hubEnvironmentTemplates = Object.freeze(['.env.example', 'server/.env.example']);
const fixed = ['.editorconfig', '.gitignore', 'AGENTS.md', 'README.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'tsconfig.server.json', 'tsconfig.server.build.json', 'tsconfig.demo.json', 'eslint.config.mjs', 'next.config.ts',
  'start-local.ps1', 'stop-local.ps1', 'start-sqlite-demo.ps1', 'shared/contracts/package.json', 'shared/contracts/tsconfig.json',
  ...hubEnvironmentTemplates, 'deploy/ubuntu/nginx.conf.example', 'deploy/ubuntu/hub-crm.service',
  'docs/manual-deployment-guide.md', 'docs/final-release-checklist.md', 'docs/mysql-production-operator-guide.md',
  'docs/runtime-excluded-assets.md', 'docs/staging-acceptance.md', 'docs/backend-production-environment.md',
  'docs/legacy-production-compatibility.md'];
const optional = ['docs/production-preparation-report.md', 'docs/single-project-layout.md', 'docs/hub-rename.md',
  'PROJECT-STRUCTURE.md', 'docs/clean-project-verification.md', 'docs/project-audit.md'];
const taskSourceAdditions = ['tools/run-hub.mjs', 'tools/run-hub.test.mjs', 'tools/hub-foundation-smoke.mjs',
  'tools/prepare-hub-package.mjs', 'tools/prepare-hub-package.test.mjs', 'tests/express-identity.test.ts',
  'server/tests/legacy-compat-runtime-refusal.test.ts', 'tools/hub-environment.mjs', 'tools/hub-environment.test.mjs',
  'tools/singleproject-smoke.mjs', 'tools/development-smoke.mjs'];
export const hubRequiredFiles = Object.freeze([...fixed, ...reviewedPassiveAssetPaths, ...reviewedThemeTextPaths,
  'src/app/layout.tsx', 'src/app/page.tsx', 'server/src/cli.ts', 'shared/contracts/src/index.ts',
  'tools/run-local.mjs', 'tools/audit-publication.mjs', 'tools/audit-git-history.mjs',
  'tools/publication-reviewed-fixtures.json', 'tools/publication-source-files.json', ...taskSourceAdditions].sort());
const codeExtensions = new Set(['.ts', '.tsx', '.mts', '.mjs', '.css', '.json', '.ps1']);
const forbiddenFiles = /\.(?:php\d*|phtml|phar|sql|sqlite\d*|db|dump|log|pem|key|p12|pfx|bak|backup|old|zip|gz|tar|7z|tsbuildinfo|map)(?:$|[-.])/i;
const envName = /(?:^|\/)\.env(?:\.|$)|\.env(?:\.|$)/i;

export function safeHubPath(name) {
  try { normalizePublicationPath(name); } catch { return false; }
  if (name.split('/').some(part => privateSegments.has(part.toLowerCase()) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
  if (hubEnvironmentTemplates.includes(name)) return true;
  if (envName.test(name) || forbiddenFiles.test(name)) return false;
  if (fixed.includes(name) || optional.includes(name)) return true;
  const kind = classifyPublicationPath(name);
  if (kind === 'pinned-passive-asset' || reviewedThemeTextPaths.includes(name)) return true;
  return kind === 'source' && sourceRoots.some(base => name.startsWith(base + '/')) && codeExtensions.has(extname(name));
}

function ordinaryRoot(root) {
  const absolute = resolve(root), stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync(absolute), absolute)) throw Error('Package root must be an ordinary directory.');
  return absolute;
}
function ordinary(root, name, file = true) {
  normalizePublicationPath(name);
  const target = resolve(root, ...name.split('/')), remaining = relative(root, target);
  if (!remaining || isAbsolute(remaining) || remaining === '..' || remaining.startsWith('..' + sep)) throw Error('Package containment refused.');
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !samePath(realpathSync(cursor), cursor)
      || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw Error('Package links and nonordinary files are refused.');
  }
  if (file && !lstatSync(target).isFile()) throw Error('Package ordinary file required.');
  return target;
}
function readOrdinary(root, name, limit = maxFileBytes) {
  const path = ordinary(root, name), before = lstatSync(path);
  if (before.size > limit) throw Error('Package file size exceeded.');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw Error('Package source changed while opening.');
    const buffer = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(descriptor, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    const bytes = buffer.subarray(0, used), after = fstatSync(descriptor), current = lstatSync(ordinary(root, name));
    for (const stat of [after, current]) if (stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs
      || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1) throw Error('Package source changed while reading.');
    if (bytes.length !== before.size || bytes.length > limit) throw Error('Package read size changed.');
    return bytes;
  } finally { closeSync(descriptor); }
}

function candidates(root) {
  const inventory = JSON.parse(readOrdinary(root, 'tools/publication-source-files.json').toString('utf8'));
  if (!Array.isArray(inventory) || new Set(inventory).size !== inventory.length) throw Error('Frozen source filename inventory refused.');
  for (const name of inventory) normalizePublicationPath(name);
  const approved = new Set([...inventory.filter(safeHubPath), ...hubRequiredFiles, ...optional]);
  const names = new Set([...inventory.filter(safeHubPath), ...hubRequiredFiles]);
  for (const name of optional) if (existsSync(resolve(root, name))) names.add(name);
  for (const name of [...reviewedPassiveAssetPaths, ...reviewedThemeTextPaths]) names.add(name);
  function walk(base) {
    const directory = ordinary(root, base, false);
    if (!lstatSync(directory).isDirectory()) throw Error('Source directory required.');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${base}/${entry.name}`;
      if (entry.isSymbolicLink()) throw Error('Package source link refused.');
      // Excluded private contents are never opened or copied.
      if (privateSegments.has(entry.name.toLowerCase()) || envName.test(name) || forbiddenFiles.test(name)) continue;
      if (entry.isDirectory()) walk(name);
      else if (safeHubPath(name) && approved.has(name)) names.add(name);
      else throw Error('Unreviewed file in a required source subtree.');
      if (names.size > maxFiles) throw Error('Package file count exceeded.');
    }
  }
  for (const name of sourceRoots) walk(name);
  const result = [...names].sort();
  if (new Set(result.map(name => name.toLowerCase())).size !== result.length || hubRequiredFiles.some(name => !names.has(name))) throw Error('Required package source missing or case collision.');
  for (const name of result) if (!safeHubPath(name)) throw Error('Package source boundary refused.');
  return result;
}

export function inspectHubBytes(name, bytes, options = {}) {
  if (!safeHubPath(name)) return ['path-not-allowlisted'];
  const records = options.reviewedFixtures ?? [];
  const generic = scanCredentialPatterns(bytes);
  const remaining = reviewedFixtureFindings(name, bytes, generic, records);
  // Exact path+hash fixture exceptions only. No runtime source is exempted.
  const surrogate = ['.editorconfig', '.gitignore', 'AGENTS.md', 'README.md'].includes(name) ? '.editorconfig' : name;
  const findings = inspectCandidateContent(surrogate, bytes, { knownCredentials: options.knownCredentials,
    privateContent: options.privateContent, genericCredentials: () => remaining });
  // Binary pins do not bypass known generic token/key scanning.
  if (classifyPublicationPath(name) === 'pinned-passive-asset') findings.push(...remaining);
  if (hubEnvironmentTemplates.includes(name)) findings.push(...validateTemplate(name, bytes));
  return [...new Set(findings)];
}

function capture(root, options) {
  root = ordinaryRoot(root);
  const reviewedFixtures = validateReviewedFixtures(options.reviewedFixtures
    ?? JSON.parse(readOrdinary(root, 'tools/publication-reviewed-fixtures.json').toString('utf8')));
  const selected = [], rejected = [];
  let total = 0;
  for (const name of candidates(root)) {
    const bytes = readOrdinary(root, name), findings = inspectHubBytes(name, bytes, { ...options, reviewedFixtures });
    if (findings.length) rejected.push({ path: name, reasons: findings });
    else selected.push({ path: name, bytes, sha256: sha256(bytes) });
    total += bytes.length;
    if (total > maxPackageBytes) throw Error('Package content size exceeded.');
  }
  return { root, selected, rejected, options: { ...options, reviewedFixtures } };
}
export function checkHubSource(root, options = {}) {
  const result = capture(root, options);
  return { status: result.rejected.length ? 'SOURCE_CHECK_REFUSED' : 'SOURCE_CHECK_PASSED_WITH_LIMITATIONS',
    files: result.selected.length, rejected: result.rejected,
    historicalCredentialScan: typeof options.knownCredentials === 'function', historicalPrivateCopyScan: typeof options.privateContent === 'function',
    productionAccepted: false };
}
function manifestFor(selected, options) {
  return { version: 1, status, files: selected.map(item => ({ path: item.path, bytes: item.bytes.length, sha256: item.sha256 })),
    scannerScope: { genericCredentials: true, exactReviewedSyntheticFixtures: true, pinnedPassiveAssets: true, frozenSourcePaths: true,
      historicalCredentialScan: typeof options.knownCredentials === 'function', historicalPrivateCopyScan: typeof options.privateContent === 'function' },
    exclusions: ['Every actual environment/credential/profile file; only the exact root example and historical API example included',
      'Dependencies, builds, Git history, databases, uploads, sessions, backups, archived PHP and private artifacts',
      'Private quotation images/signatures/stamps and private public/legacy/manifest.json; the requested public favicon is included only at its reviewed path and exact hash'],
    limitations: ['Source candidate only; no production readiness or legacy adapter compatibility is established.',
      'Build and install dependencies on the target OS; no Windows native modules or build output is included.',
      'Pattern scanning and exact reviewed fixture hashes cannot prove absence of unknown or transformed secrets/private data.',
      'Historical credential/private-copy checks are performed only when explicitly supplied; see scannerScope.',
      'Private PDF assets, issuer approval, legacy database evidence, real HTTPS/host and recovery acceptance remain outstanding.'] };
}
function manifestBytes(selected, options) { return Buffer.from(JSON.stringify(manifestFor(selected, options), null, 2) + '\n'); }
function archiveBytes(selected, manifest) {
  const entries = Object.create(null), options = { mtime: new Date(1980, 0, 1), os: 3, attrs: 0o100644 << 16 };
  for (const item of [...selected.map(value => ({ path: value.path, bytes: value.bytes })), { path: 'FILE-MANIFEST.json', bytes: manifest }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    entries[`hub-crm-source/${item.path}`] = [item.bytes, options];
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}
function assertExactTree(root, names) {
  const files = new Set(names), directories = new Set();
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { directories.add(parts.join('/')); parts.pop(); }
  }
  const seen = new Set();
  function walk(base) {
    for (const entry of readdirSync(base ? ordinary(root, base, false) : root, { withFileTypes: true })) {
      const name = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        ordinary(root, name, false);
        if (!directories.has(name)) throw Error('Extra package directory.');
        walk(name);
      } else {
        ordinary(root, name);
        if (!files.has(name)) throw Error('Extra package file or link.');
        seen.add(name);
      }
    }
  }
  walk('');
  if (seen.size !== files.size) throw Error('Missing package file.');
}
export function prepareHubPackage(root, options = {}) {
  const captured = capture(root, options);
  if (captured.rejected.length) throw Error('Package content checks refused; run --check for safe findings.');
  const manifest = manifestBytes(captured.selected, captured.options), archive = archiveBytes(captured.selected, manifest);
  const release = join(captured.root, 'release');
  if (!existsSync(release)) mkdirSync(release);
  ordinary(captured.root, 'release', false);
  if (!lstatSync(release).isDirectory()) throw Error('Release output must be an ordinary directory.');
  const name = `release/hub-source-${randomUUID()}`, output = join(captured.root, name);
  mkdirSync(output); // Exclusive new destination; never overwrite or clean up.
  for (const item of [...captured.selected, { path: 'FILE-MANIFEST.json', bytes: manifest }]) {
    const target = join(output, 'hub-crm-source', item.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, item.bytes, { flag: 'wx', mode: 0o644 });
  }
  writeFileSync(join(output, 'hub-crm-source.zip'), archive, { flag: 'wx', mode: 0o644 });
  writeFileSync(join(output, 'hub-crm-source.zip.sha256'), `${sha256(archive)}  hub-crm-source.zip\n`, { flag: 'wx', mode: 0o644 });
  verifyHubPackage(captured.root, name, captured.options);
  return { output: name, files: captured.selected.length, archiveSha256: sha256(archive), status, productionAccepted: false };
}
export function verifyHubPackage(root, directory, options = {}) {
  root = ordinaryRoot(root);
  if (!/^release\/hub-source-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(directory)) throw Error('Package verification target refused.');
  const output = ordinary(root, directory, false), captured = capture(root, options);
  if (captured.rejected.length) throw Error('Package current source content check refused.');
  const expectedManifest = manifestBytes(captured.selected, captured.options), manifest = readOrdinary(output, 'hub-crm-source/FILE-MANIFEST.json');
  if (!manifest.equals(expectedManifest)) throw Error('Package manifest differs from current reviewed source.');
  const archive = readOrdinary(output, 'hub-crm-source.zip', maxPackageBytes);
  if (!readOrdinary(output, 'hub-crm-source.zip.sha256').equals(Buffer.from(`${sha256(archive)}  hub-crm-source.zip\n`))) throw Error('Package archive checksum mismatch.');
  // Exact deterministic archive equality also refuses duplicate/path aliases,
  // extra compressed entries, altered permissions and unbounded zip payloads.
  if (!archive.equals(archiveBytes(captured.selected, manifest))) throw Error('Package archive contents differ.');
  const archiveFiles = unzipSync(archive);
  const expectedNames = ['hub-crm-source/FILE-MANIFEST.json', ...captured.selected.map(item => `hub-crm-source/${item.path}`)].sort();
  if (JSON.stringify(Object.keys(archiveFiles).sort()) !== JSON.stringify(expectedNames)) throw Error('Package archive entry mismatch.');
  for (const item of [...captured.selected, { path: 'FILE-MANIFEST.json', bytes: manifest }]) {
    const name = `hub-crm-source/${item.path}`;
    if (!readOrdinary(output, name).equals(item.bytes) || !Buffer.from(archiveFiles[name]).equals(item.bytes)) throw Error('Package copied bytes changed.');
  }
  assertExactTree(output, [...expectedNames, 'hub-crm-source.zip', 'hub-crm-source.zip.sha256']);
  return { status: 'VERIFIED_HUB_SOURCE_PACKAGE', files: captured.selected.length, archiveSha256: sha256(archive), productionAccepted: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check') {
      const result = checkHubSource(root); console.log(JSON.stringify(result, null, 2));
      if (result.rejected.length) process.exitCode = 1;
    } else if (args.length === 1 && args[0] === '--create') console.log(JSON.stringify(prepareHubPackage(root)));
    else if (args.length === 2 && args[0] === '--verify') console.log(JSON.stringify(verifyHubPackage(root, args[1])));
    else throw Error('Use explicit --check, --create or --verify.');
  } catch { console.error(JSON.stringify({ status: 'HUB_PACKAGE_REFUSED', detail: 'No sensitive contents disclosed. Preserve any incomplete new output for investigation.' })); process.exitCode = 1; }
}
