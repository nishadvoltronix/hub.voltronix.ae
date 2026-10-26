$ErrorActionPreference = 'Stop'
# Parse documentation examples; never invoke a snippet or contact a host.
$applicationDirectory = Split-Path -Parent $PSScriptRoot
$workspaceDirectory = $applicationDirectory
$documents = @('staging-verification-runbook.md', 'staging-gate-checklist.md', 'staging-host-commands.md', 'staging-http-probe.md')
$snippetCount = 0
$linuxSnippetCount = 0
foreach ($document in $documents) {
    $path = Join-Path (Join-Path $workspaceDirectory 'docs') $document
    $source = [System.IO.File]::ReadAllText($path)
    $matches = [regex]::Matches($source, '(?ms)^```powershell\r?\n(.*?)^```')
    foreach ($match in $matches) {
        $tokens = $null
        $parseErrors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput($match.Groups[1].Value, [ref] $tokens, [ref] $parseErrors)
        if ($parseErrors.Count -ne 0) { throw "PowerShell syntax check failed in $document. No snippet was executed." }
        $snippetCount++
    }
    $linuxSnippetCount += [regex]::Matches($source, '(?m)^```bash\s*$').Count
}
if ($snippetCount -eq 0) { throw 'No PowerShell verification recipes were found.' }
$checklist = [System.IO.File]::ReadAllText((Join-Path (Join-Path $workspaceDirectory 'docs') 'staging-gate-checklist.md'))
$gates = [regex]::Matches($checklist, '(?m)^\| (?<id>[LAH]-\d{2}) (?<kind>LOCAL|APPROVAL|HOST) \| .+ \| (?<status>PASS|FAIL|NOT RUN|BLOCKED) \|\r?$')
$uniqueIds = @($gates | ForEach-Object { $_.Groups['id'].Value } | Select-Object -Unique)
if ($gates.Count -eq 0 -or $uniqueIds.Count -ne $gates.Count) { throw 'Gate identifiers must be present and unique.' }
$localCount = @($gates | Where-Object { $_.Groups['kind'].Value -eq 'LOCAL' }).Count
$approvalCount = @($gates | Where-Object { $_.Groups['kind'].Value -eq 'APPROVAL' }).Count
$hostCount = @($gates | Where-Object { $_.Groups['kind'].Value -eq 'HOST' }).Count
[pscustomobject]@{
    Status = 'PASS'
    PowerShellSnippetsParsed = $snippetCount
    LinuxSnippetsListedOnly = $linuxSnippetCount
    SnippetsExecuted = 0
    ChecklistGates = $gates.Count
    LocalGates = $localCount
    ApprovalGates = $approvalCount
    HostGates = $hostCount
    TargetHostVerified = $false
} | ConvertTo-Json
