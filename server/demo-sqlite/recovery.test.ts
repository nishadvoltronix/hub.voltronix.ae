import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { LauncherRecoveryError, recoverStaleLease, recoveryObservationScript, staleLeaseDiagnostic, type RecoveryObservation } from "./recovery.js";

const runId = "00000000-0000-4000-8000-000000000001";
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const emptyObservation = (): RecoveryObservation => ({ bootedAt: "2026-10-15T00:00:00.000Z", presentPids: [], occupiedPorts: [] });
const privacy = () => {};
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crm-lease-recovery-")));
  t.after(() => {
    assert.equal(dirname(resolve(root)), realpathSync(tmpdir()));
    assert.ok(basename(root).startsWith("crm-lease-recovery-"));
    rmSync(root, { recursive: true });
  });
  const directory = join(root, "runs", runId); mkdirSync(directory, { recursive: true });
  const lock = join(root, "launcher.lock");
  const lease = { runId, acquiredAt: "2026-10-14T00:00:00.000Z" };
  const supervisor = { runId, pid: 100 };
  const ready = { runId, status: "RUNNING", supervisorPid: 100, apiPid: 101, frontendPid: 102,
    frontend: "http://127.0.0.1:3001", api: "http://127.0.0.1:3002/api/v1", provider: "sqlite-demo", startedAt: "2026-10-14T00:00:10.000Z" };
  writeFileSync(lock, json(lease));
  writeFileSync(join(directory, "supervisor.json"), json(supervisor));
  writeFileSync(join(directory, "ready.json"), json(ready));
  // Deliberately invalid contents demonstrate that recovery never opens these files.
  for (const name of ["crm-demo.sqlite", "crm-demo.sqlite-wal", "crm-demo.sqlite-shm", "access.json"])
    writeFileSync(join(root, name), "synthetic-preserved-unreadable-content");
  return { root, directory, lock, lease, supervisor, ready };
}
function refusal(action: () => unknown, reason: string) {
  assert.throws(action, (error: unknown) => error instanceof LauncherRecoveryError && error.reason === reason
    && !error.message.includes("synthetic-private-marker"));
}

test("explicit recovery archives only the exact pre-boot stale lease and preserves every other file", t => {
  const f = fixture(t), before = readFileSync(f.lock), identity = lstatSync(f.lock);
  const names = ["crm-demo.sqlite", "crm-demo.sqlite-wal", "crm-demo.sqlite-shm", "access.json"];
  const protectedBytes = names.map(name => readFileSync(join(f.root, name)));
  const receipts = ["supervisor.json", "ready.json"].map(name => readFileSync(join(f.directory, name)));
  let queries = 0;
  const result = recoverStaleLease(f.root, { privacy, observe(pids) {
    queries++; assert.deepEqual(pids, [100, 101, 102]); return emptyObservation();
  } });
  assert.equal(queries, 2); assert.equal(result.status, "STALE_LEASE_ARCHIVED");
  assert.equal(result.databaseChanged, false); assert.equal(result.processesStopped, 0); assert.equal(result.servicesStarted, 0);
  assert.equal(dirname(result.archivedLease), f.directory);
  assert.match(basename(result.archivedLease), /^launcher-lease-archived-[a-f0-9-]{36}\.json$/);
  assert.equal(existsSync(f.lock), false); assert.deepEqual(readFileSync(result.archivedLease), before);
  assert.equal(lstatSync(result.archivedLease).ino, identity.ino);
  assert.deepEqual(names.map(name => readFileSync(join(f.root, name))), protectedBytes);
  assert.deepEqual(["supervisor.json", "ready.json"].map(name => readFileSync(join(f.directory, name))), receipts);
});

test("status diagnoses a recoverable lease without archiving or writing any file", t => {
  const f = fixture(t), before = readFileSync(f.lock), entries = readdirSync(f.directory);
  const result = staleLeaseDiagnostic(f.root, { privacy, observe: emptyObservation });
  assert.equal(result.lease, "RECOVERABLE_PRE_BOOT_LEASE");
  assert.match(result.hint, /recover-lease/); assert.deepEqual(readFileSync(f.lock), before);
  assert.deepEqual(readdirSync(f.directory), entries);
});

