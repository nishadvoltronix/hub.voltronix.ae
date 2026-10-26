# Start the preserved Next.js + Express SQLite demo, never the historical PHP server.
# Run from any directory: powershell -ExecutionPolicy Bypass -File <workspace>\start-local.ps1
param([switch]$Restart)

$ErrorActionPreference = 'Stop'
$launcherPath = Join-Path $PSScriptRoot 'start-sqlite-demo.ps1'
if ($Restart) {
    & $launcherPath -Action stop
}
& $launcherPath -Action start
