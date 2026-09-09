/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'tinyglobby';
import { describe, expect, it } from 'vitest';
import { configDefaults } from 'vitest/config';
import coreConfig from '../../packages/core/vitest.config.ts';
import serverConfiguration from '../../packages/server/vitest.config.ts';
import rpaConfig from '../../packages/rpa/vitest.config.ts';
import workflowConfig from '../../packages/workflow/vitest.config.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const workspaceRoot = path.join(repoRoot, 'packages/server');
const vitestCli = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
const serverConfig = path.join(workspaceRoot, 'vitest.config.ts');
const testFile = 'src/taskRequirements.test.ts';

// Copied from the actual installed Vitest 3.2.7 dist/config.cjs before migration.
// These are generic generated/config directory rules, not business exclusions.
const legacyInclude = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
const legacyExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
  '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
];

function invoke(cwd, args) {
  return spawnSync(process.execPath, [vitestCli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 25_000,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  });
}

describe('Vitest migration preserves server test entry points', () => {
  it.each([
    ['core', coreConfig],
    ['server', serverConfiguration],
    ['rpa', rpaConfig],
    ['workflow', workflowConfig],
  ])(
    'preserves the legacy discovery contract and current test set for %s',
    (name, configuration) => {
      const include = configuration.test.include ?? configDefaults.include;
      const exclude = configuration.test.exclude ?? configDefaults.exclude;
      expect(include).toEqual(legacyInclude);
      expect(exclude).toEqual(expect.arrayContaining(legacyExclude));
      // Enumerate only: do not execute four large suites or touch their databases.
      const cwd = path.join(repoRoot, 'packages', name);
      const before = globSync(legacyInclude, {
        cwd,
        ignore: legacyExclude,
      }).sort();
      const after = globSync(include, { cwd, ignore: exclude }).sort();
      expect(before.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    },
  );

  // Execute the same pure, non-database source test through both real CLI entry
  // points. A zero exit or an empty test list alone cannot satisfy this check.
  it.each([
    ['repository root', repoRoot, `packages/server/${testFile}`],
    ['server workspace', workspaceRoot, testFile],
  ])(
    'runs the selected source test from the %s',
    (_label, cwd, filter) => {
      const result = invoke(cwd, [
        'run',
        filter,
        '--config',
        serverConfig,
        '--configLoader',
        'native',
        '--maxWorkers',
        '1',
        '--no-file-parallelism',
        '--coverage.enabled=false',
        '--reporter=json',
      ]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.success).toBe(true);
      expect(report.numFailedTests).toBe(0);
      expect(report.numTotalTests).toBeGreaterThan(0);
      expect(report.numPassedTests).toBe(report.numTotalTests);
      expect(report.testResults).toHaveLength(1);
      expect(report.testResults[0].name.replaceAll('\\', '/')).toBe(
        path.join(workspaceRoot, testFile).replaceAll('\\', '/'),
      );
    },
    30_000,
  );

  it('still collects the registered repository-level park integration entry point', () => {
    const target = 'integration/park-market/encrypted-flow.test.ts';
    // filesOnly lists matched filenames without importing the integration test:
    // this is collection evidence, not a claimed PostgreSQL/HTTP business run.
    const result = invoke(repoRoot, [
      'list',
      target,
      '--config',
      serverConfig,
      '--configLoader',
      'native',
      '--filesOnly',
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.replaceAll('\\', '/')).toContain(target);
  }, 30_000);
});
