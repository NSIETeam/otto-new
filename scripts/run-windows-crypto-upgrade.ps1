# Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('seed','verify')][string]$Phase, [string]$Version)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'GitHub-hosted Windows runner only; never run against a user installation'
}
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE) { throw 'Missing runner roots' }
if ($Phase -eq 'verify' -and $Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Missing candidate version' }
$executable = Join-Path $env:GITHUB_WORKSPACE 'node_modules\electron\dist\electron.exe'
$probe = Join-Path $env:GITHUB_WORKSPACE 'scripts\probe-windows-crypto-upgrade.cjs'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $executable
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
[void]$start.Environment.Remove('ELECTRON_RUN_AS_NODE')
[void]$start.ArgumentList.Add($probe)
[void]$start.ArgumentList.Add($Phase)
if ($Version) { [void]$start.ArgumentList.Add($Version) }
$child = [Diagnostics.Process]::Start($start)
if ($null -eq $child) { throw 'Probe did not start' }
try {
  if (-not $child.WaitForExit(120000)) { throw 'Encrypted upgrade probe timed out; no kill or replay' }
  if ($child.ExitCode -ne 0) { throw "Encrypted upgrade probe failed: $($child.ExitCode)" }
} finally { $child.Dispose() }
$receipt = Join-Path $env:RUNNER_TEMP ('otto-crypto-upgrade-fixture\' + $(if ($Phase -eq 'seed') { 'seed.json' } else { 'verified.json' }))
if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) { throw 'Probe exited without acceptance evidence' }
Write-Host "Encrypted upgrade phase passed: $Phase"
