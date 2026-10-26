import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Read-only and offline. Never return subprocess stderr, object contents, matched
// values, blob identifiers, digests of credentials, or raw commit messages.
function git(repo, args, input) {
  try {
    return execFileSync("git", args, {
      cwd: repo, input, maxBuffer: 768 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
  } catch { throw new Error("Read-only local Git inspection failed; no subprocess details emitted."); }
}

const text = buffer => buffer.toString("utf8");
const lines = buffer => text(buffer).trim().split(/\r?\n/).filter(Boolean);

export function privatePathCategory(path) {
  const normalized = path.replaceAll("\\", "/");
  if (/(^|\/)assets\/photos\//i.test(normalized)) return "original-uploads";
  if (/(^|\/)\.env\..+\.example$/i.test(normalized)) return "noncanonical-environment-template";
  if (/(^|\/)\.env(?:$|\.)/i.test(normalized) && !/(^|\/)\.env\.example$/i.test(normalized)) return "actual-environment";
  if (/(^|\/)(?:\.private-legacy|legacy-backups?)(?:\/|$)/i.test(normalized)) return "legacy-private-archive";
  if (/(^|\/)(?:\.local-data|\.local-dev|\.private|uploads|backups)(?:\/|$)/i.test(normalized)) return "private-artifacts";
  if (/\.(?:sqlite(?:3)?|db)(?:$|[-.])|(?:-wal|-shm|-journal)$/i.test(normalized)) return "database";
  if (/\.(?:zip|tar(?:\.gz)?|tgz|bak|backup|7z)$/i.test(normalized)) return "archive-or-backup";
  if (/\.(?:pem|key|p12|pfx)$/i.test(normalized)) return "credential-key-file";
  if (/\.sql$/i.test(normalized)) return "sql-requires-source-review";
  return null;
}

function safePath(path) {
  const category = privatePathCategory(path);
  if (category) return `[${category}; individual private path withheld]`;
  if (!/^[A-Za-z0-9_./ ()\[\]@+<>!'-]+$/.test(path) || path.includes("..")) return "[nonstandard source path withheld]";
  return path;
}

function placeholder(value) {
  return !value.trim() || /^(?:<[^>]*>|\$\{[^}]*\}|\.{3}|(?:YOUR|REPLACE|INSERT|EXAMPLE|PLACEHOLDER)[_-].*|change[-_]?me|secret|password|token|dummy|test|null|undefined)$/i.test(value);
}

export function scanCredentialPatterns(content) {
  const source = Buffer.isBuffer(content) ? text(content) : String(content);
  const categories = new Set();
  const assignments = /(?:\b|\$|["'])(client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|password|passwd|db[_-]?password|session[_-]?secret)["']?\s*(?:=>|=|:)\s*(["'`])([^\r\n"'`]{1,1024})\2/gi;
  for (const match of source.matchAll(assignments)) {
    const value = match[3];
    if (placeholder(value) || /\$\{|\$[A-Za-z_]|process\.env\./.test(value)) continue;
    const password = /password|passwd/i.test(match[1]);
    if (value.length < (password ? 8 : 16)) continue;
    categories.add(password ? "literal-password-candidate" : "literal-credential-candidate");
  }
  const environmentAssignments = /(?:^|\n)[\t ]*([A-Z_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY)[A-Z_]*)[\t ]*=[\t ]*([^\s#"'`][^\r\n#]*)/g;
  for (const match of source.matchAll(environmentAssignments)) {
    const value = match[2].trim();
    if (value.length >= 8 && !placeholder(value) && !/\$\{|\$[A-Za-z_]/.test(value)) categories.add("environment-credential-candidate");
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(source)) categories.add("private-key-material");
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/.test(source)) categories.add("provider-token-candidate");
  if (/\b(?:https?|mysql|postgres(?:ql)?):\/\/[^\s/:"'<>]+:[^\s/@"'<>]{4,}@/i.test(source)) categories.add("credential-bearing-url-candidate");
  if (/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i.test(source)) categories.add("bearer-token-candidate");
  return [...categories].sort();
}

export function parseBatchObjects(buffer) {
  const objects = new Map();
  for (let offset = 0; offset < buffer.length;) {
    const newline = buffer.indexOf(10, offset);
    if (newline < 0) throw new Error("Invalid local Git object framing.");
    const header = text(buffer.subarray(offset, newline));
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (blob|tree|commit|tag) ([0-9]+)$/.exec(header);
    if (!match) throw new Error("Unavailable or invalid local Git object.");
    const size = Number(match[3]), start = newline + 1, end = start + size;
    if (!Number.isSafeInteger(size) || end >= buffer.length || buffer[end] !== 10) throw new Error("Truncated local Git object.");
    objects.set(match[1], { type: match[2], content: buffer.subarray(start, end) });
    offset = end + 1;
  }
  return objects;
}

function treeEntries(buffer, hashBytes) {
  const result = [];
  for (let offset = 0; offset < buffer.length;) {
    const space = buffer.indexOf(32, offset), zero = buffer.indexOf(0, space + 1);
    if (space < 0 || zero < 0 || zero + 1 + hashBytes > buffer.length) throw new Error("Invalid local Git tree.");
    result.push({ mode: text(buffer.subarray(offset, space)), name: text(buffer.subarray(space + 1, zero)), id: buffer.subarray(zero + 1, zero + 1 + hashBytes).toString("hex") });
    offset = zero + 1 + hashBytes;
  }
  return result;
}

const inventories = new Map();
function inventory(repo) {
  const root = resolve(repo);
  if (inventories.has(root)) return inventories.get(root);
  const format = text(git(root, ["rev-parse", "--show-object-format"])).trim();
  if (!["sha1", "sha256"].includes(format)) throw new Error("Unsupported local Git object format.");
  const objects = parseBatchObjects(git(root, ["cat-file", "--batch-all-objects", "--batch", "--unordered"]));
  const commits = new Map(), trees = new Map(), nested = new Set();
  for (const [id, object] of objects) {
    if (object.type === "tree") {
      const entries = treeEntries(object.content, format === "sha1" ? 20 : 32);
      trees.set(id, entries);
      for (const entry of entries) if (entry.mode === "40000") nested.add(entry.id);
    } else if (object.type === "commit") {
      const source = text(object.content), tree = /^tree ([a-f0-9]+)$/m.exec(source)?.[1];
      if (!tree) throw new Error("Invalid local commit tree.");
      commits.set(id, { tree, message: source.slice(source.indexOf("\n\n") + 2) });
    }
  }
  const refs = lines(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"])).map(line => {
    const split = line.lastIndexOf(" "); return { name: line.slice(0, split), id: line.slice(split + 1) };
  });
  const roots = new Set([...trees.keys()].filter(id => !nested.has(id)));
  for (const commit of commits.values()) roots.add(commit.tree);
  for (const ref of refs) if (trees.has(ref.id)) roots.add(ref.id);
  const blobPaths = new Map(), rootEntries = new Map(), missing = new Set(), gitlinks = new Set();
  function walk(tree, prefix, files, ancestry = new Set()) {
    if (ancestry.has(tree)) throw new Error("Cyclic local Git tree.");
    const entries = trees.get(tree);
    if (!entries) { missing.add(tree); return; }
    const next = new Set(ancestry).add(tree);
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === "40000") walk(entry.id, path, files, next);
      else if (entry.mode === "160000") gitlinks.add(entry.id);
      else {
        if (!objects.has(entry.id)) missing.add(entry.id);
        if (!blobPaths.has(entry.id)) blobPaths.set(entry.id, new Set());
        blobPaths.get(entry.id).add(path); files.push({ path, id: entry.id });
      }
    }
  }
  for (const tree of roots) { const files = []; walk(tree, "", files); rootEntries.set(tree, files); }
  const result = { root, format, objects, commits, refs, roots, blobPaths, rootEntries, missing, gitlinks };
  inventories.set(root, result); return result;
}

export function credentialDetectorFromHistoricalSource(source) {
  const secrets = [...source.matchAll(/(?:\$|["'])client_secret["']?\s*(?:=>|=|:)\s*(["'])([^"'\r\n]+)\1/gi)]
    .map(match => match[2]).filter(value => value.length >= 16 && !placeholder(value));
  if (!secrets.length) throw new Error("Known historical credential source unavailable; comparison cannot be certified.");
  return content => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    return secrets.some(value => buffer.includes(Buffer.from(value))) ? ["known-zoho-client-secret"] : [];
  };
}

export function createKnownCredentialDetector(repo) {
  return credentialDetectorFromHistoricalSource(text(git(repo, ["show", "HEAD:application/controllers/Zoho.php"])));
}

export function detectHistoricalPrivateCopy(content, format, forbidden) {
  if (!["sha1", "sha256"].includes(format)) throw new Error("Unsupported local Git object format.");
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const id = createHash(format).update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
  return (forbidden.get(id) ?? []).map(category => `historical-private-content:${category}`);
}

export function createPublicationContentDetector(repo) {
  const known = createKnownCredentialDetector(repo), data = inventory(repo), forbidden = new Map();
  for (const [id, paths] of data.blobPaths) {
    const categories = [...new Set([...paths].map(privatePathCategory).filter(category => category && category !== "sql-requires-source-review"))];
    if (categories.length) forbidden.set(id, categories);
  }
  if (data.missing.size || data.gitlinks.size) throw new Error("Historical object coverage incomplete; content comparison cannot be certified.");
  return content => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    return [...known(buffer), ...detectHistoricalPrivateCopy(buffer, data.format, forbidden)];
  };
}

function countPrivate(files) {
  const categories = {};
  for (const { path } of files) {
    const category = privatePathCategory(path);
    if (category) categories[category] = (categories[category] ?? 0) + 1;
  }
  return categories;
}

function snapshot(repo) {
  const index = text(git(repo, ["rev-parse", "--git-path", "index"])).trim();
  return { index: readFileSync(resolve(repo, index)), refs: git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), head: git(repo, ["rev-parse", "HEAD"]) };
}

function repositoryMetadata(repo, refs, known) {
  const entries = text(git(repo, ["config", "--local", "--null", "--list"])).split("\0").filter(Boolean).map(entry => {
    const split = entry.indexOf("\n"); return { key: split < 0 ? entry : entry.slice(0, split), value: split < 0 ? "" : entry.slice(split + 1) };
  });
  const urls = entries.filter(entry => /^remote\..*\.(?:url|pushurl)$/i.test(entry.key));
  const credentialUrl = value => {
    if (known(value).length || scanCredentialPatterns(value).length) return true;
    try {
      const parsed = new URL(value);
      return Boolean(parsed.password || (/^https?:$/.test(parsed.protocol) && parsed.username)
        || [...parsed.searchParams.keys()].some(key => /token|secret|password|api[_-]?key/i.test(key)));
    } catch { return false; }
  };
  const gitPath = name => resolve(repo, text(git(repo, ["rev-parse", "--git-path", name])).trim());
  const alternatePath = gitPath("objects/info/alternates");
  return {
    shallowRepository: text(git(repo, ["rev-parse", "--is-shallow-repository"])).trim() === "true",
    partialCloneConfigurationPresent: entries.some(entry => entry.key === "extensions.partialclone" || /\.promisor$/.test(entry.key) && entry.value !== "false"),
    localAlternateObjectStoreConfigured: existsSync(alternatePath) && readFileSync(alternatePath).length > 0,
    alternateObjectStoreEnvironmentPresent: Boolean(process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES),
    replaceRefCount: refs.filter(ref => ref.name.startsWith("refs/replace/")).length,
    graftFilePresent: existsSync(gitPath("info/grafts")),
    configuredRemoteUrlCount: urls.length,
    credentialBearingRemoteUrlCount: urls.filter(entry => credentialUrl(entry.value)).length,
    localConfigKnownCredentialMatchCount: entries.filter(entry => known(entry.value).length).length,
  };
}

export function auditGitHistory(repo) {
  const before = snapshot(repo), data = inventory(repo), known = createKnownCredentialDetector(repo);
  const indexFiles = text(git(repo, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean).map(entry => {
    const tab = entry.indexOf("\t"), [mode, id, stage] = entry.slice(0, tab).split(" ");
    return { path: entry.slice(tab + 1), id, mode, stage };
  });
  const findings = [], typeCounts = {}, detected = new Map();
  for (const [id, object] of data.objects) {
    typeCounts[object.type] = (typeCounts[object.type] ?? 0) + 1;
    if (!["blob", "commit", "tag"].includes(object.type)) continue;
    const categories = [...known(object.content), ...scanCredentialPatterns(object.content)];
    if (!categories.length) continue;
    detected.set(id, [...new Set(categories)]);
  }
  const commitFiles = [...data.commits].map(([id, commit]) => ({ id, files: data.rootEntries.get(commit.tree) ?? [] }));
  for (const [id, categories] of detected) {
    const object = data.objects.get(id), paths = [...(data.blobPaths.get(id) ?? [])];
    const commits = object.type === "commit" ? [id] : commitFiles.filter(commit => commit.files.some(file => file.id === id)).map(commit => commit.id);
    findings.push({ categories, objectType: object.type, sourcePaths: [...new Set(paths.map(path => known(path).length ? "[credential-bearing path withheld]" : safePath(path)))].sort(), commits, indexed: indexFiles.some(file => file.id === id) });
  }
  const uniquePaths = [...new Set([...data.blobPaths.values()].flatMap(paths => [...paths]))].map(path => ({ path }));
  const refCategories = {};
  for (const ref of data.refs) { const category = ref.name.startsWith("refs/codex/") ? "codex-local-snapshot" : ref.name.startsWith("refs/remotes/") ? "remote-tracking-local-copy" : ref.name.startsWith("refs/heads/") ? "local-branch" : "other"; refCategories[category] = (refCategories[category] ?? 0) + 1; }
  const reachable = new Set(lines(git(repo, ["rev-list", "--objects", "--all", "--reflog", "--no-object-names"])));
  const metadata = repositoryMetadata(repo, data.refs, known);
  const environmentTemplatePaths = [...new Set(uniquePaths.map(file => file.path).filter(path => /(?:^|\/)\.env(?:\.[^/]*)?\.example$|(?:^|\/)\.env\.example$/.test(path)))].map(path => known(path).length ? "[credential-bearing path withheld]" : path).sort();
  const after = snapshot(repo);
  if (!before.index.equals(after.index) || !before.refs.equals(after.refs) || !before.head.equals(after.head)) throw new Error("Git index, refs, or HEAD changed during read-only audit.");
  return {
    status: "NO-GO", scope: "All physically available local Git objects, all refs and reflogs, plus current index; no network or lazy fetch.",
    objectCounts: typeCounts, refCounts: refCategories, rootTreeSnapshots: data.roots.size, repositoryMetadata: metadata,
    objectsOutsideRefsAndReflogs: [...data.objects.keys()].filter(id => !reachable.has(id)).length,
    blobsWithoutTreePath: [...data.objects].filter(([id, object]) => object.type === "blob" && !data.blobPaths.has(id)).length,
    missingReferencedObjects: data.missing.size, gitlinkTargetsNotInspected: data.gitlinks.size,
    indexedPaths: indexFiles.length, indexPrivatePathCategories: countPrivate(indexFiles),
    allHistoricalPrivatePathCategories: countPrivate(uniquePaths),
    historicalEnvironmentTemplatePaths: environmentTemplatePaths,
    commits: commitFiles.map(commit => ({ id: commit.id, privatePathCategories: countPrivate(commit.files) })),
    findings, refNameCredentialCandidateCount: data.refs.filter(ref => known(ref.name).length || scanCredentialPatterns(ref.name).length).length,
    indexRefsAndHeadUnchanged: true,
    limitations: ["Heuristic candidate findings require contextual review; absence is not proof that no unknown secret exists.", "No remote, other clone, server-side cache, deleted remote ref, Git LFS payload, external object store, or hosting log inspected.", "Private filenames and all credential values/digests are deliberately withheld."],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = auditGitHistory(resolve(fileURLToPath(new URL("..", import.meta.url))));
    const candidateCounts = {};
    for (const finding of report.findings) for (const category of finding.categories) candidateCounts[category] = (candidateCounts[category] ?? 0) + 1;
    // Keep the normal command concise; callers can inspect all metadata in memory.
    const { findings, ...summary } = report;
    process.stdout.write(`${JSON.stringify({ ...summary, candidateCounts, committedOrKnownFindings: findings.filter(finding => finding.commits.length || finding.categories.includes("known-zoho-client-secret")) }, null, 2)}\n`);
  }
  catch { process.stderr.write("Git history audit failed safely; no sensitive details emitted.\n"); process.exitCode = 1; }
}
