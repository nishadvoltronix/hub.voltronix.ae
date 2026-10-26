import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { listenerOwnershipScript } from "./listener-ownership.js";

const executable = "C:\\Synthetic\\node.exe";
function fixture() {
  return { supervisorPid: 100, apiPid: 101, frontendPid: 102, executable,
    listeners: [
      { LocalAddress: "127.0.0.1", LocalPort: 3001, OwningProcess: 102 },
      { LocalAddress: "127.0.0.1", LocalPort: 3002, OwningProcess: 101 },
    ],
    processes: [
      { ProcessId: 100, ParentProcessId: 99, ExecutablePath: executable },
      { ProcessId: 101, ParentProcessId: 100, ExecutablePath: executable },
      { ProcessId: 102, ParentProcessId: 100, ExecutablePath: executable },
    ] };
}

// Execute the exact production probe while replacing only its two read-only OS
// queries. No live listeners/processes, receipts, credentials or DB are read.
const observations = `
$ProgressPreference = 'SilentlyContinue'
function Get-NetTCPConnection {
  param($State, $LocalPort, $ErrorAction)
  if ($State -ne 'Listen' -or ($LocalPort -join ',') -ne '3001,3002') { throw 'Unexpected query' }
  return $script:expected.listeners
}
function Get-CimInstance {
  param($ClassName, $Filter)
  if ($ClassName -ne 'Win32_Process' -or $Filter -notmatch '^ProcessId = ([0-9]+)$') { throw 'Unexpected query' }
  $selected = [int]$Matches[1]
  if ($selected -notin @($script:expected.supervisorPid, $script:expected.apiPid, $script:expected.frontendPid)) { throw 'Unrelated process' }
  return @($script:expected.processes | Where-Object { $_.ProcessId -eq $selected })
}
`;
function probe(value: ReturnType<typeof fixture>): number | null {
  const run = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(observations + listenerOwnershipScript, "utf16le").toString("base64")],
  { input: JSON.stringify(value), encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(run.error, undefined);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
  return run.status;
}

test("Owned exact IPv4 listeners pass even with unrelated IPv6 or other-address listeners", { skip: process.platform !== "win32" }, () => {
  assert.equal(probe(fixture()), 0);
  const value = fixture();
  value.listeners.push({ LocalAddress: "::", LocalPort: 3001, OwningProcess: 999 },
    { LocalAddress: "::1", LocalPort: 3002, OwningProcess: 998 },
    { LocalAddress: "192.0.2.1", LocalPort: 3001, OwningProcess: 997 });
  assert.equal(probe(value), 0);
});
test("Missing wrong-address duplicate or wrong-PID owned IPv4 listener refuses ownership", { skip: process.platform !== "win32" }, () => {
  const absent = fixture(); absent.listeners.pop(); assert.equal(probe(absent), 1);
  const wrongAddress = fixture(); wrongAddress.listeners[0]!.LocalAddress = "::"; assert.equal(probe(wrongAddress), 1);
  const duplicate = fixture(); duplicate.listeners.push({ ...duplicate.listeners[0]! }); assert.equal(probe(duplicate), 1);
  const wrongPid = fixture(); wrongPid.listeners[0]!.OwningProcess = 999; assert.equal(probe(wrongPid), 1);
});
test("Owned child and supervisor parent/executable identity checks remain mandatory", { skip: process.platform !== "win32" }, () => {
  const missingSupervisor = fixture(); missingSupervisor.processes.shift(); assert.equal(probe(missingSupervisor), 1);
  const missingChild = fixture(); missingChild.processes.pop(); assert.equal(probe(missingChild), 1);
  const wrongParent = fixture(); wrongParent.processes[2]!.ParentProcessId = 999; assert.equal(probe(wrongParent), 1);
  const wrongChildExecutable = fixture(); wrongChildExecutable.processes[1]!.ExecutablePath = "C:\\Other\\node.exe";
  assert.equal(probe(wrongChildExecutable), 1);
  const wrongSupervisorExecutable = fixture(); wrongSupervisorExecutable.processes[0]!.ExecutablePath = "C:\\Other\\node.exe";
  assert.equal(probe(wrongSupervisorExecutable), 1);
});
