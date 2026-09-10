/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

it('runs the entire scripts suite as a mandatory merge gate before long builds', () => {
  const workflow = parse(readFileSync(
    new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8',
  ));
  const job = workflow.jobs['build-and-test'];
  const steps = job.steps;
  const scriptTests = steps.filter(step => step.id === 'scripts_tests');
  expect(scriptTests).toHaveLength(1);
  const [gate] = scriptTests;
  expect(gate.run).toBe('npm run test:scripts');
  expect(gate.if).toBeUndefined();
  expect(gate['continue-on-error']).toBeUndefined();
  expect(job['continue-on-error']).toBeUndefined();
  expect(steps.indexOf(gate)).toBeGreaterThan(steps.findIndex(step => step.run === 'npm ci'));
  expect(steps.indexOf(gate)).toBeLessThan(steps.findIndex(
    step => step.name === 'Build current-source native integration test runtime',
  ));
});

it('retains actual desktop coverage after a completed test step without bypassing its result', () => {
  const workflow = parse(
    readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    ),
  );
  const steps = workflow.jobs['build-and-test'].steps;
  const test = steps.find((step) => step.id === 'desktop_tests');
  const upload = steps.find(
    (step) => step.name === 'Preserve desktop coverage measurement',
  );
  expect(test.run).toBe('npm run test:coverage --workspace=packages/desktop');
  expect(test['continue-on-error']).toBeUndefined();
  expect(upload.if).toBe(
    "${{ always() && (steps.desktop_tests.outcome == 'success' || steps.desktop_tests.outcome == 'failure') }}",
  );
  for (const evidence of [
    'coverage/coverage-final.json',
    'test-results.json',
    'receipt.json',
    'stdout.txt',
    'stderr.txt',
  ]) {
    expect(upload.with.path).toContain(
      `packages/desktop/coverage/desktop-runs/*/${evidence}`,
    );
  }
  expect(upload.with.path).toContain(
    'packages/desktop/coverage/desktop-coverage-latest.json',
  );
  expect(upload.with.name).toBe('desktop-coverage-${{ github.sha }}');
  expect(upload.with['if-no-files-found']).toBe('error');
  expect(upload.with['retention-days']).toBe(14);
  expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
  expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(test));
});

it('makes the native coverage runner mandatory in package, CI and release checks', () => {
  const desktop = JSON.parse(
    readFileSync(
      new URL('../../packages/desktop/package.json', import.meta.url),
      'utf8',
    ),
  );
  const root = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const config = readFileSync(
    new URL('../../packages/desktop/vitest.config.ts', import.meta.url),
    'utf8',
  );
  const release = parse(
    readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf8',
    ),
  );
  expect(desktop.scripts['test:coverage']).toBe(
    'node ../../scripts/run-desktop-coverage.mjs',
  );
  expect(root.scripts['test:ci']).toContain(
    'npm run test:coverage --workspace=packages/desktop',
  );
  expect(config).toMatch(/lines:\s*62/);
  expect(config).toMatch(/statements:\s*62/);
  expect(config).toContain('verify-desktop-coverage-ratchet.mjs');
  expect(config).not.toMatch(/(?:functions|branches):\s*\d+/);
  const buildSteps = Object.values(release.jobs).flatMap(
    (job) => job.steps ?? [],
  );
  const quality = buildSteps.find((step) => step.id === 'release_quality');
  expect(quality.run).toContain('npm run test:ci');
  expect(quality['continue-on-error']).toBeUndefined();
  const upload = buildSteps.find(
    (step) => step.name === 'Preserve release desktop coverage evidence',
  );
  expect(upload.if).toContain("steps.release_quality.outcome == 'failure'");
  expect(upload.with.path).toContain(
    'packages/desktop/coverage/desktop-runs/*/receipt.json',
  );
  expect(upload.with.path).toContain(
    'packages/desktop/coverage/desktop-runs/*/coverage/coverage-final.json',
  );
});
