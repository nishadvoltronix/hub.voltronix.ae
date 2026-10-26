import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../../tests/sqlite-reference/db/connection.ts";
import { assertMigrationsCurrent, migrateDatabase } from "../../tests/sqlite-reference/db/migrations.ts";
import { privateAccess } from "../scripts/mysql-auth/files.js";
import { seedDemo } from "./fixture.js";
import { listenerOwnershipScript } from "./listener-ownership.js";
import { LauncherRecoveryError, recoverStaleLease, staleLeaseDiagnostic } from "./recovery.js";
import { parseDemoVerificationArguments, preflightDemoSessionPolicy, VerificationScopeError, type DemoVerificationScope } from "./verification-scope.js";
import { acknowledgement, access, backendRoot, dataRoot, databaseConfig, databaseRelative, demoConfiguration, demoInstanceId,
  openDemo, privateDirectory, readPrivate, workspaceRoot, writePrivateNew } from "./storage.js";

const loader = pathToFileURL(join(backendRoot, "../node_modules/tsx/dist/loader.mjs")).href;
const thisFile = join(backendRoot, "demo-sqlite/control.ts");
const lockFile = join(dataRoot, "launcher.lock");
const frontend = "http://127.0.0.1:3001";
const api = "http://127.0.0.1:3002/api/v1";
const output = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
type OwnedChild = { process: ChildProcess; failed: boolean; ready: boolean };
type ReadyReceipt = { status: string; runId: string; supervisorPid: number; apiPid: number; frontendPid: number;
  frontend: string; api: string; provider: string; startedAt: string };

// Next's installed server registers graceful SIGTERM cleanup before resolving.
// IPC binds readiness to this exact owned process and closes it if its owner dies.
const nextBootstrap = `
const { startServer } = require(process.argv[1]);
let ready = false, stopping = false;
function stop() { stopping = true; if (ready) process.emit('SIGTERM', 'SIGTERM'); }
process.on('message', message => { if (message === 'sqlite-demo-stop') stop(); });
process.once('disconnect', stop);
startServer({ dir: process.argv[2], hostname: '127.0.0.1', port: 3001,
  isDev: false, allowRetry: false, keepAliveTimeout: 1000 }).then(() => {
  ready = true;
  if (stopping || !process.connected) return stop();
  process.send({ status: 'SQLITE_DEMO_FRONTEND_READY' });
}).catch(() => { console.error('Owned SQLite demo frontend failed.'); process.exit(1); });
`;

/** New demo children receive only OS essentials and explicit non-secret local
 * settings. No inherited environment/profile, debug or credential forwarding.
 * Existing MySQL private helpers are never invoked or changed by this launcher. */
function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, CRM_SQLITE_DEMO: acknowledgement, CRM_API_ENVIRONMENT: "development", CRM_API_HOST: "127.0.0.1",
    CRM_API_PORT: "3002", APP_ORIGIN: frontend, NODE_ENV: "development", CRM_MYSQL_NETWORK_DISABLED: "1",
    NEXT_TELEMETRY_DISABLED: "1", TSX_DISABLE_CACHE: "1" };
}

async function assertPortsFree() {
  for (const port of [3001, 3002]) {
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", () => reject(new Error("Expected demo port occupied; no process was stopped.")));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
    });
  }
}
async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(1500) });
    return response.status === 200 && (await response.json() as { status?: string }).status === "running";
  } catch { return false; }
}
function exited(child: OwnedChild): boolean {
  return child.process.exitCode !== null || child.process.signalCode !== null || (child.failed && !child.process.pid);
}
async function waitHealth(url: string, child: OwnedChild) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.failed || exited(child)) throw new Error("Owned demo service exited during startup.");
    if (child.ready && await healthy(url)) return;
    await delay(500);
  }
  throw new Error("Owned demo service did not become healthy.");
}
function currentRun(): { runId: string; directory: string } | undefined {
  if (!existsSync(lockFile)) return undefined;
  const value = readPrivate(lockFile) as { runId?: string };
  if (!value.runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.runId)) throw new Error("Invalid owned launcher receipt.");
  return { runId: value.runId, directory: privateDirectory(["runs", value.runId]) };
}
function logChild(script: string, args: string[], environment: NodeJS.ProcessEnv, directory: string, name: string, readyStatus: string): OwnedChild {
  const out = openSync(join(directory, `${name}-stdout.log`), "wx", 0o600);
  let err: number | undefined;
  try {
    err = openSync(join(directory, `${name}-stderr.log`), "wx", 0o600);
    const child: OwnedChild = { process: spawn(process.execPath, [script, ...args], { cwd: backendRoot, env: environment,
      windowsHide: true, stdio: ["ignore", out, err, "ipc"] }), failed: false, ready: false };
    child.process.on("error", () => { child.failed = true; });
    child.process.on("message", message => {
      if (message !== null && typeof message === "object" && "status" in message && message.status === readyStatus) child.ready = true;
    });
    return child;
  } finally { closeSync(out); if (err !== undefined) closeSync(err); }
}
async function stopChild(child: OwnedChild | undefined) {
  if (!child || exited(child)) return;
  if (child.process.connected) child.process.send("sqlite-demo-stop", error => { if (error) child.failed = true; });
  else child.process.kill("SIGTERM");
  for (let attempt = 0; attempt < 60 && !exited(child); attempt++) await delay(100);
  if (!exited(child)) {
    child.process.kill("SIGKILL");
    for (let attempt = 0; attempt < 30 && !exited(child); attempt++) await delay(100);
  }
  if (!exited(child)) throw new Error("Owned child exit not confirmed; ownership lease retained.");
}

