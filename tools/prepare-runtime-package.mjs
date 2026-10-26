import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnownCredentialDetector, scanCredentialPatterns } from './audit-git-history.mjs';
import { validateTemplate } from './audit-publication.mjs';

const sourceRoots = ['server/src', 'src', 'shared/contracts/src'];
const fixed = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.server.build.json',
  'server/.env.example', 'tools/run-local.mjs', 'tools/run-hub.mjs', 'tools/hub-environment.mjs',
  'deploy/ubuntu/nginx.conf.example', 'deploy/ubuntu/hub-crm.service',
  'next.config.ts', '.env.example', 'shared/contracts/package.json',
  'shared/contracts/tsconfig.json', 'docs/manual-deployment-guide.md', 'docs/final-release-checklist.md',
  'docs/mysql-production-operator-guide.md', 'docs/runtime-excluded-assets.md', 'docs/staging-acceptance.md',
  'docs/backend-production-environment.md'];
const forbidden = /(?:^|\/)(?:\.git|\.local-data|\.private|\.private-legacy|node_modules|\.next|dist|tests|backups|uploads|assets|public)(?:\/|$)|\.(?:php\d*|phtml|sql|sqlite\d*|db|log|pem|key|zip|gz|bak)$/i;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function safeRuntimePath(name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || /[\\:\x00-\x1f\x7f]/.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) || forbidden.test(name)) return false;
  if (/(?:^|\/)\.env(?:\.|$)|\.env(?:\.|$)/i.test(name) && !['server/.env.example', '.env.example'].includes(name)) return false;
  return fixed.includes(name) || (sourceRoots.some(root => name.startsWith(root + '/')) && /\.(?:ts|tsx|css|json|service|conf|md|sh|example)$/.test(name));
}

function ordinary(root, name, file = true) {
  if (!safeRuntimePath(name)) throw Error('Runtime path refused.');
  const full = resolve(root, name), remainder = relative(root, full);
  if (isAbsolute(remainder) || remainder.startsWith('..' + sep)) throw Error('Runtime containment refused.');
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = join(cursor, part); const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1) || realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()) throw Error('Runtime link refused.');
  }
  if (file && !lstatSync(full).isFile()) throw Error('Runtime ordinary file required.');
  return full;
}

export function inspectRuntimeBytes(name, bytes, known = () => []) {
  if (!safeRuntimePath(name) || bytes.length > 8 * 1024 * 1024 || bytes.includes(0)) throw Error('Runtime source boundary refused.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/^(?:SQLite format 3|%PDF-|PK\x03\x04)/.test(text) || /^\s*(?:BEGIN TRANSACTION;|CREATE TABLE\s|INSERT INTO\s|-- MySQL dump)/i.test(text)
    || known(bytes).length || scanCredentialPatterns(bytes).length) throw Error('Runtime content check refused.');
  if ((name === '.env.example' || name.endsWith('/.env.example')) && validateTemplate(name, bytes).length) throw Error('Runtime environment template refused.');
  if (name.endsWith('.json')) {
    const value = JSON.parse(text);
    if (value && !Array.isArray(value) && typeof value === 'object'
      && Object.keys(value).some(key => /^(?:password|client_secret|refresh_token|access_token|serverUuid|approvals)$/i.test(key))) throw Error('Private JSON record refused.');
  }
}

function candidates(root) {
  const names = [...fixed];
  function walk(base) {
    for (const entry of readdirSync(resolve(root, base), { withFileTypes: true })) {
      const name = `${base}/${entry.name}`;
      if (entry.isSymbolicLink()) throw Error('Runtime source link refused.');
      if (entry.isDirectory()) walk(name);
      else { if (!safeRuntimePath(name)) throw Error('Unreviewed runtime source type.'); names.push(name); }
    }
  }
  for (const rootName of sourceRoots) walk(rootName);
  const sorted = names.sort();
  if (new Set(sorted.map(name => name.toLowerCase())).size !== sorted.length) throw Error('Runtime path collision.');
  return sorted;
}

function runtimeBytes(name, bytes) {
  if (name !== 'package.json') return bytes;
  const manifest = JSON.parse(bytes.toString('utf8'));
  // Keep the original dependencies/lockfile graph, but omit unavailable development commands.
  const keep = ['contracts:build', 'build', 'build:server', 'build:web', 'start', 'start:api:configured', 'mysql:operator'];
  manifest.scripts = Object.fromEntries(keep.filter(key => manifest.scripts[key]).map(key => [key, manifest.scripts[key]]));
  return Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
}

