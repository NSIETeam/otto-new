/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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
  const runtime = steps.find(step => step.id === 'scripts_workflow_runtime');
  expect(runtime?.run).toBe('npm run build --workspace=packages/workflow');
  expect(runtime.if).toBeUndefined();
  expect(runtime['continue-on-error']).toBeUndefined();
  expect(steps.indexOf(runtime)).toBeGreaterThan(steps.findIndex(step => step.run === 'npm ci'));
  expect(steps.indexOf(runtime)).toBeLessThan(steps.indexOf(gate));
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

it('binds both reviewed desktop coverage baselines to the 1.9.18 version-only lockfile change', () => {
  const lockSha256 = sha256(
    readFileSync(new URL('../../package-lock.json', import.meta.url)),
  );
  const review = JSON.parse(
    readFileSync(
      new URL(
        '../../config/test-baselines/desktop/release-1918-version-environment-review.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  expect(review).toMatchObject({
    schemaVersion: 1,
    status: 'reviewed-version-only-environment',
    reference: 'https://github.com/NSIETeam/otto-new/pull/86',
    lockBefore: '859de95406f35cd4b254d9005cc77605e37a35dcdff45d5c4357c8fbfcacde5f',
    lockAfter: lockSha256,
    changedRecords: [
      'version',
      'packages[empty].version',
      'packages/core.version',
      'packages/desktop.version',
    ],
  });
  expect(review.boundaries).toContain(
    'No dependency, coverage tool, test configuration, source-site budget or threshold is changed by this review.',
  );

  for (const platform of [
    'darwin-arm64-node22-vitest4.json.gz',
    'win32-x64-node22-vitest4.json.gz',
  ]) {
    const baseline = JSON.parse(
      gunzipSync(
        readFileSync(
          new URL(
            `../../config/test-baselines/desktop/${platform}`,
            import.meta.url,
          ),
        ),
      ),
    );
    expect(baseline.environment.lockSha256).toBe(lockSha256);
    expect(baseline.review.environmentUpdates.at(-1)).toEqual(review);
  }
});

it('binds the 1.9.18 browser preview baseline change to the preserved native measurement', () => {
  const review = JSON.parse(
    readFileSync(
      new URL(
        '../../config/test-baselines/desktop/release-1918-browser-preview-review.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  expect(review).toMatchObject({
    schemaVersion: 1,
    status: 'reviewed-single-file-version-only-measurement-update',
    reference: 'https://github.com/NSIETeam/otto-new/pull/86',
    testedMerge: 'b23088ba086c5ef0cc7365aadf9780afcf11d6ef',
    artifactId: 10625700177,
    runId: 'c413c760-b181-4fd2-ad74-4a2e66d34bef',
    receiptSha256: '13fab02764b6378c78e900d17a09ad72660f5b9e3b20265ee4e5fd51d6ed5758',
    coverageSha256: 'c7d479ad7eb18fdb49faa972ed7fcd45fe843a6cc711f80d7d01f37e44139589',
    testResultsSha256: '5aecb1bbd8b642703e5ff81d5e815be544291376a44d66475fe443190cd2e266',
    nativeExitCode: 0,
    assertionsPassed: 2214,
    file: 'src/renderer/browserPreviewBridge.ts',
    sourceSha256: 'd2751f57800cb07c35bc4626979c7812593f9f6aa57622a6cd17d44169f20e42',
    beforeEntrySha256: '5e0b8e434454cd006e6f3224eb305492a84d4150f56412d73dc0c67897ed57dc',
    afterEntrySha256: 'bbab3411c1a45a1456aaa4490d42183ab309a8df9b25247169e09b729b3d8d10',
  });
  expect(review.before).toEqual(review.after);
  expect(review.changedLiterals).toEqual([
    '1.9.17-browser-preview -> 1.9.18-browser-preview',
    '1.9.17 -> 1.9.18',
  ]);
  expect(review.boundaries).toContain(
    'No threshold, uncovered count, uncovered-site budget, required test or unrelated file entry is changed by this review.',
  );

  for (const platform of [
    'darwin-arm64-node22-vitest4.json.gz',
    'win32-x64-node22-vitest4.json.gz',
  ]) {
    const baseline = JSON.parse(
      gunzipSync(
        readFileSync(
          new URL(
            `../../config/test-baselines/desktop/${platform}`,
            import.meta.url,
          ),
        ),
      ),
    );
    expect(sha256(JSON.stringify(baseline.files[review.file]))).toBe(
      review.afterEntrySha256,
    );
    expect(baseline.review.fileUpdates.at(-1)).toEqual(review);
  }
});
