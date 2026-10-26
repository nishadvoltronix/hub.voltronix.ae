import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, type Stats } from "node:fs";
import { join } from "node:path";
import { assertOrdinaryPath, privateAccess } from "../scripts/mysql-auth/files.js";

type Reason = "LEASE_PRESENT" | "RECEIPTS_INVALID" | "PRIVATE_ACCESS" | "OS_UNAVAILABLE" | "NOT_PRE_BOOT"
  | "PROCESS_PRESENT" | "PORT_OCCUPIED" | "LEASE_CHANGED" | "ARCHIVE_FAILED";
const messages: Record<Reason, string> = {
  LEASE_PRESENT: "A launcher lease already exists. Run status to inspect it. Use recover-lease only for a confirmed pre-reboot stale lease; startup did not remove it.",
  RECEIPTS_INVALID: "Recovery requires matching valid launcher, supervisor and ready receipts. Existing evidence was retained.",
  PRIVATE_ACCESS: "Launcher recovery requires ordinary private directories and files. Existing permissions were not changed.",
  OS_UNAVAILABLE: "Windows boot, process or port observations could not be verified. The lease was retained.",
  NOT_PRE_BOOT: "This lease is not from before the current Windows boot. Recovery is refused; use normal stop for a live owned run.",
  PROCESS_PRESENT: "A recorded process ID is still present, possibly reused. No process was stopped and the lease was retained.",
  PORT_OCCUPIED: "Port 3001 or 3002 is occupied. No listener was stopped and the lease was retained.",
  LEASE_CHANGED: "Launcher evidence changed during recovery. The current lease was not archived.",
  ARCHIVE_FAILED: "The stale lease could not be archived. Inspect the retained launcher evidence before retrying.",
};
export class LauncherRecoveryError extends Error {
  constructor(readonly reason: Reason) { super(messages[reason]); }
}
export interface RecoveryObservation { bootedAt: string; presentPids: number[]; occupiedPorts: number[] }
interface Dependencies {
  privacy?: (path: string) => void;
  observe?: (pids: readonly number[]) => RecoveryObservation;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

/** Read-only queries. Any query/serialization error refuses recovery. A reused
 * recorded PID is deliberately treated as occupied, regardless of its command. */
export const recoveryObservationScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $expected = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $systems = @(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop)
  if ($systems.Count -ne 1 -or !$systems[0].LastBootUpTime) { exit 2 }
  $present = @()
  foreach ($selected in $expected.pids) {
    $processes = @(Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$selected) -ErrorAction Stop)
    if ($processes.Count -gt 0) { $present += [int]$selected }
  }
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @(3001,3002) })
  @{ bootedAt=$systems[0].LastBootUpTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ');
     presentPids=@($present); occupiedPorts=@($listeners | ForEach-Object { [int]$_.LocalPort }) } | ConvertTo-Json -Compress
} catch { exit 2 }
`;
export function observeRecovery(pids: readonly number[]): RecoveryObservation {
  if (process.platform !== "win32") throw new LauncherRecoveryError("OS_UNAVAILABLE");
  try {
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(recoveryObservationScript, "utf16le").toString("base64")], {
      input: JSON.stringify({ pids }), encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16_384,
    });
    if (result.error || result.status !== 0 || result.stderr.trim()) throw new Error();
    return JSON.parse(result.stdout) as RecoveryObservation;
  } catch { throw new LauncherRecoveryError("OS_UNAVAILABLE"); }
}

interface Snapshot { path: string; stat: Stats; bytes: Buffer; value: Record<string, unknown> }
function sameIdentity(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.nlink === 1;
}
function inspect(root: string, dependencies: Dependencies) {
  const privacy = dependencies.privacy ?? privateAccess;
  function protect(path: string) {
    try { assertOrdinaryPath(root, path); privacy(path); }
    catch { throw new LauncherRecoveryError("PRIVATE_ACCESS"); }
  }
  function snapshot(path: string): Snapshot {
    protect(path);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) throw new Error();
      const bytes = readFileSync(path), value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)
        || bytes.toString("utf8").replace(/\r\n/g, "\n").trim() !== JSON.stringify(value, null, 2).trim()
        || !sameIdentity(stat, lstatSync(path))) throw new Error();
      return { path, stat, bytes, value: value as Record<string, unknown> };
    } catch { throw new LauncherRecoveryError("RECEIPTS_INVALID"); }
  }
  protect(root);
  if (!lstatSync(root).isDirectory()) throw new LauncherRecoveryError("PRIVATE_ACCESS");
  const lease = snapshot(join(root, "launcher.lock"));
  const runId = lease.value.runId, acquiredAt = timestamp(lease.value.acquiredAt);
  if (typeof runId !== "string" || !uuid.test(runId) || !Number.isFinite(acquiredAt)) throw new LauncherRecoveryError("RECEIPTS_INVALID");
  const runDirectory = join(root, "runs", runId), directories = [root, join(root, "runs"), runDirectory];
  const directorySnapshots = directories.map(path => {
    protect(path); const stat = lstatSync(path);
    if (!stat.isDirectory()) throw new LauncherRecoveryError("PRIVATE_ACCESS");
    return { path, stat };
  });
  const supervisor = snapshot(join(runDirectory, "supervisor.json")), ready = snapshot(join(runDirectory, "ready.json"));
  const pids = [ready.value.supervisorPid, ready.value.apiPid, ready.value.frontendPid];
  const startedAt = timestamp(ready.value.startedAt);
  if (supervisor.value.runId !== runId || ready.value.runId !== runId || ready.value.status !== "RUNNING"
    || ready.value.provider !== "sqlite-demo" || ready.value.frontend !== "http://127.0.0.1:3001"
    || ready.value.api !== "http://127.0.0.1:3002/api/v1" || supervisor.value.pid !== ready.value.supervisorPid
    || pids.some(pid => !validPid(pid)) || new Set(pids).size !== 3
    || !Number.isFinite(startedAt) || startedAt < acquiredAt) throw new LauncherRecoveryError("RECEIPTS_INVALID");
  const snapshots = [lease, supervisor, ready];
  function unchanged() {
    for (const entry of directorySnapshots) {
      protect(entry.path); const now = lstatSync(entry.path);
      if (!now.isDirectory() || now.dev !== entry.stat.dev || now.ino !== entry.stat.ino) throw new LauncherRecoveryError("LEASE_CHANGED");
    }
    for (const entry of snapshots) {
      protect(entry.path);
      if (!sameIdentity(entry.stat, lstatSync(entry.path)) || !readFileSync(entry.path).equals(entry.bytes)) {
        throw new LauncherRecoveryError("LEASE_CHANGED");
      }
    }
  }
  function observe() {
    let result: RecoveryObservation;
    try { result = (dependencies.observe ?? observeRecovery)(pids as number[]); }
    catch { throw new LauncherRecoveryError("OS_UNAVAILABLE"); }
    const bootedAt = timestamp(result?.bootedAt);
    if (!Number.isFinite(bootedAt) || bootedAt > Date.now() || !Array.isArray(result.presentPids)
      || result.presentPids.some(pid => !validPid(pid) || !pids.includes(pid)) || !Array.isArray(result.occupiedPorts)
      || result.occupiedPorts.some(port => port !== 3001 && port !== 3002)) throw new LauncherRecoveryError("OS_UNAVAILABLE");
    if (acquiredAt >= bootedAt || startedAt >= bootedAt) throw new LauncherRecoveryError("NOT_PRE_BOOT");
    if (result.presentPids.length) throw new LauncherRecoveryError("PROCESS_PRESENT");
    if (result.occupiedPorts.length) throw new LauncherRecoveryError("PORT_OCCUPIED");
    return result;
  }
  return { lease, runId, runDirectory, unchanged, observe };
}

/** Safe status detail, never a mutation or a substitute for fresh recovery checks. */
export function staleLeaseDiagnostic(root: string, dependencies: Dependencies = {}) {
  try {
    const run = inspect(root, dependencies); run.observe(); run.unchanged();
    return { lease: "RECOVERABLE_PRE_BOOT_LEASE", reason: "PRE_BOOT_OWNER_ABSENT",
      hint: "Run .\\start-sqlite-demo.ps1 -Action recover-lease to archive this stale lease, then start normally." };
  } catch (error) {
    const failure = error instanceof LauncherRecoveryError ? error : new LauncherRecoveryError("RECEIPTS_INVALID");
    return { lease: "RETAINED_REVIEW_REQUIRED", reason: failure.reason, hint: failure.message };
  }
}

/** Explicit operator action only. Never opens a database, reads access.json,
 * starts/stops a service, rewrites a receipt or deletes a file. */
export function recoverStaleLease(root: string, dependencies: Dependencies = {}) {
  try {
    const run = inspect(root, dependencies);
    run.observe(); run.unchanged();
    const archivedLease = join(run.runDirectory, `launcher-lease-archived-${randomUUID()}.json`);
    if (existsSync(archivedLease)) throw new LauncherRecoveryError("ARCHIVE_FAILED");
    // Recheck OS observations immediately before the final file identity checks.
    // Normal start still refuses while this exact lease remains in place.
    run.observe(); run.unchanged();
    renameSync(run.lease.path, archivedLease);
    return { status: "STALE_LEASE_ARCHIVED", runId: run.runId, archivedLease,
      databaseChanged: false, processesStopped: 0, servicesStarted: 0 };
  } catch (error) {
    if (error instanceof LauncherRecoveryError) throw error;
    throw new LauncherRecoveryError("ARCHIVE_FAILED");
  }
}