async function initialize() {
  privateDirectory([], true);
  await assertPortsFree();
  if (existsSync(databaseConfig.filename) || existsSync(join(dataRoot, "access.json")) || existsSync(join(dataRoot, "initialized.json"))) {
    throw new Error("Existing or partial demo retained. Initialization never overwrites or reseeds.");
  }
  const db = openDatabase(databaseConfig, { create: true });
  try {
    const applied = migrateDatabase(db), repeat = migrateDatabase(db);
    if (applied !== 10 || repeat !== 0) throw new Error("Unexpected demo migration result.");
    const fixture = await seedDemo(db);
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length) throw new Error("Demo integrity validation failed.");
    writePrivateNew(join(dataRoot, "access.json"), { version: 1, provider: "sqlite-demo", database: databaseRelative, fixture });
    writePrivateNew(join(dataRoot, "initialized.json"), { version: 1, database: databaseRelative, fixtureId: fixture.fixtureId,
      migrationApplied: applied, migrationRepeat: repeat, summary: fixture.summary, initializedAt: new Date().toISOString() });
    output({ status: "SQLITE_DEMO_INITIALIZED", database: databaseRelative, migrationApplied: applied, migrationRepeat: repeat,
      summary: fixture.summary, accessFile: `${dataRoot}/access.json`, secretsDisclosed: false });
  } finally { db.close(); }
}

