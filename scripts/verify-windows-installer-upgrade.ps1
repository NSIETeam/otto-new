# Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
# Actual candidate installer checks, never a workstation maintenance utility.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$InstallRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Refuse before creating files, inspecting registry, or executing any binary.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'GitHub-hosted Windows runner only; never run against a user installation'
}
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE) { throw 'Missing hosted runner paths' }
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$workspaceRoot = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE).TrimEnd('\')
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$Installer = [IO.Path]::GetFullPath($Installer)
# This hosted-runner harness does not claim NSIS command-line quoting coverage.
# NSIS /D and _? consume a final, unquoted path; reject ambiguous test roots.
if ($runnerRoot -match '\s') { throw 'Hosted fixture root must not contain whitespace' }
if ($InstallRoot -ine (Join-Path $runnerRoot 'otto-packaged-runtime')) { throw 'Unexpected isolated installation root' }
if (-not $Installer.StartsWith((Join-Path $workspaceRoot 'release-download') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installer must be the downloaded candidate in this workflow workspace'
}
if ([IO.Path]::GetFileName($Installer) -notmatch '^Otto-Setup-[0-9]+\.[0-9]+\.[0-9]+-win-x64\.exe$') {
  throw 'Unexpected candidate installer name'
}

function Assert-NoRedirect([string]$Path) {
  $cursor = $Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $entry = Get-Item -LiteralPath $cursor -Force
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected fixture path' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
Assert-NoRedirect $Installer
Assert-NoRedirect $InstallRoot
$electron = Join-Path $InstallRoot 'Otto.exe'
$uninstaller = Join-Path $InstallRoot 'Uninstall Otto.exe'
foreach ($required in @($Installer, $electron, $uninstaller)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required candidate file missing: $required" }
}
$installerHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
$uninstallerHash = (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant()
$runId = [Guid]::NewGuid().ToString('N')
$evidenceRoot = Join-Path $runnerRoot "otto-upgrade-acceptance-$runId"
if (Test-Path -LiteralPath $evidenceRoot) { throw 'Evidence directory already exists' }
[void][IO.Directory]::CreateDirectory($evidenceRoot)
$alternateRoot = Join-Path $evidenceRoot 'alternate-install'
[void][IO.Directory]::CreateDirectory($alternateRoot)
$sentinelBytes = [Text.Encoding]::UTF8.GetBytes("Otto isolated upgrade preservation probe $runId")
$sentinelName = ".otto-user-file-$runId.txt"
$oldSentinel = Join-Path $InstallRoot $sentinelName
$newSentinel = Join-Path $alternateRoot $sentinelName

function Write-Exclusive([string]$Path, [byte[]]$Bytes) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
$script:observationIndex = 0
$script:activeCase = 'fixture-setup'
function Save-Observation([string]$Kind, [object]$Observation) {
  $script:observationIndex++
  $fileName = '{0:D2}-{1}-{2}.json' -f $script:observationIndex, $script:activeCase, $Kind
  Write-Exclusive (Join-Path $evidenceRoot $fileName) ([Text.Encoding]::UTF8.GetBytes(($Observation | ConvertTo-Json -Depth 8)))
}
function Snapshot([string]$Root) {
  Assert-NoRedirect $Root
  $result = [ordered]@{}
  foreach ($entry in @(Get-ChildItem -LiteralPath $Root -Force -Recurse | Sort-Object FullName)) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected entry inside fixture' }
    $relative = $entry.FullName.Substring($Root.Length)
    $result[$relative] = if ($entry.PSIsContainer) { 'directory' } else {
      (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  return ($result | ConvertTo-Json -Compress -Depth 4)
}
function Assert-SnapshotUnchanged([string]$Root, [string]$Before) {
  $after = Snapshot $Root
  Save-Observation 'snapshot' ([ordered]@{ root=$Root; before=($Before | ConvertFrom-Json); after=($after | ConvertFrom-Json); unchanged=($after -ceq $Before) })
  if ($after -cne $Before) { throw "Installer changed protected fixture: $Root" }
}
function Invoke-Candidate([string]$Executable, [string[]]$Arguments) {
  Save-Observation 'starting' ([ordered]@{ executable=$Executable; arguments=$Arguments; atUtc=[DateTime]::UtcNow.ToString('o') })
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Executable
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
  $child = [Diagnostics.Process]::Start($start)
  if ($null -eq $child) { throw 'Candidate process did not start' }
  try {
    if (-not $child.WaitForExit(120000)) {
      # Unknown outcome: no kill, cleanup, replay or success claim.
      Save-Observation 'unknown' ([ordered]@{ processId=$child.Id; reason='120s deadline'; replayed=$false; killed=$false })
      throw 'Candidate process deadline exceeded; preserve the runner for evidence, do not replay'
    }
    Save-Observation 'exited' ([ordered]@{ processId=$child.Id; exitCode=$child.ExitCode })
    return $child.ExitCode
  } finally { $child.Dispose() }
}
$cases = [Collections.Generic.List[object]]::new()
function Record-Case([string]$Name, [int]$ExitCode, [int]$Expected) {
  $record = [ordered]@{ name=$Name; exitCode=$ExitCode; expectedExitCode=$Expected; passed=($ExitCode -eq $Expected) }
  $cases.Add($record)
  Write-Exclusive (Join-Path $evidenceRoot "$Name.json") ([Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json)))
  if ($ExitCode -ne $Expected) { throw "Candidate check $Name returned $ExitCode; expected $Expected" }
}

# Changing /D must not bypass preservation of the registered OLD directory.
try {
$script:activeCase = 'old-directory-protected'
Write-Exclusive $oldSentinel $sentinelBytes
$protectedOld = Snapshot $InstallRoot
$emptyNew = Snapshot $alternateRoot
Save-Observation 'before' ([ordered]@{ old=($protectedOld | ConvertFrom-Json); selectedNew=($emptyNew | ConvertFrom-Json) })
$code = Invoke-Candidate $Installer @('/S', "/D=$alternateRoot")
Assert-SnapshotUnchanged $InstallRoot $protectedOld
Assert-SnapshotUnchanged $alternateRoot $emptyNew
Record-Case 'old-directory-protected' $code 73

# The NEW uninstaller must refuse before its recursive application cleanup.
$script:activeCase = 'uninstaller-protected'
$code = Invoke-Candidate $uninstaller @('/S', "_?=$InstallRoot")
Assert-SnapshotUnchanged $InstallRoot $protectedOld
Record-Case 'uninstaller-protected' $code 73

# Remove only this invocation's exact sentinel after checking its bytes and path.
if ([IO.Path]::GetDirectoryName($oldSentinel) -ine $InstallRoot -or
    [Convert]::ToBase64String([IO.File]::ReadAllBytes($oldSentinel)) -cne [Convert]::ToBase64String($sentinelBytes)) {
  throw 'Owned sentinel identity mismatch; no cleanup permitted'
}
Remove-Item -LiteralPath $oldSentinel
Write-Exclusive $newSentinel $sentinelBytes
$script:activeCase = 'new-directory-protected'
$cleanOld = Snapshot $InstallRoot
$protectedNew = Snapshot $alternateRoot
Save-Observation 'before' ([ordered]@{ old=($cleanOld | ConvertFrom-Json); selectedNew=($protectedNew | ConvertFrom-Json) })
$code = Invoke-Candidate $Installer @('/S', "/D=$alternateRoot")
Assert-SnapshotUnchanged $InstallRoot $cleanOld
Assert-SnapshotUnchanged $alternateRoot $protectedNew
Record-Case 'new-directory-protected' $code 73

# Exercise the real candidate's old-uninstaller + extraction path, not a mock.
$script:activeCase = 'clean-in-place-upgrade'
$code = Invoke-Candidate $Installer @('/S', "/D=$InstallRoot")
Record-Case 'clean-in-place-upgrade' $code 0
if (-not (Test-Path -LiteralPath $electron -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $InstallRoot 'resources\app.asar') -PathType Leaf) -or
    -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
  throw 'Clean upgrade removed the installed application'
}
if ((Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash.ToLowerInvariant() -cne $uninstallerHash) {
  throw 'Clean upgrade did not preserve the candidate uninstaller for the next upgrade'
}
if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $installerHash) {
  throw 'Candidate installer changed during verification'
}
$receipt = [ordered]@{
  schemaVersion=1; runId=$runId; source=$env:GITHUB_SHA; workflowRun=$env:GITHUB_RUN_ID;
  installerSha256=$installerHash; uninstallerSha256=$uninstallerHash; cases=$cases.ToArray(); passed=$true;
  scope='Actual candidate in-place upgrade and preservation; not all historical clients or signed-device policies'
}
Write-Exclusive (Join-Path $evidenceRoot 'receipt.json') ([Text.Encoding]::UTF8.GetBytes(($receipt | ConvertTo-Json -Depth 6)))
Write-Host "Windows candidate upgrade verification passed; evidence=$evidenceRoot"
} catch {
  Save-Observation 'failure' ([ordered]@{ reason=$_.Exception.Message; passed=$false; cleanupReplayed=$false })
  throw
}
