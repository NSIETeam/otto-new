/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createPackage } from '@electron/asar';
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
  it.skipIf(
    process.platform !== 'win32' ||
      (!existsSync(electronExecutable) &&
        process.env.OTTO_REQUIRE_ELECTRON_PROBE_ENTRY !== '1'),
  )(
    'hashes actual archive bytes under Electron without disabling ASAR module access',
    async () => {
      expect(existsSync(electronExecutable)).toBe(true);
      const root = mkdtempSync(
        path.join(tmpdir(), 'otto-crypto-asar-digest-test-'),
      );
      if (
        path.dirname(root) !== path.resolve(tmpdir()) ||
        !path.basename(root).startsWith('otto-crypto-asar-digest-test-')
      )
        throw new Error('Unsafe test cleanup');
      try {
        const payload = path.join(root, 'payload');
        mkdirSync(payload);
        writeFileSync(path.join(payload, 'fixture.txt'), 'synthetic-content');
        const archive = path.join(root, 'app.asar');
        await createPackage(payload, archive);
        const expected = createHash('sha256')
          .update(readFileSync(archive))
          .digest('hex');
        const entry = path.join(root, 'entry.cjs');
        writeFileSync(
          entry,
          `
        const fs = require('node:fs');
        const { app } = require('electron');
        let step = 'digest';
        try {
          const { digest } = require(${JSON.stringify(probe)});
          const hash = digest(${JSON.stringify(archive)});
          step = 'virtual-read';
          if (fs.readFileSync(${JSON.stringify(path.join(archive, 'fixture.txt'))}, 'utf8') !== 'synthetic-content' || process.noAsar === true) throw new Error('ASAR access changed');
          fs.writeSync(1, hash + '\\n');
          app.exit(0);
        } catch (error) { fs.writeSync(2, step + ':' + (error.code || 'failed')); app.exit(1); }
      `,
        );
        const result = spawnSync(electronExecutable, [entry], {
          env: rejectedEnvironment,
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        });
        expect(result.error).toBeUndefined();
        expect(result.stderr).not.toContain('EISDIR');
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(expected);
      } finally {
        // This exact directory was exclusively created above, never an installation.
        rmSync(root, { recursive: true, force: true });
      }
    },
    20000,
  );

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