async function supervise(runId: string) {
  const run = currentRun();
  if (!run || run.runId !== runId) throw new Error("Ownership mismatch.");
  // An exclusive claim prevents a second invocation from supervising this run.
  writePrivateNew(join(run.directory, "supervisor.json"), { runId, pid: process.pid });
  let apiChild: OwnedChild | undefined, nextChild: OwnedChild | undefined, failed = false;
  let cleanupFailed: boolean;
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  try {
    await assertPortsFree();
    apiChild = logChild("--import", [loader, join(backendRoot, "demo-sqlite/api.ts")], childEnvironment(), run.directory, "api", "SQLITE_DEMO_API_READY");
    await waitHealth(`${api}/health/live`, apiChild);
    // Next loads the root .env for values missing from process.env. Pin the
    // demo identity and mask private Hub settings before starting its frontend.
    const privateHubKeys = ["CRM_RUNTIME_ENABLE", "CRM_RUNTIME_SOURCE", "CRM_MYSQL_HOST", "CRM_MYSQL_PORT",
      "CRM_MYSQL_DATABASE", "CRM_MYSQL_USER", "CRM_MYSQL_PASSWORD", "CRM_MYSQL_SERVER_UUID",
      "CRM_MYSQL_APPROVED", "CRM_MYSQL_APPROVAL_REFERENCE", "CRM_MYSQL_PROVISIONING_REFERENCE",
      "CRM_MYSQL_ISSUER_COMPANY", "CRM_MYSQL_ISSUER_SALESPERSON", "ZOHO_CLIENT_ID",
      "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORGANIZATION_ID", "ZOHO_ACCOUNT_OWNER_ID",
      "ZOHO_PROFILE", "ZOHO_DEAL_PIPELINE", "ZOHO_AUTOMATION_POLICY", "ZOHO_SYNC_INTERVAL_SECONDS",
      "ZOHO_SYNC_PRINCIPAL_ID"];
    const environment = { ...childEnvironment(), NODE_ENV: "production", CRM_FRONTEND_BACKEND: "express",
      CRM_EXPRESS_ORIGIN: "http://127.0.0.1:3002", CRM_API_INSTANCE_ID: demoInstanceId,
      CRM_DATABASE_MODE: "disabled", ZOHO_ENABLED: "false", ZOHO_SYNC_ENABLED: "false",
      ZOHO_NETWORK_DISABLED: "1", ...Object.fromEntries(privateHubKeys.map(key => [key, ""])) };
    nextChild = logChild("--input-type=commonjs", ["-e", nextBootstrap,
      join(workspaceRoot, "node_modules/next/dist/server/lib/start-server.js"), workspaceRoot],
      environment, run.directory, "frontend", "SQLITE_DEMO_FRONTEND_READY");
    await waitHealth(`${frontend}/api/health/live`, nextChild);
    writePrivateNew(join(run.directory, "ready.json"), { status: "RUNNING", runId, supervisorPid: process.pid,
      apiPid: apiChild.process.pid, frontendPid: nextChild.process.pid, frontend, api, provider: "sqlite-demo", startedAt: new Date().toISOString() });
    while (!stopping && !existsSync(join(run.directory, "stop.request"))) {
      if (apiChild.failed || nextChild.failed || exited(apiChild) || exited(nextChild)) {
        throw new Error("Owned demo service stopped unexpectedly.");
      }
      await delay(250);
    }
  } catch {
    failed = true;
    if (!existsSync(join(run.directory, "failed.json"))) writePrivateNew(join(run.directory, "failed.json"),
      { status: "FAILED_RETAINED", runId, detail: "Owned local demo startup or lifecycle failed; inspect retained sanitized logs." });
  } finally {
    const cleanup = await Promise.allSettled([stopChild(nextChild), stopChild(apiChild)]);
    cleanupFailed = cleanup.some(result => result.status === "rejected");
    if (cleanupFailed) {
      writePrivateNew(join(run.directory, "shutdown-failed.json"), { status: "FAILED_RETAINED", runId, childrenExited: false });
    } else {
      writePrivateNew(join(run.directory, "stopped.json"), { status: failed ? "FAILED_RETAINED" : "STOPPED", runId,
        childrenExited: true, stoppedAt: new Date().toISOString() });
      // Remove only this run's transient lease, never a DB/profile/log/receipt.
      const lease = currentRun();
      if (lease?.runId === runId) unlinkSync(lockFile);
    }
  }
  if (cleanupFailed) throw new Error("Owned shutdown remains unconfirmed; lease retained.");
}

