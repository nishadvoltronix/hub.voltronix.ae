param(
    [ValidateSet('start','stop','status','init','verify','verify-anonymous','restart-check','backup','recover-lease')][string]$Action = 'start',
    [ValidateSet('fixture-writes-and-auth')][string]$MutationScope,
    [ValidateSet('preserve-existing','allow-expired-cleanup')][string]$SessionPolicy
)
$ErrorActionPreference = 'Stop'
$backendPath = Join-Path $PSScriptRoot 'server'
$commandExitCode = 0
Push-Location -LiteralPath $backendPath
try {
    $demoArguments = @($Action)
    if ($Action -eq 'verify') {
        if ($MutationScope) { $demoArguments += "--mutation-scope=$MutationScope" }
        if ($SessionPolicy) { $demoArguments += "--session-policy=$SessionPolicy" }
    } elseif ($MutationScope -or $SessionPolicy) {
        throw 'Verification scope parameters apply only to the verify action.'
    }
    & node --import tsx demo-sqlite/control.ts @demoArguments
    $commandExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($commandExitCode -ne 0) {
    throw 'The requested SQLite demo action failed. No automatic reset, reseed or unrelated process cleanup was attempted.'
}
