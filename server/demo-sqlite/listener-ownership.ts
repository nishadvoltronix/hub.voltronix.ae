/** Read-only Windows ownership probe used by the guarded launcher. Only the
 * exact loopback endpoints belong to this demo; unrelated bind addresses are
 * neither adopted nor inspected as children of its supervisor. */
export const listenerOwnershipScript = `
$ErrorActionPreference = 'Stop'
try {
  $expected = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $supervisor = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$expected.supervisorPid)
  if (!$supervisor -or $supervisor.ExecutablePath -ne $expected.executable) { exit 1 }
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3001,3002 -ErrorAction Stop |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' })
  if ($listeners.Count -ne 2) { exit 1 }
  foreach ($service in @(@{port=3001; owner=[int]$expected.frontendPid}, @{port=3002; owner=[int]$expected.apiPid})) {
    $listener = @($listeners | Where-Object { $_.LocalPort -eq $service.port })
    $owned = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $service.owner)
    if ($listener.Count -ne 1 -or $listener[0].LocalAddress -ne '127.0.0.1' -or $listener[0].OwningProcess -ne $service.owner -or
      !$owned -or $owned.ParentProcessId -ne $expected.supervisorPid -or $owned.ExecutablePath -ne $expected.executable) { exit 1 }
  }
  exit 0
} catch { exit 1 }
`;
