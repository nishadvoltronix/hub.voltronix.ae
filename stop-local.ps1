# Stop only the Next.js + Express children identified by their owned demo lease.
# Databases, accounts, sessions, files and retained evidence are never reset.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'start-sqlite-demo.ps1') -Action stop
