/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const workflows = ['ci.yml', 'release.yml'].map(name => ({
  name,
  source: readFileSync(path.join(root, '.github/workflows', name), 'utf8').replaceAll('\r\n', '\n'),
}));
const stepName = '      - name: Prepare PostgreSQL 17 isolated-test binaries';
const git = process.platform === 'win32'
  ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
  : null;
const bash = git ? path.resolve(path.dirname(git), '../bin/bash.exe') : 'bash';

function preparation(source) {
  const start = source.indexOf(stepName);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n      - name:', start + stepName.length);
  const step = source.slice(start, end);
  expect(step).toContain('shell: bash');
  expect(step).not.toMatch(/continue-on-error|secrets\.|brew services|pg_ctl.*start|initdb.*-D|timeout/);
  return step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length)
    .split('\n').filter(line => line.startsWith('          '))
    .map(line => line.slice(10)).join('\n');
}

function exercise(script, { installed = true, major = 17, missingTool, installStatus = 0, runnerOS = 'macOS', relativePrefix = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'otto-postgres-ci-'));
  try {
    mkdirSync(path.join(directory, 'postgres/bin'), { recursive: true });
    for (const name of ['initdb', 'postgres', 'pg_ctl']) {
      if (name === missingTool) continue;
      writeFileSync(path.join(directory, 'postgres/bin', name),
        `#!/usr/bin/env bash\n[ "$#" -eq 1 ] && [ "$1" = --version ] || exit 99\nprintf '%s\\n' '${name} (PostgreSQL) ${major}.11'\n`, { mode: 0o755 });
    }
    const input = `cd -- "$FIXTURE_DIRECTORY"
export GITHUB_ENV="$PWD/exported-env" GITHUB_STEP_SUMMARY="$PWD/summary"
export RUNNER_OS=${JSON.stringify(runnerOS)} ImageVersion='fixture-image'
brew() {
  printf '%s\\n' "$*" >> "$PWD/brew-calls"
  case "$*" in
    'list --versions postgresql@17') return ${installed ? 0 : 1} ;;
    'install postgresql@17') return ${installStatus} ;;
    '--prefix postgresql@17') printf '%s\\n' ${relativePrefix ? 'relative-prefix' : '"$PWD/postgres"'} ;;
    *) return 99 ;;
  esac
}
${script}
`;
    const result = spawnSync(bash, [], {
      input, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, FIXTURE_DIRECTORY: directory.replaceAll('\\', '/') },
    });
    const read = file => existsSync(path.join(directory, file)) ? readFileSync(path.join(directory, file), 'utf8') : '';
    return { ...result, exported: read('exported-env'), summary: read('summary'), calls: read('brew-calls') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.each(workflows)('$name PostgreSQL acceptance wiring (not a real database test)', ({ source }) => {
  it('prepares PostgreSQL before every server suite without replacing the full quality gate', () => {
    const script = preparation(source);
    const firstTest = source.indexOf('npm --workspace otto-server run test') >= 0
      ? source.indexOf('npm --workspace otto-server run test') : source.indexOf('npm run test:ci');
    expect(source.indexOf(stepName)).toBeLessThan(firstTest);
    expect(source).toMatch(/npm run test(?: --workspace=packages\/server|:ci)/);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('HOMEBREW_NO_AUTO_UPDATE=1 brew install postgresql@17');
  });

  it('accepts installed 17 binaries and opts both modules into the same isolated-cluster harness', () => {
    const result = exercise(preparation(source));
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain('install postgresql@17');
    const values = Object.fromEntries(result.exported.trim().split('\n').map(line => line.split('=')));
    expect(values.OTTO_TEST_POSTGRES_BIN).toMatch(/^\/.*\/postgres\/bin$/);
    expect(values.OTTO_FLEA_MARKET_POSTGRES_BIN).toBe(values.OTTO_TEST_POSTGRES_BIN);
    expect(values.OTTO_CARPOOL_POSTGRES_BIN).toBe(values.OTTO_TEST_POSTGRES_BIN);
    expect(values.OTTO_CARPOOL_POSTGRES_TEST).toBe('1');
    expect(Object.keys(values)).toHaveLength(4);
    expect(result.summary).toContain('fixture-image');
    expect(result.summary).toContain('postgres (PostgreSQL) 17.11');
  });

  it('installs only the versioned official formula when absent, without starting a shared service', () => {
    const result = exercise(preparation(source), { installed: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.split('\n').filter(line => line === 'install postgresql@17')).toHaveLength(1);
    expect(result.calls).not.toContain('services');
  });

  it.each([
    { major: 18 },
    { missingTool: 'initdb' },
    { missingTool: 'postgres' },
    { missingTool: 'pg_ctl' },
    { installed: false, installStatus: 7 },
    { runnerOS: 'Linux' },
    { relativePrefix: true },
  ])('fails closed before exporting opt-in or paths: %j', options => {
    const result = exercise(preparation(source), options);
    expect(result.status).not.toBe(0);
    expect(result.exported).toBe('');
  });
});

it('keeps CI and the mandatory release build on the same PostgreSQL setup contract', () => {
  expect(preparation(workflows[0].source)).toBe(preparation(workflows[1].source));
});