test("same-boot lease, still-present or reused PID, occupied port and uncertain observation refuse without moving", t => {
  const f = fixture(t), before = readFileSync(f.lock);
  const cases: [RecoveryObservation, string][] = [
    [{ ...emptyObservation(), bootedAt: "2026-10-13T00:00:00.000Z" }, "NOT_PRE_BOOT"],
    [{ ...emptyObservation(), bootedAt: f.ready.startedAt }, "NOT_PRE_BOOT"],
    [{ ...emptyObservation(), presentPids: [100] }, "PROCESS_PRESENT"],
    [{ ...emptyObservation(), presentPids: [101] }, "PROCESS_PRESENT"],
    [{ ...emptyObservation(), presentPids: [102] }, "PROCESS_PRESENT"],
    [{ ...emptyObservation(), occupiedPorts: [3001] }, "PORT_OCCUPIED"],
    [{ ...emptyObservation(), occupiedPorts: [3002] }, "PORT_OCCUPIED"],
    [{ ...emptyObservation(), bootedAt: "invalid" }, "OS_UNAVAILABLE"],
    [{ ...emptyObservation(), presentPids: [999] }, "OS_UNAVAILABLE"],
    [{ ...emptyObservation(), occupiedPorts: [3306] }, "OS_UNAVAILABLE"],
  ];
  for (const [observation, reason] of cases) {
    refusal(() => recoverStaleLease(f.root, { privacy, observe: () => observation }), reason);
    assert.deepEqual(readFileSync(f.lock), before);
  }
  refusal(() => recoverStaleLease(f.root, { privacy, observe() { throw new Error("synthetic-private-marker"); } }), "OS_UNAVAILABLE");
  assert.deepEqual(readdirSync(f.directory).sort(), ["ready.json", "supervisor.json"]);
});

test("second OS check catches a newly present process or occupied listener before archival", t => {
  const f = fixture(t);
  const cases: [RecoveryObservation, string][] = [
    [{ ...emptyObservation(), presentPids: [100] }, "PROCESS_PRESENT"],
    [{ ...emptyObservation(), occupiedPorts: [3002] }, "PORT_OCCUPIED"],
  ];
  for (const [observation, reason] of cases) {
    let calls = 0;
    refusal(() => recoverStaleLease(f.root, { privacy, observe: () => ++calls === 1 ? emptyObservation() : observation }), reason);
    assert.equal(existsSync(f.lock), true);
  }
});

test("invalid or mismatched receipts refuse before querying the OS", t => {
  const f = fixture(t); let calls = 0;
  const observe = () => { calls++; return emptyObservation(); };
  for (const patch of [{ runId: "00000000-0000-4000-8000-000000000002" }, { status: "STOPPED" }, { provider: "mysql" },
    { supervisorPid: 900 }, { frontendPid: 101 }, { apiPid: -1 }, { startedAt: "2026-10-13T00:00:00.000Z" },
    { frontend: "https://synthetic-private-marker.invalid" }]) {
    writeFileSync(join(f.directory, "ready.json"), json({ ...f.ready, ...patch }));
    refusal(() => recoverStaleLease(f.root, { privacy, observe }), "RECEIPTS_INVALID");
  }
  writeFileSync(join(f.directory, "ready.json"), '{"runId":"duplicate","runId":"duplicate"}');
  refusal(() => recoverStaleLease(f.root, { privacy, observe }), "RECEIPTS_INVALID");
  writeFileSync(f.lock, json({ ...f.lease, runId: "../synthetic-private-marker" }));
  refusal(() => recoverStaleLease(f.root, { privacy, observe }), "RECEIPTS_INVALID");
  assert.equal(calls, 0);
});

test("missing receipts and private-access refusals preserve the lease and disclose no private error", t => {
  const f = fixture(t), before = readFileSync(f.lock);
  renameSync(join(f.directory, "ready.json"), join(f.directory, "ready-retained.json"));
  refusal(() => recoverStaleLease(f.root, { privacy, observe: emptyObservation }), "PRIVATE_ACCESS");
  refusal(() => recoverStaleLease(f.root, { privacy() { throw new Error("synthetic-private-marker"); }, observe: emptyObservation }), "PRIVATE_ACCESS");
  assert.deepEqual(readFileSync(f.lock), before);
  const diagnostic = staleLeaseDiagnostic(f.root, { privacy, observe: emptyObservation });
  assert.equal(diagnostic.lease, "RETAINED_REVIEW_REQUIRED"); assert.equal(diagnostic.reason, "PRIVATE_ACCESS");
});

