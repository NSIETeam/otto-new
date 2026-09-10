# Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
# A fixed historical seed for one disposable hosted runner, never workstation repair.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'GitHub-hosted Windows runner only; never run against a user installation'
}
if (-not $env:RUNNER_TEMP -or $env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]*$' -or
    $env:GITHUB_RUN_ATTEMPT -ne '1' -or $env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') {
  throw 'Missing immutable hosted run identity or first-attempt requirement'
}
$runnerRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
if ($runnerRoot -match '\s' -or -not [IO.Directory]::Exists($runnerRoot) -or
    $runnerRoot -eq [IO.Path]::GetPathRoot($runnerRoot).TrimEnd('\')) { throw 'Unsafe hosted fixture parent' }
$installRoot = Join-Path $runnerRoot 'otto-packaged-runtime'
$evidenceRoot = Join-Path $runnerRoot ('otto-legacy-seed-' + [Guid]::NewGuid().ToString('N'))
$legacyUrl = 'https://github.com/Felix201209/otto-releases/releases/download/v1.9.14/Otto-Setup-1.9.14-win-x64.exe'
$expectedBytes = 124070431L
$expectedSha = '9f6223960468fb568f18f5806f6f5045ded74303d1c0752f0360af1c05ba1e3b'
# Verified in the fixed EXE's NSIS header and its 5b91afc2 source (builder 26.15.3).
$guid = 'bc38908e-1ce2-5555-aca4-b7da2295894c'
$installKey = "Software\$guid"
$uninstallKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid"

function Assert-NoRedirect([string]$Path) {
  $cursor = $Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected hosted fixture path' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function Save-Seed([string]$Name, [object]$Data) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Data | ConvertTo-Json -Depth 8))
  $stream = [IO.File]::Open((Join-Path $evidenceRoot $Name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Assert-NoOttoProcess {
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='Otto.exe' OR Name='otto-native.exe'")
  if ($processes.Count -ne 0) { throw 'Existing Otto process; stop without terminating it' }
}
Assert-NoRedirect $installRoot
Assert-NoRedirect $evidenceRoot
if (Test-Path -LiteralPath $evidenceRoot) { throw 'Evidence directory must be new' }
[void][IO.Directory]::CreateDirectory($evidenceRoot)
$phase = 'admission'
try {
  Save-Seed 'seed-start.json' ([ordered]@{ source=$env:GITHUB_SHA; workflowRun=$env:GITHUB_RUN_ID; attempt=1; installRoot=$installRoot; atUtc=[DateTime]::UtcNow.ToString('o') })
  if (Test-Path -LiteralPath $installRoot) { throw 'Installation root must be absent, not merely empty' }
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      try {
        foreach ($keyName in @($installKey, $uninstallKey, 'Software\Classes\otto', 'Software\Classes\Applications\Otto.exe')) {
          $key = $base.OpenSubKey($keyName, $false)
          if ($null -ne $key) { $key.Dispose(); throw 'Existing Otto registration; fixture is not clean' }
        }
      } finally { $base.Dispose() }
    }
  }
  foreach ($folder in @('DesktopDirectory', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms')) {
    $location = [Environment]::GetFolderPath([Environment+SpecialFolder]$folder)
    if ($location -and (Test-Path -LiteralPath (Join-Path $location 'Otto.lnk'))) { throw 'Existing Otto shortcut; fixture is not clean' }
  }
  Assert-NoOttoProcess
  $phase = 'download'
  $installer = Join-Path $evidenceRoot 'Otto-Setup-1.9.14-win-x64.exe'
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  # Normal OS TLS/certificate validation; redirects stay on fixed official HTTPS hosts.
  $client = [Net.Http.HttpClient]::new($handler)
  $cancellation = [Threading.CancellationTokenSource]::new()
  $cancellation.CancelAfter(120000)
  $uri = [Uri]$legacyUrl
  $response = $null
  try {
    for ($redirect = 0; $redirect -le 3; $redirect++) {
      if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or -not $uri.IsDefaultPort -or
          $uri.Host -notin @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) { throw 'Unapproved redirect' }
      $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $uri)
      try { $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult() }
      finally { $request.Dispose() }
      $status = [int]$response.StatusCode
      if ($status -in @(301,302,303,307,308)) {
        if ($redirect -eq 3 -or $null -eq $response.Headers.Location) { throw 'Redirect limit' }
        $uri = [Uri]::new($uri, $response.Headers.Location)
        $response.Dispose(); $response = $null
        continue
      }
      if ($status -ne 200) { throw 'HTTP download rejected' }
      break
    }
    if ($null -eq $response -or ($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne $expectedBytes)) { throw 'Unexpected download length' }
    $inputStream = $response.Content.ReadAsStreamAsync($cancellation.Token).GetAwaiter().GetResult()
    $outputStream = [IO.File]::Open($installer, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $received = 0L
    try {
      $buffer = [byte[]]::new(65536)
      while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
        $received += $count
        if ($received -gt $expectedBytes) { throw 'Download exceeds fixed byte limit' }
        $outputStream.Write($buffer, 0, $count)
      }
      $outputStream.Flush($true)
    } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    if ($received -ne $expectedBytes -or (Get-Item -LiteralPath $installer).Length -ne $expectedBytes -or
        (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedSha) { throw 'Legacy installer byte identity mismatch' }
  } catch {
    # Do not print redirect URLs or signed CDN queries from network exception text.
    throw 'Pinned legacy installer download or byte verification failed; nothing was installed'
  } finally {
    if ($null -ne $response) { $response.Dispose() }
    $cancellation.Dispose(); $client.Dispose(); $handler.Dispose()
  }
  Save-Seed 'legacy-download.json' ([ordered]@{ url=$legacyUrl; bytes=$expectedBytes; sha256=$expectedSha; verified=$true })
  Assert-NoRedirect $installer
  Assert-NoRedirect $installRoot
  if (Test-Path -LiteralPath $installRoot) { throw 'Installation root must be absent immediately before execution' }
  Assert-NoOttoProcess
  $phase = 'legacy-install'
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $installer
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  [void]$start.ArgumentList.Add('/S')
  [void]$start.ArgumentList.Add('/currentuser')
  [void]$start.ArgumentList.Add("/D=$installRoot") # NSIS requires /D last, without path quotes.
  Save-Seed 'legacy-process-starting.json' ([ordered]@{ executableSha256=$expectedSha; arguments=@('/S','/currentuser',"/D=$installRoot"); atUtc=[DateTime]::UtcNow.ToString('o') })
  $child = [Diagnostics.Process]::Start($start)
  if ($null -eq $child) { throw 'Historical installer did not start' }
  try {
    if (-not $child.WaitForExit(120000)) {
      Save-Seed 'seed-unknown.json' ([ordered]@{ processId=$child.Id; deadlineSeconds=120; killed=$false; replayed=$false; passed=$false })
      throw 'Historical installation outcome unknown; no kill or replay'
    }
    Save-Seed 'legacy-process-exited.json' ([ordered]@{ processId=$child.Id; exitCode=$child.ExitCode; atUtc=[DateTime]::UtcNow.ToString('o') })
    if ($child.ExitCode -ne 0) { throw 'Historical silent installation failed; no retry' }
  } finally { $child.Dispose() }
  $phase = 'verify-legacy-seed'
  Assert-NoOttoProcess
  $fileHashes = [ordered]@{}
  foreach ($relative in @('Otto.exe', 'Uninstall Otto.exe', 'resources\app.asar')) {
    $file = Join-Path $installRoot $relative
    Assert-NoRedirect $file
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Historical installed file is missing' }
    $fileHashes[$relative] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $installRoot 'Otto.exe')).ProductVersion
  if ($version -notin @('1.9.14','1.9.14.0')) { throw 'Historical executable version mismatch' }
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  $installed = $null; $uninstall = $null
  try {
    $installed = $base.OpenSubKey($installKey, $false); $uninstall = $base.OpenSubKey($uninstallKey, $false)
    if ($null -eq $installed -or $null -eq $uninstall) { throw 'Historical installation registration missing' }
    $registeredRoot = [string]$installed.GetValue('InstallLocation')
    $command = [string]$uninstall.GetValue('UninstallString')
    if (-not $registeredRoot -or [IO.Path]::GetFullPath($registeredRoot).TrimEnd('\') -ine $installRoot -or
        $uninstall.GetValue('DisplayVersion') -ne '1.9.14' -or
        $command -notin @(('"' + (Join-Path $installRoot 'Uninstall Otto.exe') + '" /currentuser'), ('"' + (Join-Path $installRoot 'Uninstall Otto.exe') + '"'))) { throw 'Historical registration is not bound to the isolated root' }
  } finally {
    if ($null -ne $installed) { $installed.Dispose() }
    if ($null -ne $uninstall) { $uninstall.Dispose() }
    $base.Dispose()
  }
  Save-Seed 'seed-receipt.json' ([ordered]@{ schemaVersion=1; source=$env:GITHUB_SHA; workflowRun=$env:GITHUB_RUN_ID; attempt=1;
    version='1.9.14'; installRoot=$installRoot; installerSha256=$expectedSha; installerBytes=$expectedBytes; installedFiles=$fileHashes;
    registeredRoot=$registeredRoot; displayVersion='1.9.14'; noOttoProcessObserved=$true; passed=$true;
    scope='Historical seed only. The following candidate install and existing four safety cases must also pass. No data migration, every-old-client or signed-device guarantee.';
    boundaries=@('The legacy installer may internally retry or terminate processes; this harness does neither.', 'Registration, protocol and shortcuts are expected writes on this disposable hosted runner, not confinement to the installation directory.', 'No force-run flag is supplied. Process observations are not a continuous GUI or network trace.') })
  Write-Host "Verified historical 1.9.14 seed; next step must upgrade this same root. Evidence=$evidenceRoot"
} catch {
  Save-Seed 'seed-failure.json' ([ordered]@{ phase=$phase; reason=$_.Exception.Message; passed=$false; harnessKilled=$false; harnessReplayed=$false })
  throw
}
