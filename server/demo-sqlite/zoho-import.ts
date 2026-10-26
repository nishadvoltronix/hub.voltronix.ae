import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../../tests/sqlite-reference/db/connection.js";
import { loadBackendEnvironment } from "../src/environment.js";
import { validateZohoEnvironment } from "../src/runtime/environment-settings.js";
import { assertOrdinaryPath, privateAccess } from "../scripts/mysql-auth/files.js";
import { parseZohoInboundSnapshot } from "../src/integrations/zoho/inbound-snapshot.js";
import { captureLocalZohoSource, LocalZohoSourceError } from "./zoho-import-source.js";
import { captureImportPreservation } from "./zoho-import-preservation.js";
import { applyZohoImportExtension, applyZohoSqliteImport, prepareZohoSqliteImport, ZohoSqliteImportError } from "./zoho-import-store.js";
import { backendRoot, dataRoot, databaseConfig, openDemo, privateDirectory, readPrivate, writePrivateNew } from "./storage.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const output = (value: unknown) => console.log(JSON.stringify(value));
const maximumSnapshotBytes = 20 * 1024 * 1024;
let phase = "preflight";
let committedRunId: string | undefined;
function stagedSnapshot(directory: string, value?: unknown) {
  const filename = join(directory, "snapshot.json");
  if (value !== undefined) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > maximumSnapshotBytes) throw new Error("Snapshot too large.");
    const fd = openSync(filename, "wx", 0o600);
    try { privateAccess(filename, false); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); bytes.fill(0); }
  }
  assertOrdinaryPath(dataRoot, filename); privateAccess(filename, false);
  const before = lstatSync(filename);
  if (!before.isFile() || before.nlink !== 1 || before.size > maximumSnapshotBytes) throw new Error("Invalid staged snapshot.");
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw new Error("Snapshot changed.");
    const source = readFileSync(fd, "utf8"), after = lstatSync(filename);
    if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("Snapshot changed.");
    return { hash: sha256(source), snapshot: parseZohoInboundSnapshot(JSON.parse(source)) };
  } finally { closeSync(fd); }
}
function mappings(db: ReturnType<typeof openDemo>) {
  return { userMappings: (db.prepare("SELECT user_id externalId,CAST(id AS TEXT) localUserId FROM users WHERE status='active'").all() as
    { externalId: string | null; localUserId: string }[]).filter((row): row is { externalId: string; localUserId: string } =>
      typeof row.externalId === "string" && /^[1-9][0-9]{0,29}$/.test(row.externalId)) };
}
async function stopped() {
  if (existsSync(join(dataRoot, "launcher.lock"))) throw new Error("Stop the owned local CRM before applying the preview.");
  for (const port of [3001, 3002]) await new Promise<void>((resolve, reject) => {
    const server = createServer(); server.once("error", () => reject(new Error("Local CRM port is occupied.")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}
async function backup(db: ReturnType<typeof openDemo>, runId: string) {
  const filename = join(privateDirectory(["backups"], true), `before-zoho-${runId}-${randomUUID()}.sqlite`);
  closeSync(openSync(filename, "wx", 0o600)); privateAccess(filename, false);
  const before = lstatSync(filename); await db.backup(filename); const after = lstatSync(filename);
  if (after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1) throw new Error("Backup changed.");
  privateAccess(filename, false);
  const copy = openDatabase({ ...databaseConfig, filename }, { readonly: true });
  try {
    if (copy.pragma("integrity_check", { simple: true }) !== "ok" || (copy.pragma("foreign_key_check") as unknown[]).length) throw new Error("Backup failed.");
  } finally { copy.close(); }
  return filename;
}
async function main() {
  if (["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "NODE_OPTIONS", "PWDEBUG"].some(key => process.env[key])
    || process.execArgv.some(arg => arg.startsWith("--inspect"))) throw new Error("Debug environment refused.");
  const [action, runId, ...extra] = process.argv.slice(2);
  if (extra.length || !["preview", "apply"].includes(action ?? "") || action === "preview" && runId
    || action === "apply" && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId ?? "")) {
    throw new Error("Use preview or apply <preview-run-UUID>.");
  }
  if (action === "preview") {
    if (process.env.ZOHO_NETWORK_DISABLED === "1") throw new Error("Source networking is explicitly disabled.");
    // Preflight the exact existing local destination before using a source grant.
    phase = "local-database";
    const db = openDemo(true);
    try {
      phase = "private-environment";
      const env: Record<string, string | undefined> = {};
      loadBackendEnvironment(env, new URL("../.env", import.meta.url)); validateZohoEnvironment(env);
      phase = "source-read";
      const snapshot = await captureLocalZohoSource({ clientId: env.ZOHO_CLIENT_ID ?? "", clientSecret: env.ZOHO_CLIENT_SECRET ?? "", refreshToken: env.ZOHO_REFRESH_TOKEN ?? "" });
      phase = "local-preview";
      const plan = prepareZohoSqliteImport(db, snapshot, mappings(db));
      const id = randomUUID(), directory = privateDirectory(["zoho-imports", id], true);
      const staged = stagedSnapshot(directory, snapshot);
      const receipt = { version: 1, runId: id, sourceBinding: "owner-selected-grant-and-company-first-use", sourceCompany: "VOLTRONIX",
        organizationId: snapshot.organizationId, capturedAt: snapshot.capturedAt, contentHash: staged.hash, snapshotHash: plan.snapshotHash,
        summary: plan.summary, excludedScopes: snapshot.excludedScopes, excludedNoteCounts: snapshot.excludedNoteCounts, sourceBusinessWrites: 0 };
      writePrivateNew(join(directory, "preview.json"), receipt);
      output({ status: "ZOHO_LOCAL_PREVIEW_READY", runId: id, summary: plan.summary, excludedScopes: snapshot.excludedScopes,
        excludedNoteCounts: snapshot.excludedNoteCounts, sourceBusinessWrites: 0, localBusinessWrites: 0 });
    } finally { db.close(); }
    return;
  }
  phase = "stopped-preflight"; await stopped();
  const directory = privateDirectory(["zoho-imports", runId!]), staged = stagedSnapshot(directory);
  const preview = readPrivate(join(directory, "preview.json")) as Record<string, unknown>;
  if (preview.version !== 1 || preview.runId !== runId || preview.contentHash !== staged.hash
    || preview.organizationId !== staged.snapshot.organizationId) throw new Error("Preview receipt mismatch.");
  if (existsSync(join(directory, "applied.json"))) throw new Error("This preview already has an apply receipt. No replay performed.");
  const db = openDemo();
  try {
    const plan = prepareZohoSqliteImport(db, staged.snapshot, mappings(db));
    if (plan.snapshotHash !== preview.snapshotHash) throw new Error("Preview snapshot mismatch.");
    phase = "verified-backup";
    const verify = captureImportPreservation(db), backupFile = await backup(db, runId!);
    await stopped(); verify();
    phase = "apply"; applyZohoImportExtension(db, { organizationId: staged.snapshot.organizationId });
    const receipt = applyZohoSqliteImport(db, plan, { runId: runId!, importedAt: new Date().toISOString() }, { verify });
    committedRunId = receipt.runId;
    verify();
    phase = "receipt";
    writePrivateNew(join(directory, "applied.json"), { ...receipt, backupFile, preservationVerified: true,
      sourceBusinessWrites: 0, automaticSyncEnabled: false });
    output({ status: "ZOHO_LOCAL_IMPORT_APPLIED", ...receipt, preservationVerified: true, backupCreated: true,
      sourceBusinessWrites: 0, automaticSyncEnabled: false });
  } finally { db.close(); }
}
function reportFailure(error: unknown) {
  console.error(JSON.stringify({ status: committedRunId ? "ZOHO_LOCAL_IMPORT_APPLIED_EVIDENCE_PENDING" : "ZOHO_LOCAL_IMPORT_STOPPED", phase,
    ...(committedRunId ? { runId: committedRunId, committed: true } : {}),
    code: error instanceof LocalZohoSourceError || error instanceof ZohoSqliteImportError ? error.code : "LOCAL_PREFLIGHT_FAILED",
    ...(error instanceof LocalZohoSourceError && error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    detail: committedRunId ? "Import committed; final evidence needs review. Do not reset or blindly repeat. The database run ledger and backup are retained."
      : "Import did not complete. Existing data and any backup/evidence are retained; no automatic reset or cleanup. No credential or customer values logged." }));
  process.exitCode = 1;
}
// Like the local launcher, create a non-debug child with no inherited secrets.
// The child reads only this workspace's private .env for the explicit preview.
if (process.env.CRM_LOCAL_ZOHO_IMPORT !== "isolated-inbound") {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.CRM_LOCAL_ZOHO_IMPORT = "isolated-inbound";
  environment.CRM_MYSQL_NETWORK_DISABLED = "1";
  environment.TSX_DISABLE_CACHE = "1";
  if (process.env.ZOHO_NETWORK_DISABLED === "1") environment.ZOHO_NETWORK_DISABLED = "1";
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href,
    fileURLToPath(import.meta.url), ...process.argv.slice(2)], { cwd: backendRoot, env: environment, windowsHide: true, stdio: "inherit" });
  child.once("error", reportFailure);
  const interrupt = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  child.once("exit", code => {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); process.exitCode = code ?? 1;
  });
} else void main().catch(reportFailure);
