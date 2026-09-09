/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/verify-windows-installer-upgrade.ps1');

describe('actual packaged Windows upgrade admission', () => {
  it('requires candidate upgrade checks before publication intent and native probes', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const install = workflow.indexOf('Silent installer failed:');
    const upgrade = workflow.indexOf(
      'scripts/verify-windows-installer-upgrade.ps1',
      install,
    );
    const probe = workflow.indexOf('$sqlCipherProbeArguments =', install);
    expect(upgrade).toBeGreaterThan(install);
    expect(probe).toBeGreaterThan(upgrade);
    expect(workflow).toContain(
      "'-Installer', $installer.FullName, '-InstallRoot', $installRoot",
    );
    expect(workflow).toContain('$upgradeProbeExitCode = Invoke-NativeProcess');
    expect(workflow).toContain('      - verify-windows-signature');
  });

  it('retains refusal evidence, owned sentinels and a successful clean in-place upgrade', () => {
    expect(existsSync(script)).toBe(true);
    const source = readFileSync(script, 'utf8');
    for (const literal of [
      'github-hosted',
      'GITHUB_ACTIONS',
      'RUNNER_OS',
      'old-directory-protected',
      'new-directory-protected',
      'uninstaller-protected',
      'clean-in-place-upgrade',
      'Assert-SnapshotUnchanged',
      'UseShellExecute = $false',
      'WaitForExit(120000)',
      'FileMode]::CreateNew',
      'uninstallerSha256=$uninstallerHash',
      "Save-Observation 'failure'",
      "Save-Observation 'unknown'",
      'Hosted fixture root must not contain whitespace',
    ])
      expect(source).toContain(literal);
    expect(source).not.toMatch(/Remove-Item[^\r\n]*-Recurse/);
    expect(source).not.toMatch(/Stop-Process|\.Kill\(/);
    expect(source).not.toContain('Get-ChildItem HK');
  });

  it.runIf(process.platform === 'win32')(
    'refuses a local workstation before creating any fixture or starting an installer',
    () => {
      const sandbox = mkdtempSync(
        path.join(tmpdir(), 'otto-installer-admission-'),
      );
      try {
        const result = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            script,
            '-Installer',
            path.join(sandbox, 'missing.exe'),
            '-InstallRoot',
            path.join(sandbox, 'installed'),
          ],
          {
            encoding: 'utf8',
            timeout: 15000,
            env: {
              ...process.env,
              GITHUB_ACTIONS: 'false',
              RUNNER_ENVIRONMENT: '',
              RUNNER_TEMP: sandbox,
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          'GitHub-hosted Windows runner only',
        );
        expect(readdirSync(sandbox)).toEqual([]);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
    20000,
  );
});
