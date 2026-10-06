/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

function securityVersionReview(name) {
  const file = new URL(`../../config/test-baselines/desktop/release-1921-${name}-review.json`, import.meta.url);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

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

it('preserves the historical 1.9.18 version-only lock review without claiming it measures later dependencies', () => {
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
    lockAfter: 'c8be049f25a981192c7adcd3c3180161ed7ac52725b22f94f894471126886422',
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
    expect(baseline.review.environmentUpdates).toContainEqual(review);
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
    expect(baseline.review.fileUpdates).toContainEqual(review);
  }
});

it.each([
  ['win32', 'win32-x64'], ['darwin', 'darwin-arm64'],
])('binds the 1.9.20 %s version-only review without increasing any uncovered budget', (name, platform) => {
  const file = new URL(`../../config/test-baselines/desktop/release-1920-${name}-review.json`, import.meta.url);
  const review = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  expect(review).toMatchObject({
    schemaVersion: 1,
    status: 'reviewed-version-only-source-and-environment-update',
    reference: 'https://github.com/NSIETeam/otto-new/pull/89',
    sourceCommit: '87feadfd26c135b8c98ade7f703dbac185af5751',
    nativeExitCode: 0, assertionsPassed: 2247, testFiles: 271,
    unchangedEntriesPreserved: 282,
    changedLockFields: ['version','packages[empty].version','packages/core.version','packages/desktop.version'],
    environmentAfter: { platform: name, arch: name === 'win32' ? 'x64' : 'arm64', nodeMajor: 22,
      vitest: '4.1.11', coverageV8: '4.1.11', mapper: 'ast' },
  });
  expect(review.files).toHaveLength(1);
  const entry = review.files[0];
  expect(entry.file).toBe('src/renderer/browserPreviewBridge.ts');
  expect(entry.before).toEqual(entry.after);
  expect(review.changedLiterals).toEqual(['1.9.19-browser-preview -> 1.9.20-browser-preview','1.9.19 -> 1.9.20']);
  const baseline = JSON.parse(gunzipSync(readFileSync(new URL(
    `../../config/test-baselines/desktop/${platform}-node22-vitest4.json.gz`, import.meta.url,
  ))));
  const unchanged = Object.fromEntries(Object.entries(baseline.files).filter(([source]) => source !== entry.file).sort());
  expect(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex')).toBe(review.unchangedEntriesSha256);
  expect(createHash('sha256').update(JSON.stringify(baseline.tests)).digest('hex')).toBe(review.unchangedRequiredTestsSha256);
  const latest = securityVersionReview(name);
  if (latest) {
    expect(latest.files[0].beforeEntrySha256).toBe(entry.afterEntrySha256);
    expect(latest.environmentBefore).toEqual(review.environmentAfter);
  }
  expect(createHash('sha256').update(JSON.stringify(baseline.files[entry.file])).digest('hex')).toBe((latest?.files[0] ?? entry).afterEntrySha256);
  expect(baseline.review.environmentUpdates).toContainEqual(review);
  expect(baseline.review.fileUpdates).toContainEqual(review);
  expect(baseline.environment).toEqual(latest?.environmentAfter ?? review.environmentAfter);
  for (const field of Object.keys(review.environmentBefore).filter(key => key !== 'lockSha256')) {
    expect(review.environmentAfter[field]).toBe(review.environmentBefore[field]);
  }
  expect(review.environmentAfter.lockSha256).toBe('12a3abee0fb9857c61153f534db63e5e9c97d0dee173784d453d99b5465b0a01');
  // This record attests the historical 1.9.20 lock, not every future lock.
  // The native runner still binds each fresh measurement to the current lock
  // and rejects an environment change until a new scoped review is recorded.
  expect(baseline.review.environmentUpdates).toContainEqual(review);
  expect(review.boundaries).toContain('No threshold, uncovered count, required test, instrumentation hint or unrelated file entry is changed.');
});

it.each([
  ['win32', 'win32-x64'], ['darwin', 'darwin-arm64'],
])('binds the 1.9.19 %s scoped review to native evidence without lowering global thresholds', (name, platform) => {
  const review = JSON.parse(readFileSync(new URL(
    `../../config/test-baselines/desktop/release-1919-${name}-review.json`, import.meta.url,
  ), 'utf8'));
  const baseline = JSON.parse(gunzipSync(readFileSync(new URL(
    `../../config/test-baselines/desktop/${platform}-node22-vitest4.json.gz`, import.meta.url,
  ))));
  expect(review).toMatchObject({
    reference: 'https://github.com/NSIETeam/otto-new/pull/87',
    nativeExitCode: 0, assertionsPassed: 2234, testFiles: 270,
    environmentAfter: { platform: name, arch: name === 'win32' ? 'x64' : 'arm64', nodeMajor: 22,
      vitest: '4.1.11', coverageV8: '4.1.11', mapper: 'ast' },
  });
  expect(review.files.map(entry => entry.file).sort()).toEqual([
    'src/main/enterprise-e2ee.ts', 'src/renderer/App.tsx',
    'src/renderer/browserPreviewBridge.ts', 'src/renderer/components/OrganizationTree.tsx',
    'src/renderer/enterpriseKnowledgePromptContext.ts',
  ].sort());
  expect(review.unchangedEntriesPreserved).toBe(Object.keys(baseline.files).length - 5);
  const changed = new Set(review.files.map(entry => entry.file));
  const unchanged = Object.fromEntries(Object.entries(baseline.files).filter(([file]) => !changed.has(file)).sort());
  expect(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex')).toBe(review.unchangedEntriesSha256);
  expect(baseline.review.environmentUpdates).toContainEqual(review);
  const versionReview = JSON.parse(readFileSync(new URL(
    `../../config/test-baselines/desktop/release-1920-${name}-review.json`, import.meta.url,
  ), 'utf8'));
  for (const entry of review.files) {
    if (entry.file === 'src/renderer/browserPreviewBridge.ts') {
      expect(versionReview.files[0].beforeEntrySha256).toBe(entry.afterEntrySha256);
      expect(versionReview.files[0].before).toEqual(entry.after);
      expect(baseline.files[entry.file].sourceSha256).toBe((securityVersionReview(name)?.files[0] ?? versionReview.files[0]).sourceSha256);
    } else {
      expect(baseline.files[entry.file].sourceSha256).toBe(entry.sourceSha256);
    }
    expect(baseline.files[entry.file].metrics).toEqual(entry.after);
  }
  expect(versionReview.environmentBefore).toEqual(review.environmentAfter);
  expect(baseline.environment).toEqual(securityVersionReview(name)?.environmentAfter ?? versionReview.environmentAfter);
  const config = readFileSync(new URL('../../packages/desktop/vitest.config.ts', import.meta.url), 'utf8');
  expect(config).toMatch(/lines:\s*62/);
  expect(config).toMatch(/statements:\s*62/);
});

it.each([
  {
    name: 'win32', platform: 'win32-x64',
    runId: '48a84839-64dd-4b3a-bf43-8458f6102111',
    receiptSha256: 'bdfd4cb2197b2643780281721b3cfeab138771b64e4682899e8c7642f4848fe1',
    coverageSha256: 'c3214a55f0538ce3d3ba0072fa78c4e0e797a293bd7bbbf20f9c599c70f4537b',
    testResultsSha256: '83d362d3720bd0b4f1df60898c52498b76f84011a0fe5f6ecc14a9c262a42395',
  },
  {
    name: 'darwin', platform: 'darwin-arm64',
    runId: '7667cabb-b815-4ba5-b886-e405018de144',
    receiptSha256: '8c2ef348f969fbecf0ac4f8788e7fa7be49cbd97db01169034011b802b04b308',
    coverageSha256: 'bf31f75f29fec1743374e40ff02553b8943977d3bdbc2ae5bb3ce7a227c7a25f',
    testResultsSha256: '41fd895713f210b26f33a1c4871731fa63333ebecf720d8c6ce465ffc53b7608',
  },
])('binds the historical first 1.9.21 $name review to its measured lock and native receipt without relaxing coverage', ({ name, platform, runId, receiptSha256, coverageSha256, testResultsSha256 }) => {
  const review = securityVersionReview(name);
  expect(review).toMatchObject({
    schemaVersion: 1, status: 'reviewed-security-dependency-and-version-only-source-update',
    reference: 'https://github.com/NSIETeam/otto-new/pull/93',
    nativeHost: platform, nativeExitCode: 0, assertionsPassed: 2249, testFiles: 271,
    runId, receiptSha256, coverageSha256, testResultsSha256,
    unchangedEntriesPreserved: 282,
  });
  const baseline = JSON.parse(gunzipSync(readFileSync(new URL(
    `../../config/test-baselines/desktop/${platform}-node22-vitest4.json.gz`, import.meta.url,
  ))));
  const before = JSON.parse(readFileSync(new URL(
    `../../config/test-baselines/desktop/release-1920-${name}-review.json`, import.meta.url,
  ), 'utf8'));
  expect(review.environmentBefore).toEqual(before.environmentAfter);
  expect(review.environmentAfter).toEqual({ ...before.environmentAfter,
    lockSha256: createHash('sha256').update(readFileSync(new URL('../../package-lock.json', import.meta.url))).digest('hex'),
  });
  expect(baseline.environment).toEqual(review.environmentAfter);
  expect(baseline.review.environmentUpdates).toContainEqual(review);
  expect(baseline.review.fileUpdates).toContainEqual(review);
  expect(baseline.fileRevisions).toContainEqual(review);
  expect(review.changedLiterals).toEqual(['1.9.20-browser-preview -> 1.9.21-browser-preview','1.9.20 -> 1.9.21']);
  expect(review.files).toHaveLength(1);
  const entry = review.files[0];
  expect(entry.file).toBe('src/renderer/browserPreviewBridge.ts');
  expect(entry.beforeEntrySha256).toBe(before.files[0].afterEntrySha256);
  expect(entry.before).toEqual(entry.after);
  expect(entry.before).toEqual(before.files[0].after);
  expect(createHash('sha256').update(JSON.stringify(baseline.files[entry.file])).digest('hex')).toBe(entry.afterEntrySha256);
  const unchanged = Object.fromEntries(Object.entries(baseline.files).filter(([file]) => file !== entry.file).sort());
  expect(Object.keys(unchanged)).toHaveLength(282);
  expect(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex')).toBe(before.unchangedEntriesSha256);
  expect(review.unchangedEntriesSha256).toBe(before.unchangedEntriesSha256);
  expect(createHash('sha256').update(JSON.stringify(baseline.tests)).digest('hex')).toBe(before.unchangedRequiredTestsSha256);
  expect(review.unchangedRequiredTestsSha256).toBe(before.unchangedRequiredTestsSha256);
  expect(review.boundaries).toContain('No threshold, uncovered count, required test, instrumentation hint or unrelated file entry is changed.');
});