async function start() {
  if (existsSync(lockFile)) throw new LauncherRecoveryError("LEASE_PRESENT");
  const db = openDemo(true); db.close();
  await assertPortsFree();
  if (existsSync(lockFile)) throw new LauncherRecoveryError("LEASE_PRESENT");
  const runId = randomUUID(), directory = privateDirectory(["runs", runId], true);
  writePrivateNew(lockFile, { runId, acquiredAt: new Date().toISOString() });
  const out = openSync(join(directory, "supervisor.log"), "wx", 0o600);
  let controller: ChildProcess;
  let controllerFailed = false;
  try {
    controller = spawn(process.execPath, ["--import", loader, thisFile, "supervise", runId],
      { cwd: backendRoot, env: childEnvironment(), windowsHide: true, detached: true, stdio: ["ignore", out, out] });
    controller.on("error", () => { controllerFailed = true; });
    controller.unref();
  } finally { closeSync(out); }
  for (let attempt = 0; attempt < 150; attempt++) {
    if (controllerFailed || controller.exitCode !== null || controller.signalCode !== null
      || existsSync(join(directory, "failed.json")) || existsSync(join(directory, "stopped.json"))) throw new Error("Demo start failed; retained logs identify the owned run.");
    if (existsSync(join(directory, "ready.json"))) {
      try { await assertRunning(); }
      catch (error) {
        if (!existsSync(join(directory, "stop.request"))) writePrivateNew(join(directory, "stop.request"), { reason: "ownership-check-failed" });
        throw error;
      }
      output({ status: "RUNNING", frontend, api, runId, evidence: directory }); return;
    }
    await delay(500);
  }
  if (!existsSync(join(directory, "stop.request"))) writePrivateNew(join(directory, "stop.request"), { reason: "startup-timeout" });
  throw new Error("Demo startup timed out; requested owned shutdown.");
}
async function stop() {
  privateDirectory();
  const run = currentRun();
  if (!run) { output({ status: "NOT_RUNNING", unrelatedProcessesStopped: 0 }); return; }
  const stopPath = join(run.directory, "stop.request");
  if (!existsSync(stopPath)) writePrivateNew(stopPath, { requestedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (existsSync(join(run.directory, "stopped.json"))) {
      const stopped = readPrivate(join(run.directory, "stopped.json")) as { runId?: string; childrenExited?: boolean };
      if (stopped.runId !== run.runId || stopped.childrenExited !== true) throw new Error("Owned shutdown receipt invalid.");
      if (currentRun()?.runId !== run.runId) { output({ status: "STOPPED", runId: run.runId, databasePreserved: true }); return; }
    }
    await delay(200);
  }
  throw new Error("Owned stop was not confirmed. No guessed PID was killed.");
}
async function verify(verification: DemoVerificationScope) {
  preflightDemoSessionPolicy(verification.sessionPolicy);
  const owned = access();
  await assertRunning();
  const { runBrowserAcceptance } = await import("./browser-acceptance.js");
  const fixture = owned.fixture;
  const worker = fixture.identities.workers.Electrical;
  const result = await runBrowserAcceptance({ origin: frontend, verification,
    accounts: { browserManager: fixture.identities.browser, browserWorker: worker, browserDenied: fixture.identities.denied,
      quoteOwner: fixture.identities.contracting,
      additionalWorkers: Object.entries(fixture.identities.workers).map(([department, account]) => ({ department, account })) },
    fixture: { jobId: fixture.jobId, leadId: fixture.leadId, contractingTaskId: fixture.contractingTaskId,
      switchgearTaskId: fixture.switchgearTaskId, workerId: worker.id, workerName: worker.name } });
  const evidenceDirectory = privateDirectory(["evidence"], true);
  const evidence = join(evidenceDirectory, `browser-${randomUUID()}.json`);
  writePrivateNew(evidence, result);
  output({ ...result, evidence });
  if (result.status !== "PASS") process.exitCode = 1;
}
async function verifyAnonymous() {
  await assertRunning();
  const { runAnonymousAcceptance } = await import("./anonymous-browser.js");
  const result = await runAnonymousAcceptance({ origin: frontend });
  output({ status: result.status, scope: result.scope, evidence: result.receipt, screenshots: result.images.length,
    checks: result.checks.length, observations: result.observations, loginAttempts: result.loginAttempts,
    applicationWrites: result.applicationWrites });
  if (result.status !== "PASS") process.exitCode = 1;
}
async function assertRunning() {
  const run = currentRun();
  if (!run || !existsSync(join(run.directory, "ready.json")) || existsSync(join(run.directory, "stopped.json"))
    || existsSync(join(run.directory, "failed.json")) || existsSync(join(run.directory, "shutdown-failed.json"))
    || existsSync(join(run.directory, "stop.request"))) throw new Error("Both owned demo services must be running.");
  const ready = readPrivate(join(run.directory, "ready.json")) as ReadyReceipt;
  const supervisor = readPrivate(join(run.directory, "supervisor.json")) as { runId?: string; pid?: number };
  const pids = [ready.supervisorPid, ready.apiPid, ready.frontendPid];
  if (ready.status !== "RUNNING" || ready.runId !== run.runId || ready.provider !== "sqlite-demo"
    || ready.frontend !== frontend || ready.api !== api || supervisor.runId !== run.runId || supervisor.pid !== ready.supervisorPid
    || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || new Set(pids).size !== 3) throw new Error("Owned readiness receipt invalid.");
  // This local launcher targets Windows. Read-only OS evidence binds both
  // listeners to the recorded children of this run's live Node supervisor.
  if (process.platform !== "win32") throw new Error("Listener ownership verification requires this Windows demo launcher.");
  const ownership = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(listenerOwnershipScript, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000,
    input: JSON.stringify({ ...ready, executable: process.execPath }), stdio: ["pipe", "ignore", "ignore"] });
  if (ownership.error || ownership.status !== 0 || !await healthy(`${api}/health/live`) || !await healthy(`${frontend}/api/health/live`)) {
    throw new Error("Live listener ownership or service health was not confirmed.");
  }
  return run;
}
function databaseSnapshot() {
  const db = openDemo(true);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const digest = createHash("sha256");
    let rows = 0;
    for (const { name } of tables) {
      if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("Unexpected demo table.");
      const records = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
      rows += records.length;
      digest.update(JSON.stringify([name, records]));
    }
    return { tables: tables.length, rows, digest: digest.digest("hex") };
  } finally { db.close(); }
}
async function restartCheck() {
  await assertRunning();
  const before = databaseSnapshot();
  await stop();
  await start();
  const after = databaseSnapshot();
  if (before.digest !== after.digest || before.rows !== after.rows) throw new Error("Persistence verification mismatch; retained database requires review.");
  const result = { status: "PASS", check: "owned API and frontend restart preserves every SQLite row", tables: after.tables,
    rows: after.rows, verifiedAt: new Date().toISOString(), frontend, api };
  const evidence = join(privateDirectory(["evidence"], true), `restart-${randomUUID()}.json`);
  writePrivateNew(evidence, result); output({ ...result, evidence });
}
async function backup() {
  privateDirectory(["backups"], true);
  const filename = join(dataRoot, "backups", `crm-demo-${randomUUID()}.sqlite`);
  const db = openDemo(true);
  try {
    // Reserve only an absent owned file and check its privacy before SQLite writes.
    closeSync(openSync(filename, "wx", 0o600));
    privateAccess(filename, false);
    const reserved = lstatSync(filename);
    await db.backup(filename);
    const completed = lstatSync(filename);
    if (completed.ino !== reserved.ino || completed.dev !== reserved.dev || completed.nlink !== 1 || !completed.isFile()) {
      throw new Error("Backup destination changed; retained for review.");
    }
    privateAccess(filename, false);
    const copy = openDatabase({ ...databaseConfig, filename }, { readonly: true });
    try {
      assertMigrationsCurrent(copy);
      if (copy.pragma("integrity_check", { simple: true }) !== "ok" || (copy.pragma("foreign_key_check") as unknown[]).length !== 0) {
        throw new Error("Backup integrity validation failed; retained for review.");
      }
    } finally { copy.close(); }
    const result = { status: "SQLITE_DEMO_BACKUP_CREATED", filename, integrityVerified: true, verifiedAt: new Date().toISOString() };
    const evidence = filename + ".json";
    writePrivateNew(evidence, result); output({ ...result, evidence });
  }
  finally { db.close(); }
}