test("changed receipt or identical-content replacement of the lease refuses archival", t => {
  const f = fixture(t), original = readFileSync(f.lock);
  refusal(() => recoverStaleLease(f.root, { privacy, observe() {
    renameSync(f.lock, join(f.root, "replaced-lease.json")); writeFileSync(f.lock, original); return emptyObservation();
  } }), "LEASE_CHANGED");
  assert.deepEqual(readFileSync(f.lock), original);
  let calls = 0;
  refusal(() => recoverStaleLease(f.root, { privacy, observe() {
    if (++calls === 2) writeFileSync(join(f.directory, "ready.json"), json({ ...f.ready, frontendPid: 999 }));
    return emptyObservation();
  } }), "LEASE_CHANGED");
  assert.deepEqual(readFileSync(f.lock), original);
  assert.deepEqual(readdirSync(f.directory).sort(), ["ready.json", "supervisor.json"]);
});

test("hardlinked leases and aliased run directories are refused without moving original evidence", t => {
  const linked = fixture(t), original = readFileSync(linked.lock);
  linkSync(linked.lock, join(linked.root, "preserved-link.json"));
  refusal(() => recoverStaleLease(linked.root, { privacy, observe: emptyObservation }), "RECEIPTS_INVALID");
  assert.deepEqual(readFileSync(linked.lock), original);
  const alias = fixture(t), realDirectory = join(alias.root, "retained-run");
  renameSync(alias.directory, realDirectory);
  symlinkSync(realDirectory, alias.directory, process.platform === "win32" ? "junction" : "dir");
  refusal(() => recoverStaleLease(alias.root, { privacy, observe: emptyObservation }), "PRIVATE_ACCESS");
  assert.equal(existsSync(alias.lock), true);
  assert.deepEqual(readdirSync(realDirectory).sort(), ["ready.json", "supervisor.json"]);
});

test("privacy changes after initial observation refuse before archival", t => {
  const f = fixture(t), original = readFileSync(f.lock); let observed = false;
  refusal(() => recoverStaleLease(f.root, {
    privacy() { if (observed) throw new Error("synthetic-private-marker"); },
    observe() { observed = true; return emptyObservation(); },
  }), "PRIVATE_ACCESS");
  assert.deepEqual(readFileSync(f.lock), original);
});

// Run the production query script with its OS commands replaced. No real
// process, listener, startup, stop, credential or database operation occurs.
const fakeQueries = `
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if ($script:expected.failQuery) { throw 'synthetic-private-marker' }
  if ($ClassName -eq 'Win32_OperatingSystem') { return @{LastBootUpTime=[datetime]::Parse('2026-10-15T00:00:00Z').ToUniversalTime()} }
  if ($ClassName -ne 'Win32_Process' -or $Filter -notmatch '^ProcessId = ([0-9]+)$') { throw 'Unexpected query' }
  if ([int]$Matches[1] -in $script:expected.present) { return @{ProcessId=[int]$Matches[1]} }
  return @()
}
function Get-NetTCPConnection {
  param($State, $ErrorAction)
  if ($State -ne 'Listen') { throw 'Unexpected query' }
  return $script:expected.listeners
}
`;
test("Windows recovery observation includes IPv6 and unrelated-address port conflicts and refuses query failures", { skip: process.platform !== "win32" }, () => {
  const probe = (extra: Record<string, unknown>) => spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(fakeQueries + recoveryObservationScript, "utf16le").toString("base64")], {
    input: JSON.stringify({ pids: [100, 101, 102], present: [], listeners: [], ...extra }), encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  const free = probe({}); assert.equal(free.status, 0); assert.equal(free.stderr, "");
  assert.deepEqual(JSON.parse(free.stdout), emptyObservation());
  const occupied = probe({ present: [102], listeners: [{ LocalAddress: "::", LocalPort: 3001 }, { LocalAddress: "192.0.2.1", LocalPort: 3002 }, { LocalPort: 3306 }] });
  assert.equal(occupied.status, 0);
  assert.deepEqual(JSON.parse(occupied.stdout), { ...emptyObservation(), presentPids: [102], occupiedPorts: [3001, 3002] });
  const failed = probe({ failQuery: true }); assert.equal(failed.status, 2); assert.equal(failed.stdout, ""); assert.equal(failed.stderr, "");
});
