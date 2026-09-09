/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAuditDiagnostic,
  findDirectImageSizeReferences,
  validateAuditReport,
  validateExceptionPolicy,
  validateInstalledReachability,
  validateLockfile,
  validateProjectSourceReachability,
  validateWorkspaceManifests,
} from '../verify-release-dependency-audit.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const policyPath = path.join(
  repoRoot,
  'config/security/npm-audit-exception-1.9.14.json',
);
const auditSnapshotPath = path.join(
  repoRoot,
  'config/security/npm-audit-1.9.14.expected.json',
);
const verifierPath = path.join(
  repoRoot,
  'scripts/verify-release-dependency-audit.mjs',
);
const temporaryDirectories = [];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function writeInstalledFixture(exception) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'otto-dep-audit-'));
  temporaryDirectories.push(root);
  const pptxRoot = path.join(root, 'node_modules/pptxgenjs');
  const imageRoot = path.join(root, 'node_modules/image-size');
  await Promise.all([
    mkdir(path.join(pptxRoot, 'dist'), { recursive: true }),
    mkdir(imageRoot, { recursive: true }),
  ]);
  await writeFile(
    path.join(pptxRoot, 'package.json'),
    JSON.stringify({
      version: '4.0.1',
      dependencies: { 'image-size': '^1.2.1' },
      browser: { 'image-size': false },
      main: 'dist/pptxgen.cjs.js',
      module: 'dist/pptxgen.es.js',
      exports: {
        import: './dist/pptxgen.es.js',
        require: './dist/pptxgen.cjs.js',
      },
    }),
  );
  await writeFile(
    path.join(imageRoot, 'package.json'),
    JSON.stringify({ version: '1.2.1' }),
  );

  const contentsByFile = {
    'pptxgen.bundle.js': 'export const bundle = true;',
    'pptxgen.cjs.js': 'module.exports = {};',
    'pptxgen.es.js': 'export default {};',
    'pptxgen.min.js': 'export{};',
  };
  exception.installedContract.runtimeFiles = {};
  for (const [fileName, contents] of Object.entries(contentsByFile)) {
    await writeFile(path.join(pptxRoot, 'dist', fileName), contents);
    exception.installedContract.runtimeFiles[fileName] = createHash('sha256')
      .update(contents)
      .digest('hex');
  }
  return { root, pptxRoot, contentsByFile };
}

