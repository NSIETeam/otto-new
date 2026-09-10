/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { mkdtempSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/seed-windows-legacy-install.ps1');
const source = () => readFileSync(script, 'utf8');

describe('hosted-only fixed historical Windows installer seed', () => {
  it('pins the original asset and fails closed before running downloaded bytes', () => {
    const text = source();
    for (const required of [
      'https://github.com/Felix201209/otto-releases/releases/download/v1.9.14/Otto-Setup-1.9.14-win-x64.exe',
      '124070431',
      '9f6223960468fb568f18f5806f6f5045ded74303d1c0752f0360af1c05ba1e3b',
      'AllowAutoRedirect = $false',
      "'release-assets.githubusercontent.com'",
      'CancelAfter(120000)',
      '$received -gt $expectedBytes',
      'WaitForExit(120000)',
      'UseShellExecute = $false',
      'CreateNoWindow = $true',
      "Add('/S')",
      "Add('/currentuser')",
      'no kill or replay',
      'FileMode]::CreateNew',
      'seed-receipt.json',
      'seed-unknown.json',
    ])
      expect(text).toContain(required);
    expect(text.indexOf('GitHub-hosted Windows runner only')).toBeLessThan(
      text.indexOf('[IO.Directory]::CreateDirectory'),
    );
    expect(
      text.indexOf('Legacy installer byte identity mismatch'),
    ).toBeLessThan(text.indexOf('[Diagnostics.Process]::Start'));
    expect(text).not.toMatch(
      /Stop-Process|\.Kill\(|Start-Sleep|Remove-Item|-SkipCertificateCheck|ServerCertificateCustomValidationCallback/,
    );
    expect(Buffer.byteLength(text)).toBeLessThan(16000);
  });

  it('refuses existing registrations, processes, roots and redirected paths', () => {
    for (const required of [
      'Assert-NoRedirect',
      'RegistryView]::Registry32',
      'RegistryView]::Registry64',
      'RegistryHive]::CurrentUser',
      'RegistryHive]::LocalMachine',
      'bc38908e-1ce2-5555-aca4-b7da2295894c',
      'Existing Otto registration',
      'Existing Otto process',
      'Installation root must be absent',
      'DisplayVersion',
      'InstallLocation',
      'UninstallString',
      'legacy installer may internally retry',
    ])
      expect(source()).toContain(required);
  });

  it('runs the seed before the unchanged candidate checks and preserves separate evidence', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const seed = workflow.indexOf('scripts/seed-windows-legacy-install.ps1');
    const install = workflow.indexOf(
      '- name: Install and load the packaged SQLCipher binding',
    );
    expect(seed).toBeGreaterThan(0);
    expect(seed).toBeLessThan(install);
    expect(workflow).toContain(
      'windows-legacy-seed-${{ needs.build.outputs.version }}',
    );
    expect(workflow).toContain('${{ runner.temp }}/otto-legacy-seed-*/*.json');
    expect(workflow).toMatch(
      /name: Preserve historical Windows seed evidence\s+if: always\(\)/,
    );
    expect(workflow).toContain('scripts/verify-windows-installer-upgrade.ps1');
    expect(workflow).toContain(
      'windows-upgrade-acceptance-${{ needs.build.outputs.version }}',
    );
    const windowsJob = workflow
      .split('  verify-windows-signature:')[1]
      .split('\n  prepare-release-creation-intent:')[0];
    expect(windowsJob).toContain('timeout-minutes: 20');
  });

  it.runIf(process.platform === 'win32')(
    'is valid PowerShell without invoking its statements',
    () => {
      const command = `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors); if($errors.Count -gt 0){exit 1}`;
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', timeout: 15000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    },
  );

  it.runIf(process.platform === 'win32').each([
    {
      GITHUB_ACTIONS: 'false',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Windows',
    },
    {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'self-hosted',
      RUNNER_OS: 'Windows',
    },
    {
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Linux',
    },
  ])('refuses an ineligible environment before IO: %j', (overrides) => {
    // Deliberately never provide a fully eligible hosted identity on this machine.
    const fixture = mkdtempSync(path.join(tmpdir(), 'otto-legacy-admission-'));
    try {
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', script],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, ...overrides, RUNNER_TEMP: fixture },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'GitHub-hosted Windows runner only',
      );
      expect(readdirSync(fixture)).toEqual([]);
    } finally {
      rmdirSync(fixture);
    }
  });
});