const action = process.argv[2];
try {
  const verification = parseDemoVerificationArguments(process.argv.slice(2));
  if (!["init", "start", "stop", "status", "verify", "verify-anonymous", "restart-check", "backup", "supervise", "recover-lease"].includes(action ?? "")) throw new Error("Choose an explicit SQLite demo action.");
  if (action === "recover-lease" && process.argv.length !== 3) throw new Error("Recovery accepts no path or process arguments.");
  if (process.env.CRM_SQLITE_DEMO !== acknowledgement) {
    // Public launcher constructs a separate, non-debug local process before
    // any private data access. Never changes the caller or an existing profile.
    const child = spawn(process.execPath, ["--import", loader, thisFile, ...process.argv.slice(2)],
      { cwd: backendRoot, env: childEnvironment(), windowsHide: true, stdio: "inherit" });
    process.exitCode = await new Promise<number>(resolve => { child.once("error", () => resolve(1)); child.once("exit", code => resolve(code ?? 1)); });
  } else {
    demoConfiguration(process.env);
    if (action === "init") await initialize();
    else if (action === "start") await start();
    else if (action === "stop") await stop();
    else if (action === "supervise") await supervise(process.argv[3] ?? "");
    else if (action === "verify") await verify(verification!);
    else if (action === "verify-anonymous") await verifyAnonymous();
    else if (action === "restart-check") await restartCheck();
    else if (action === "backup") await backup();
    else if (action === "recover-lease") { privateDirectory(); output(recoverStaleLease(dataRoot)); }
    else {
      let running = false;
      try { await assertRunning(); running = true; } catch { /* Status never adopts an unrelated listener. */ }
      output({ status: running ? "RUNNING" : "NOT_RUNNING", frontend, api, provider: "sqlite-demo",
        ...(!running && existsSync(lockFile) ? staleLeaseDiagnostic(dataRoot) : {}) });
    }
  }
} catch (error) {
  if (error instanceof VerificationScopeError) {
    console.error(JSON.stringify({ status: "SQLITE_DEMO_VERIFICATION_REFUSED", action, reason: error.reason, detail: error.message,
      authenticationAttempts: 0, applicationWrites: 0 }));
    process.exitCode = 1;
  } else if (error instanceof LauncherRecoveryError) {
    console.error(JSON.stringify({ status: "SQLITE_DEMO_ACTION_REFUSED", action, reason: error.reason,
      detail: error.message, databaseChanged: false, processesStopped: 0 }));
    process.exitCode = 1;
  } else {
    console.error(JSON.stringify({ status: "SQLITE_DEMO_ACTION_FAILED", action, detail: "No automatic overwrite, reseed or cleanup. Inspect retained demo evidence; existing data is preserved." }));
    process.exitCode = 1;
  }
}
