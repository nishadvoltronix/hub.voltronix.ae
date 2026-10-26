/** Read-only ownership evidence. No login, import, file reassignment or remote transport. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SqliteDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { preservedPath } from "../../tools/preservation-paths.mjs";
import { compatibilitySnapshot } from "./attachment-compatibility-preservation.js";
import { reconcileAttachmentOwnership } from "./attachment-reconciliation.js";
import { databaseConfig, privateDirectory, workspaceRoot, writePrivateNew } from "./storage.js";

const Database = createRequire(new URL("../../package.json", import.meta.url))("better-sqlite3") as new (
  filename: string, options: { readonly: boolean; fileMustExist: boolean },
) => SqliteDatabase;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const runtimeDataRoot = process.env.LOCALAPPDATA
  ? resolve(process.env.LOCALAPPDATA, "voltronix-crm-runtime", "data")
  : null;
const normalized = (path: string) => runtimeDataRoot && resolve(path).startsWith(runtimeDataRoot + sep)
  ? `[documented-local-runtime]/${relative(runtimeDataRoot, path).replaceAll("\\", "/")}`
  : relative(workspaceRoot, path).replaceAll("\\", "/");
const backupName = "crm-demo-60f5dfd2-1587-4221-9344-b10e38cbf041.sqlite";
const candidateTables = ["tasks", "task_attachment", "job_attachments", "electric", "civil", "pm", "switchgear", "maintenance",
  "crm_department_work_logs", "crm_department_log_attachments", "crm_attachment_audit_events", "crm_department_log_attachment_audit_events"];

function ordinary(path: string): void {
  const resolved = resolve(path);
  const roots = [resolve(workspaceRoot), ...(runtimeDataRoot && existsSync(runtimeDataRoot) ? [runtimeDataRoot] : [])];
  const root = roots.find(candidate => resolved === candidate || resolved.startsWith(candidate + sep));
  assert.ok(root, "Only repository inputs and the documented local runtime data directory may be inspected");
  let current = root;
  for (const part of relative(root, resolved).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, "Link inspection refused");
    assert.equal(realpathSync(current).toLowerCase(), current.toLowerCase(), "Reparse path inspection refused");
    if (stat.isFile()) assert.equal(stat.nlink, 1, "Hard-linked file inspection refused");
  }
}

function bytes(path: string): Buffer { ordinary(path); assert.ok(lstatSync(path).isFile()); return readFileSync(path); }
function physical(path: string) {
  // WAL participates in the database fingerprint. SHM contains reader coordination, not authoritative rows.
  return Object.fromEntries(["", "-wal"].filter(suffix => existsSync(path + suffix))
    .map(suffix => [suffix || "main", sha256(bytes(path + suffix))]));
}
function logical(db: SqliteDatabase) {
  return db.transaction(() => {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all() as { type: string; name: string }[];
    const tables: Record<string, { rows: number; sha256: string }> = {};
    for (const { name } of schema.filter(row => row.type === "table")) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/i);
      const rows = db.prepare(`SELECT rowid AS __rowid,* FROM "${name}" ORDER BY rowid`).all();
      assert.ok(rows.length < 100_000, "Unexpected database size requires review");
      tables[name] = { rows: rows.length, sha256: sha256(JSON.stringify(rows)) };
    }
    return { schemaSha256: sha256(JSON.stringify(schema)), tables };
  })();
}

function discoverDatabases(): string[] {
  const found: string[] = [];
  for (const root of [".local-dev", "nextjs/.local-data/development", "nextjs/.local-data/backups", "server/.local-data/development/sqlite-demo"]) {
    function walk(path: string, depth: number) {
      ordinary(path);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isFile() && entry.name.endsWith(".sqlite")) { ordinary(file); found.push(file); }
        else if (entry.isDirectory() && depth < 3 && /^(?:backups|development-[a-f0-9-]+)$/.test(entry.name)) walk(file, depth + 1);
      }
    }
    walk(resolve(workspaceRoot, root), 0);
  }
  if (runtimeDataRoot && existsSync(runtimeDataRoot)) {
    ordinary(runtimeDataRoot);
    for (const entry of readdirSync(runtimeDataRoot, { withFileTypes: true })) {
      const file = join(runtimeDataRoot, entry.name);
      if (entry.isFile() && entry.name.endsWith(".sqlite")) { ordinary(file); found.push(file); }
    }
  }
  assert.ok(found.length > 0 && found.length < 250);
  return found.sort();
}

function inspect() {
  assert.deepEqual(process.argv.slice(2), ["--read-only"], "Explicit --read-only required");
  const at = new Date().toISOString();
  const originalFiles = execFileSync("git", ["ls-files", "-z", "--", "assets/photos"], { cwd: workspaceRoot, encoding: "utf8" })
    .split("\0").filter(Boolean).sort();
  const originals = originalFiles.map(path => {
    assert.ok(path.startsWith("assets/photos/"));
    const data = bytes(resolve(workspaceRoot, path));
    return { path, size: data.length, sha256: sha256(data) };
  });
  const corpusHashes = new Set(originals.map(row => row.sha256));
  const databases = discoverDatabases();
  const beforePhysical = new Map(databases.map(path => [path, physical(path)]));
  const results = databases.map(path => {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      assert.equal(db.readonly, true); db.pragma("query_only=ON"); db.pragma("trusted_schema=OFF");
      assert.equal(db.pragma("query_only", { simple: true }), 1);
      const before = logical(db), counts: Record<string, number> = {};
      for (const table of candidateTables) if (before.tables[table]) counts[table] = before.tables[table]!.rows;
      const storedFiles: { table: string; id: string; parentId: string; size: number; sha256: string; matchedOriginalPaths: string[];
        parentExists: boolean; uploaderExists: boolean; auditMatches: number }[] = [];
      for (const table of ["task_attachment", "crm_department_log_attachments"]) {
        if (!before.tables[table]?.rows) continue;
        const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
        assert.ok(["id", "content", "content_sha256", "file_size", "uploaded_by"].every(name => columns.some(col => col.name === name)),
          "Nonempty historical path-only attachment table requires a separate manifest inspection");
        const isTask = table === "task_attachment", parentKey = isTask ? "task_id" : "log_id";
        const rows = db.prepare(`SELECT id,"${parentKey}" AS parentId,content,content_sha256,file_size,uploaded_by,created_at FROM "${table}" ORDER BY id`).all() as {
          id: string; parentId: string; content: Buffer; content_sha256: string; file_size: number; uploaded_by: string; created_at: string;
        }[];
        for (const row of rows) {
          const digest = sha256(row.content);
          assert.equal(digest, row.content_sha256); assert.equal(row.content.length, row.file_size);
          const parent = db.prepare(isTask ? "SELECT id FROM tasks WHERE id=?" :
            "SELECT l.id FROM crm_department_work_logs l JOIN tasks t ON t.id=l.task_id WHERE l.id=?").get(row.parentId);
          const uploader = db.prepare("SELECT id FROM users WHERE id=?").get(row.uploaded_by);
          const audit = isTask ? "crm_attachment_audit_events" : "crm_department_log_attachment_audit_events";
          const auditMatches = (db.prepare(`SELECT count(*) AS n FROM "${audit}" WHERE attachment_id=? AND "${parentKey}"=? AND actor_user_id=? AND occurred_at=?`)
            .get(row.id, row.parentId, row.uploaded_by, row.created_at) as { n: number }).n;
          assert.ok(parent && uploader); assert.equal(auditMatches, 1, "Attachment requires exact parent/actor/time audit linkage");
          storedFiles.push({ table, id: row.id, parentId: row.parentId, size: row.file_size, sha256: digest,
            matchedOriginalPaths: corpusHashes.has(digest) ? originals.filter(original => original.sha256 === digest).map(original => original.path) : [],
            parentExists: !!parent, uploaderExists: !!uploader, auditMatches });
        }
      }
      assert.deepEqual(logical(db), before, "Read-only inspection must preserve all logical rows, sessions and schema");
      return { path: normalized(path), readonly: db.readonly, queryOnly: true, preservedLogicalState: before,
        counts, storedFiles, currentDemo: resolve(path) === resolve(databaseConfig.filename) };
    } finally { db.close(); }
  });

  const finalPath = join(dirname(databaseConfig.filename), "backups", backupName);
  const live = new Database(databaseConfig.filename, { readonly: true, fileMustExist: true });
  const final = new Database(finalPath, { readonly: true, fileMustExist: true });
  let liveCounts: { tables: number; rows: number };
  try {
    live.pragma("query_only=ON"); final.pragma("query_only=ON");
    const current = compatibilitySnapshot(live), saved = compatibilitySnapshot(final);
    assert.deepEqual(current, saved, "Current WAL-aware full rows/schema/session state must match final verified backup");
    liveCounts = { tables: Object.keys(current.tables).length, rows: Object.values(current.tables).reduce((n, table) => n + table.count, 0) };
  } finally { live.close(); final.close(); }

  const schemaPath = resolve(workspaceRoot, ".local-dev/schema.sql"), schema = bytes(schemaPath);
  const schemaInfo = { path: normalized(schemaPath), sha256: sha256(schema), createTableStatements: [...schema.toString("utf8").matchAll(/create\s+table/gi)].length,
    insertStatements: [...schema.toString("utf8").matchAll(/insert\s+into/gi)].length };
  const logRoot = preservedPath(workspaceRoot, "application/logs", "directory");
  const phpLogs = readdirSync(logRoot).filter(name => /^log-.*\.php$/.test(name)).map(name => {
    const path = join(logRoot, name), content = bytes(path);
    return { path: normalized(path), size: content.length, sha256: sha256(content),
      attachmentEventMarkers: [...content.toString("utf8").matchAll(/attachment(?:\s+(?:sync|download|DB|saved|uploaded)|_id)|Processing attachment/gi)].length };
  });
  const branding = ["assets/photos/logo/databg.png", "assets/photos/logo/switchgear_bg4.png", "assets/photos/logo/sign.jpg", "assets/photos/logo/stamp.jpg"];
  const allStored = results.flatMap(result => result.storedFiles), current = results.find(result => result.currentDemo)!;
  const matchedHashes = new Set(allStored.filter(row => row.matchedOriginalPaths.length).map(row => row.sha256));
  // None of the inspected SQLite files is an owner-approved original export.
  // Keep their links as local evidence above, but do not pass them as historical
  // authority merely because a path, filename, or digest happens to match.
  const historicalReconciliation = reconcileAttachmentOwnership(originals, []);
  const perFileClaims = originals.map(original => ({ ...original,
    sourceBrandingReference: branding.includes(original.path),
    localBlobHashMatches: allStored.filter(row => row.sha256 === original.sha256).map(row => ({ table: row.table, id: row.id, parentId: row.parentId })),
    historicalDisposition: "ORPHANED_RELATIVE_TO_AVAILABLE_AUTHORITY",
    historicalParentAuthorization: "UNVERIFIED: no authoritative original database/file export mapping established" }));
  for (const original of originals) assert.equal(sha256(bytes(resolve(workspaceRoot, original.path))), original.sha256);
  for (const path of databases) assert.deepEqual(physical(path), beforePhysical.get(path), "Database/main WAL files must be preserved");
  assert.equal(sha256(bytes(schemaPath)), schemaInfo.sha256);
  for (const log of phpLogs) assert.equal(sha256(bytes(resolve(workspaceRoot, log.path))), log.sha256);

  const summary = { databasesInspected: results.length,
    legacyDatabases: results.filter(row => row.path.startsWith(".local-dev/")).length,
    documentedRuntimeDatabases: results.filter(row => row.path.startsWith("[documented-local-runtime]/")).length,
    retainedNextDatabases: results.filter(row => row.path.startsWith("nextjs/")).length,
    demoDatabases: results.filter(row => row.path.startsWith("server/")).length,
    originalFiles: originals.length, distinctOriginalHashes: corpusHashes.size,
    originalFilesWithLocalBlobMatch: originals.filter(row => matchedHashes.has(row.sha256)).length,
    distinctStoredFilesAcrossSnapshots: new Set(allStored.map(row => row.table + ":" + row.id)).size,
    currentTaskAttachments: current.counts.task_attachment ?? 0,
    currentLogAttachments: current.counts.crm_department_log_attachments ?? 0,
    currentParentActorAuditLinksVerified: current.storedFiles.length,
    historicalParentClaimsVerified: 0, currentEqualsBackup: true, liveCounts,
    historicalReconciliation: { verified: historicalReconciliation.verified.length,
      ambiguous: historicalReconciliation.ambiguous.length, missingRecords: historicalReconciliation.missing.length,
      orphanedRelativeToAvailableAuthority: historicalReconciliation.orphaned.length,
      authoritativeRecordsAvailable: 0 },
    originalFilesPreserved: originals.length, databaseFilesAndLogicalStatesPreserved: results.length,
    uploadsDirectoryPresent: existsSync(resolve(workspaceRoot, "uploads")), sourceReferencedBrandingFiles: branding.length };
  const evidenceDirectory = privateDirectory(["evidence", "attachment-ownership-" + randomUUID()], true);
  const databaseEvidence = results.map((result, index) => {
    const file = `database-${String(index + 1).padStart(3, "0")}.json`;
    writePrivateNew(join(evidenceDirectory, file), result);
    return { file, path: result.path, counts: result.counts, storedFiles: result.storedFiles.length, readonly: true, preserved: true };
  });
  const originalEvidence = [];
  for (let offset = 0; offset < perFileClaims.length; offset += 100) {
    const file = `original-claims-${String(offset / 100 + 1).padStart(2, "0")}.json`;
    writePrivateNew(join(evidenceDirectory, file), perFileClaims.slice(offset, offset + 100)); originalEvidence.push(file);
  }
  const receiptPath = join(evidenceDirectory, "receipt-private.json");
  writePrivateNew(receiptPath, { status: "PASS_READ_ONLY_AUDIT", at, authenticationAttempts: 0, databaseWrites: 0,
    summary, backupName, scope: "Only the four explicit repository SQLite roots, their bounded backup directories, and the previously documented local runtime data directory; no MySQL, remote storage, credentials or other external filesystem.",
    limitations: "BLOB identity and valid local parent/audit rows establish only local linkage, not original historical ownership. No association inferred from filenames, embedded PDF names, signatures or document dates. Stopped MySQL physical stores are not parsed or started.",
    schemaInfo, phpLogs, databases: databaseEvidence, originalClaims: originalEvidence });
  console.log(JSON.stringify({ status: "PASS_READ_ONLY_AUDIT", receipt: normalized(receiptPath), summary }));
}

inspect();