export function prepareRuntimePackage(root, known) {
  root = resolve(root);
  if (lstatSync(root).isSymbolicLink()) throw Error('Workspace link refused.');
  const selected = candidates(root).map(name => {
    const filename = ordinary(root, name), source = readFileSync(filename);
    inspectRuntimeBytes(name, source, known);
    const bytes = runtimeBytes(name, source); inspectRuntimeBytes(name, bytes, known);
    return { name, bytes, sourceSha256: sha(source) };
  });
  // No caller-selected overwrite target and no cleanup operation.
  const outputRoot = join(root, 'release');
  if (!existsSync(outputRoot)) mkdirSync(outputRoot);
  if (!lstatSync(outputRoot).isDirectory() || lstatSync(outputRoot).isSymbolicLink()
    || realpathSync(outputRoot).toLowerCase() !== outputRoot.toLowerCase()) throw Error('Release output root refused.');
  const output = join(outputRoot, `runtime-${randomUUID()}`); mkdirSync(output);
  const entries = [];
  for (const { name, bytes, sourceSha256 } of selected) {
    const target = join(output, name); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 });
    if (sha(readFileSync(target)) !== sha(bytes)) throw Error('Runtime copied-byte mismatch.');
    entries.push({ path: name, bytes: bytes.length, sha256: sha(bytes), sourceSha256, transformed: sha(bytes) !== sourceSha256 });
  }
  const manifest = { version: 1, status: 'SOURCE_RUNTIME_CANDIDATE_NOT_PRODUCTION_ACCEPTED', files: entries,
    exclusions: ['All real environment/profile/credential files', 'All databases, uploads, originals, private artifacts, backups and Git history',
      'All PHP, node_modules, generated builds, tests, caches and local demo tooling',
      'All public and backend assets: separate owner licensing/private-asset approval and provisioning required'],
    limitations: ['Ubuntu dependencies and builds must run on Ubuntu, not copied Windows binaries.',
      'Theme/icon/font/branding/PDF assets are deliberately absent: provision exact approved assets before visual/PDF acceptance.',
      'MySQL, HTTPS host, issuer, recovery and credential remediation remain independent gates; this is not GitHub approval.'] };
  writeFileSync(join(output, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { output: relative(root, output).replaceAll('\\', '/'), files: entries.length, status: manifest.status };
}

export function verifyRuntimePackage(root, directory, known) {
  root = resolve(root);
  if (!/^release\/runtime-[a-f0-9-]{36}$/.test(directory)) throw Error('Runtime verification target refused.');
  const base = resolve(root, directory), manifestPath = join(base, 'runtime-manifest.json');
  for (const path of [join(root, 'release'), base, manifestPath]) {
    const stat = lstatSync(path); if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw Error('Runtime output link refused.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.status !== 'SOURCE_RUNTIME_CANDIDATE_NOT_PRODUCTION_ACCEPTED' || !Array.isArray(manifest.files)
    || JSON.stringify(manifest.files.map(item => item.path)) !== JSON.stringify(candidates(root))) throw Error('Runtime manifest refused.');
  const listed = new Set();
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !/^[a-f0-9]{64}$/.test(item.sourceSha256)
      || typeof item.transformed !== 'boolean' || item.transformed !== (item.sha256 !== item.sourceSha256)) throw Error('Runtime entry refused.');
    if (listed.has(item.path.toLowerCase())) throw Error('Runtime duplicate path.');
    const bytes = readFileSync(ordinary(base, item.path)); inspectRuntimeBytes(item.path, bytes, known);
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw Error('Runtime manifest mismatch.');
    const source = readFileSync(ordinary(root, item.path)); inspectRuntimeBytes(item.path, source, known);
    if (sha(source) !== item.sourceSha256 || sha(runtimeBytes(item.path, source)) !== item.sha256) throw Error('Runtime source changed after capture.');
    listed.add(item.path.toLowerCase());
  }
  function checkExtra(directoryName) {
    for (const entry of readdirSync(join(base, directoryName), { withFileTypes: true })) {
      const name = directoryName ? directoryName + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw Error('Runtime extra link.');
      if (entry.isDirectory()) {
        if (![...listed].some(path => path.startsWith(name.toLowerCase() + '/'))) throw Error('Runtime extra directory.');
        checkExtra(name);
      }
      else if (name !== 'runtime-manifest.json' && !listed.has(name.toLowerCase())) throw Error('Runtime extra file.');
    }
  }
  checkExtra('');
  return { status: 'VERIFIED_RUNTIME_SOURCE_CONTENTS', files: listed.size, secretValuesDisclosed: false, productionAccepted: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const known = createKnownCredentialDetector(root), args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--create') console.log(JSON.stringify(prepareRuntimePackage(root, known)));
    else if (args.length === 2 && args[0] === '--verify') console.log(JSON.stringify(verifyRuntimePackage(root, args[1], known)));
    else throw Error('Explicit create or verify required.');
  } catch { console.error(JSON.stringify({ status: 'RUNTIME_PACKAGE_REFUSED', detail: 'No sensitive contents disclosed; preserve any incomplete output for review.' })); process.exitCode = 1; }
}
