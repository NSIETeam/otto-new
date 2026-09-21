/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import probeHelpers from '../probe-windows-crypto-upgrade.cjs';
const { admittedPaths } = probeHelpers;

const probe = fileURLToPath(
  new URL('../probe-windows-crypto-upgrade.cjs', import.meta.url),
);
const rejectedEnvironment = { ...process.env, GITHUB_ACTIONS: 'false' };
delete rejectedEnvironment.ELECTRON_RUN_AS_NODE;
const electronExecutable =
  process.env.OTTO_TEST_ELECTRON_EXECUTABLE ||
  path.resolve('node_modules/electron/dist/electron.exe');

function importProbe(entry, electron = true) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    ${electron ? "Object.defineProperty(process.versions, 'electron', { value: '43.2.0' });" : ''}
    process.argv = [process.execPath, ${JSON.stringify(entry)}, 'seed'];
    await import(${JSON.stringify(pathToFileURL(probe).href)});
  `,
    ],
    {
      env: rejectedEnvironment,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    },
  );
}

describe('encrypted data acceptance is a publication gate', () => {
  it('reproduces the locked failed candidate without production credentials or publication', () => {
    const workflow = readFileSync(
      '.github/workflows/crypto-upgrade-repro.yml',
      'utf8',
    );
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toMatch(
      /environment:|: write|secrets\.|pull_request_target|continue-on-error/,
    );
    expect(workflow).toContain('35545865735');
    expect(workflow).toContain('a412c4e39c2199734a7fe219f1834213faf1dbe1');
    expect(workflow).toContain(
      '3f28953d9e0c91fb71f912bb0cb6c5bf28c5efd0bd4a5ad82c0c86eadd9938cd',
    );
    expect(workflow).toContain('-Phase verify -Version 1.9.17');
    expect(workflow).not.toMatch(/gh release (create|edit)|systemctl|ssh /);
  });

  it('reports only fixed stage names, never assertion values or secret payloads', () => {
    const output = [];
    const reporter = probeHelpers.createStageReporter((line) =>
      output.push(line),
    );
    reporter.enter('device-identity');
    reporter.failed(new Error('private-key-and-history-content'));
    expect(output).toEqual([
      'OTTO_CRYPTO_STAGE device-identity\n',
      'OTTO_CRYPTO_FAILURE device-identity\n',
    ]);
    expect(() => reporter.enter('private-key-and-history-content')).toThrow(
      'Invalid probe stage',
    );
    expect(output.join('')).not.toContain('private-key-and-history-content');
  });

  it('captures GUI-host pipe output but prints only sanitized probe markers', () => {
    const wrapper = readFileSync(
      'scripts/run-windows-crypto-upgrade.ps1',
      'utf8',
    );
    expect(wrapper).toContain('$start.RedirectStandardError = $true');
    expect(wrapper).toContain('$start.RedirectStandardOutput = $true');
    expect(wrapper).toContain('StandardError.ReadToEndAsync()');
    expect(wrapper).toContain('^OTTO_CRYPTO_(STAGE|FAILURE) [a-z-]+$');
    expect(wrapper).not.toMatch(/Write-(Host|Output|Error)\s+\$stderr/);
  });

  it('runs admission when Electron dynamically imports the exact entry file', () => {
    const result = importProbe(probe);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub-hosted Windows runner only');
  });

  it('does not run a helper import or an ordinary Node dynamic import', () => {
    for (const result of [
      importProbe(path.join(path.dirname(probe), 'other.cjs')),
      importProbe(probe, false),
    ]) {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    }
  });

  it('retains direct CommonJS admission without loading Electron', () => {
    const result = spawnSync(process.execPath, [probe, 'seed'], {
      env: rejectedEnvironment,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub-hosted Windows runner only');
  });

  it.skipIf(
    process.platform !== 'win32' ||
      (!existsSync(electronExecutable) &&
        process.env.OTTO_REQUIRE_ELECTRON_PROBE_ENTRY !== '1'),
  )(
    'real Electron enters the probe and rejects non-hosted execution without hanging',
    () => {
      expect(existsSync(electronExecutable)).toBe(true);
      const result = spawnSync(electronExecutable, [probe, 'seed'], {
        env: rejectedEnvironment,
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      // A timeout must fail: a silent no-op is not a successful safety check.
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('GitHub-hosted Windows runner only');
    },
    20000,
  );

  it('refuses a workstation before loading Electron or touching files', () => {
    expect(() => admittedPaths({ GITHUB_ACTIONS: 'false' }, 'win32')).toThrow(
      /GitHub-hosted/,
    );
    expect(() =>
      admittedPaths(
        {
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
          RUNNER_OS: 'Windows',
        },
        'win32',
      ),
    ).toThrow(/identity/);
    expect(createRequire(import.meta.url).cache).not.toHaveProperty('electron');
  });
  it('seeds encrypted data with the installed historical app before upgrading and verifies with the candidate', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const seed = workflow.indexOf(
      'scripts/run-windows-crypto-upgrade.ps1 -Phase seed',
    );
    const install = workflow.indexOf(
      '- name: Install and load the packaged SQLCipher binding',
    );
    const verify = workflow.indexOf(
      'scripts/run-windows-crypto-upgrade.ps1 -Phase verify',
    );
    expect(seed).toBeGreaterThan(0);
    expect(seed).toBeLessThan(install);
    expect(verify).toBeGreaterThan(install);
    expect(workflow).toContain(
      'windows-crypto-upgrade-${{ needs.build.outputs.version }}',
    );
  });
});