describe('release dependency audit gate', () => {
  it('accepts only the reviewed policy, exact lock path and exact audit snapshot', async () => {
    const [policy, auditReport, lock] = await Promise.all([
      readJson(policyPath),
      readJson(auditSnapshotPath),
      readJson(path.join(repoRoot, 'package-lock.json')),
    ]);
    const exception = validateExceptionPolicy(
      policy,
      new Date('2026-08-30T12:00:00Z'),
    );

    expect(() => validateLockfile(lock, exception)).not.toThrow();
    expect(() => validateWorkspaceManifests(repoRoot, lock)).not.toThrow();
    expect(() => validateProjectSourceReachability(repoRoot)).not.toThrow();
    expect(() => validateAuditReport(auditReport, exception)).not.toThrow();
    // This test reads every tracked source file. A cold Windows worktree took
    // 13.58s alongside the full suite; preserve the full scan with a bounded
    // per-case IO allowance, without relaxing any policy or scan assertion.
  }, 30_000);

  it('expires automatically on the review deadline', async () => {
    const policy = await readJson(policyPath);
    expect(() =>
      validateExceptionPolicy(policy, new Date('2026-09-15T00:00:00Z')),
    ).toThrow('exception expired');
  });

  it('fails when a package version or dependency edge changes', async () => {
    const [policy, lock] = await Promise.all([
      readJson(policyPath),
      readJson(path.join(repoRoot, 'package-lock.json')),
    ]);
    const changedLock = clone(lock);
    changedLock.packages['node_modules/image-size'].version = '2.0.2';

    expect(() => validateLockfile(changedLock, policy.exception)).toThrow(
      'image-size lock identity changed',
    );
    changedLock.packages['node_modules/image-size'].version = '1.2.1';
    changedLock.packages['node_modules/another-parent'] = {
      version: '1.0.0',
      dependencies: { 'image-size': '^1.2.1' },
    };
    expect(() => validateLockfile(changedLock, policy.exception)).toThrow(
      'image-size dependency path changed',
    );
  });

  it('rejects any additional high or critical audit result', async () => {
    const [policy, auditReport] = await Promise.all([
      readJson(policyPath),
      readJson(auditSnapshotPath),
    ]);
    const extraHigh = clone(auditReport);
    extraHigh.metadata.vulnerabilities.high = 3;
    extraHigh.metadata.vulnerabilities.total = 3;
    extraHigh.vulnerabilities['unexpected-high'] = {
      name: 'unexpected-high',
      severity: 'high',
      via: [],
    };
    expect(() => validateAuditReport(extraHigh, policy.exception)).toThrow(
      'npm audit severity totals changed',
    );

    const critical = clone(auditReport);
    critical.metadata.vulnerabilities.critical = 1;
    critical.metadata.vulnerabilities.total = 3;
    expect(() => validateAuditReport(critical, policy.exception)).toThrow(
      'npm audit severity totals changed',
    );
  });

  it('keeps public audit metadata but excludes arbitrary secrets and raw endpoint diagnostics', async () => {
    const report = await readJson(auditSnapshotPath);
    const sentinel = 'do-not-publish-fixture-secret';
    const input = clone(report);
    input.env = { TOKEN: sentinel };
    input.stderr = sentinel;
    input.error = { code: 'EAUDIT', summary: sentinel, detail: sentinel };
    input.metadata.environment = { TOKEN: sentinel };
    input.vulnerabilities['image-size'].credentials = sentinel;
    input.vulnerabilities['image-size'].via[0].env = { TOKEN: sentinel };
    const diagnostic = createAuditDiagnostic(input);
    expect(diagnostic.vulnerabilities).toEqual(report.vulnerabilities);
    expect(diagnostic.metadata).toEqual(report.metadata);
    expect(diagnostic.error).toEqual({ code: 'EAUDIT' });
    expect(JSON.stringify(diagnostic)).not.toContain(sentinel);

    input.vulnerabilities['image-size'].via[0].url =
      `https://user:${sentinel}@github.com/advisories/GHSA-w3rx-r6r6-pgpr?token=${sentinel}`;
    expect(JSON.stringify(createAuditDiagnostic(input))).not.toContain(
      sentinel,
    );
  });

  it('preserves the actual live report before rejecting newly discovered advisories', async () => {
    const report = await readJson(auditSnapshotPath);
    report.metadata.vulnerabilities.high += 1;
    report.metadata.vulnerabilities.total += 1;
    report.vulnerabilities['newly-vulnerable'] = {
      name: 'newly-vulnerable',
      severity: 'high',
      isDirect: true,
      via: [
        {
          source: 1234567,
          name: 'newly-vulnerable',
          dependency: 'newly-vulnerable',
          title: 'New public advisory',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          severity: 'high',
          range: '<2.0.0',
        },
      ],
      effects: [],
      range: '<2.0.0',
      nodes: ['node_modules/newly-vulnerable'],
      fixAvailable: true,
    };
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'otto-audit-diagnostic-'),
    );
    temporaryDirectories.push(root);
    const npmFixture = path.join(root, 'npm-fixture.mjs');
    const diagnosticPath = path.join(root, 'evidence', 'npm-audit.json');
    await writeFile(
      npmFixture,
      `process.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exitCode = 1;`,
    );
    const result = spawnSync(
      process.execPath,
      [verifierPath, '--diagnostic-json', diagnosticPath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CI: 'true',
          npm_execpath: npmFixture,
          npm_node_execpath: process.execPath,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(await readJson(diagnosticPath)).toEqual(report);
    expect(result.stderr).toContain('newly-vulnerable');
    expect(result.stderr).toContain('GHSA-aaaa-bbbb-cccc');
    expect(result.stderr).not.toContain('verified');
  }, 30_000);

  it('reports an audit endpoint failure before treating it as a format change', async () => {
    const policy = await readJson(policyPath);
    expect(() =>
      validateAuditReport(
        { error: { summary: 'registry unavailable' } },
        policy.exception,
      ),
    ).toThrow('npm audit endpoint returned an error');
  });

  it('does not overwrite prior diagnostic evidence', async () => {
    const report = await readJson(auditSnapshotPath);
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-audit-existing-'));
    temporaryDirectories.push(root);
    const npmFixture = path.join(root, 'npm-fixture.mjs');
    const diagnosticPath = path.join(root, 'npm-audit.json');
    await writeFile(
      npmFixture,
      `process.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exitCode = 1;`,
    );
    await writeFile(diagnosticPath, 'previous evidence');
    const result = spawnSync(
      process.execPath,
      [verifierPath, '--diagnostic-json', diagnosticPath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CI: 'true',
          npm_execpath: npmFixture,
          npm_node_execpath: process.execPath,
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EEXIST');
    expect(await readFile(diagnosticPath, 'utf8')).toBe('previous evidence');
  });

  it('does not publish process stderr or malformed JSON fragments', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-audit-errors-'));
    temporaryDirectories.push(root);
    const sentinel = 'do-not-publish-fixture-secret';
    const npmFixture = path.join(root, 'npm-fixture.mjs');
    for (const [kind, script] of [
      [
        'stderr',
        `process.stderr.write(${JSON.stringify(sentinel)}); process.exitCode = 2;`,
      ],
      ['invalid-json', `process.stdout.write(${JSON.stringify(sentinel)});`],
    ]) {
      await writeFile(npmFixture, script);
      const diagnosticPath = path.join(root, `${kind}.json`);
      const result = spawnSync(
        process.execPath,
        [verifierPath, '--diagnostic-json', diagnosticPath],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            CI: 'true',
            npm_execpath: npmFixture,
            npm_node_execpath: process.execPath,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain(sentinel);
      expect(result.stdout).not.toContain(sentinel);
      await expect(readFile(diagnosticPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });

  it('requires a diagnostic path before attempting a network audit', () => {
    const result = spawnSync(
      process.execPath,
      [verifierPath, '--diagnostic-json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--diagnostic-json requires a path');
  });

  it('rejects advisory identity or remediation changes', async () => {
    const [policy, auditReport] = await Promise.all([
      readJson(policyPath),
      readJson(auditSnapshotPath),
    ]);
    const changedAdvisory = clone(auditReport);
    changedAdvisory.vulnerabilities['image-size'].via[0].url =
      'https://github.com/advisories/GHSA-new-advisory';
    expect(() =>
      validateAuditReport(changedAdvisory, policy.exception),
    ).toThrow('npm advisory ids changed');

    const fixedRelease = clone(auditReport);
    fixedRelease.vulnerabilities.pptxgenjs.fixAvailable = {
      name: 'pptxgenjs',
      version: '4.0.2',
      isSemVerMajor: false,
    };
    expect(() => validateAuditReport(fixedRelease, policy.exception)).toThrow(
      'pptxgenjs audit remediation changed',
    );

    const changedRange = clone(auditReport);
    changedRange.vulnerabilities['image-size'].range = '<=2.0.2';
    expect(() => validateAuditReport(changedRange, policy.exception)).toThrow(
      'image-size audit record changed',
    );

    const imageSizeFix = clone(auditReport);
    imageSizeFix.vulnerabilities['image-size'].fixAvailable = {
      name: 'image-size',
      version: '2.0.3',
      isSemVerMajor: true,
    };
    expect(() => validateAuditReport(imageSizeFix, policy.exception)).toThrow(
      'image-size audit remediation changed',
    );
  });

  it('requires exact installed runtime hashes and no image-size reachability token', async () => {
    const policy = await readJson(policyPath);
    const exception = clone(policy.exception);
    const { root, pptxRoot, contentsByFile } =
      await writeInstalledFixture(exception);
    expect(() => validateInstalledReachability(root, exception)).not.toThrow();

    const changedContents = `${contentsByFile['pptxgen.es.js']} import 'image-size';`;
    await writeFile(path.join(pptxRoot, 'dist/pptxgen.es.js'), changedContents);
    exception.installedContract.runtimeFiles['pptxgen.es.js'] = createHash(
      'sha256',
    )
      .update(changedContents)
      .digest('hex');
    expect(() => validateInstalledReachability(root, exception)).toThrow(
      'runtime reached forbidden token',
    );
  });

  it('detects a direct project source import independently of the audit graph', () => {
    expect(
      findDirectImageSizeReferences([
        { filePath: 'safe.ts', contents: "import pptxgen from 'pptxgenjs';" },
        {
          filePath: 'unsafe.ts',
          contents: "const dimensions = require('image-size');",
        },
      ]),
    ).toEqual(['unsafe.ts']);
  });

  it('rejects workspace aliases and overrides that introduce image-size', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-dep-manifest-'));
    temporaryDirectories.push(root);
    const lock = { packages: { '': {} } };
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        dependencies: { dimensions: 'npm:image-size@1.2.1' },
      }),
    );
    expect(() => validateWorkspaceManifests(root, lock)).toThrow(
      'workspace directly references image-size',
    );

    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ overrides: { 'image-size@1.2.1': '2.0.2' } }),
    );
    expect(() => validateWorkspaceManifests(root, lock)).toThrow(
      'workspace override changed image-size resolution',
    );
  });

  it('wires the live gate into the release workflow without a snapshot bypass', async () => {
    const [rootPackage, workflow, verifier] = await Promise.all([
      readJson(path.join(repoRoot, 'package.json')),
      readFile(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8'),
      readFile(verifierPath, 'utf8'),
    ]);
    expect(rootPackage.scripts['security:dependencies:release']).toBe(
      'node scripts/verify-release-dependency-audit.mjs',
    );
    expect(workflow).toContain('name: Enforce release dependency audit');
    expect(workflow).toContain('npm run security:dependencies:release');
    expect(workflow).not.toContain(
      'security:dependencies:release -- --audit-json',
    );
    expect(verifier).toContain('--registry=https://registry.npmjs.org/');
  });

  it('refuses the offline audit snapshot whenever CI is active', () => {
    const result = spawnSync(
      process.execPath,
      [verifierPath, '--audit-json', auditSnapshotPath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'CI must use a live npm audit report; --audit-json is forbidden',
    );
  });
});
