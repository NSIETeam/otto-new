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
  validateCleanAuditReport,
  validateExceptionPolicy,
  validateInstalledReachability,
  validateLockfile,
  validateProjectSourceReachability,
  validateRemediatedDependencyTree,
  validateWorkspaceManifests,
  verifyReleaseDependencyAudit,
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

// The expired policy remains an immutable historical fixture, not the current
// release dependency graph. Never move its deadline to make a build pass.
async function historicalLock() {
  const lock = await readJson(path.join(repoRoot, 'package-lock.json'));
  const { exception } = await readJson(policyPath);
  lock.packages['node_modules/image-size'] = {
    version: exception.vulnerablePackage.version,
    integrity: exception.vulnerablePackage.integrity,
  };
  return lock;
}

function cleanAudit() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
      dependencies: {
        prod: 100,
        dev: 100,
        optional: 0,
        peer: 0,
        peerOptional: 0,
        total: 200,
      },
    },
  };
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
  it('accepts the remediated installed tree with zero findings after the old waiver expires', () => {
    const result = verifyReleaseDependencyAudit({
      auditReport: cleanAudit(),
      now: new Date('2026-09-20T12:00:00Z'),
    });
    expect(result).toMatchObject({
      policyId: 'otto-image-size-2.0.4-remediation',
      dependencyPath: 'pptxgenjs@4.0.1 -> image-size@2.0.4',
      advisories: [],
    });
    expect(result).not.toHaveProperty('expiresAt');
  }, 30_000);

  it('accepts only the reviewed policy, exact lock path and exact audit snapshot', async () => {
    const [policy, auditReport, lock] = await Promise.all([
      readJson(policyPath),
      readJson(auditSnapshotPath),
      historicalLock(),
    ]);
    const exception = validateExceptionPolicy(
      policy,
      new Date('2026-08-30T12:00:00Z'),
    );

    expect(() => validateLockfile(lock, exception)).not.toThrow();
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'otto-historical-workspaces-'),
    );
    temporaryDirectories.push(root);
    for (const workspace of Object.keys(lock.packages).filter(
      (key) => !key.includes('node_modules'),
    )) {
      await mkdir(path.join(root, workspace), { recursive: true });
      await writeFile(
        path.join(root, workspace, 'package.json'),
        JSON.stringify(lock.packages[workspace]),
      );
    }
    expect(() => validateWorkspaceManifests(root, lock)).not.toThrow();
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

  it.each(['info', 'low', 'moderate', 'high', 'critical'])(
    'refuses even one %s finding after remediation',
    (severity) => {
      const report = cleanAudit();
      report.metadata.vulnerabilities[severity] = 1;
      report.metadata.vulnerabilities.total = 1;
      expect(() => validateCleanAuditReport(report)).toThrow(
        'zero severity totals',
      );
      report.vulnerabilities.example = { severity };
      expect(() => validateCleanAuditReport(report)).toThrow(
        'no vulnerability findings',
      );
    },
  );

  it('rejects missing, partial, failed and inconsistent clean audit responses', () => {
    for (const report of [
      undefined,
      {},
      { ...cleanAudit(), error: { code: 'EAUDIT' } },
      { ...cleanAudit(), vulnerabilities: undefined },
      { ...cleanAudit(), vulnerabilities: [] },
      { ...cleanAudit(), auditReportVersion: 1 },
      { ...cleanAudit(), metadata: {} },
    ]) {
      expect(() => validateCleanAuditReport(report)).toThrow();
    }
    for (const key of [
      'prod',
      'dev',
      'optional',
      'peer',
      'peerOptional',
      'total',
    ]) {
      const report = cleanAudit();
      delete report.metadata.dependencies[key];
      expect(() => validateCleanAuditReport(report)).toThrow('inventory');
    }
  });

  it('does not accept the old affected resolution even with a clean audit response', async () => {
    const lock = await historicalLock();
    expect(() => validateRemediatedDependencyTree(repoRoot, lock)).toThrow(
      'image-size lock identity changed',
    );
    const current = await readJson(path.join(repoRoot, 'package-lock.json'));
    current.packages['node_modules/image-size'].integrity += 'tampered';
    expect(() => validateRemediatedDependencyTree(repoRoot, current)).toThrow(
      'image-size lock identity changed',
    );
  });

  it('permits only the reviewed root override and rejects another route to image-size', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-fixed-override-'));
    temporaryDirectories.push(root);
    const lock = { packages: { '': {} } };
    const manifest = { overrides: { pptxgenjs: { 'image-size': '2.0.4' } } };
    const write = () =>
      writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    await write();
    expect(() =>
      validateWorkspaceManifests(root, lock, { remediated: true }),
    ).not.toThrow();
    manifest.overrides.pptxgenjs['image-size'] = '^2.0.4';
    await write();
    expect(() =>
      validateWorkspaceManifests(root, lock, { remediated: true }),
    ).toThrow('reviewed image-size override');
    manifest.overrides.pptxgenjs['image-size'] = '2.0.4';
    manifest.overrides.another = { 'image-size': '1.2.1' };
    await write();
    expect(() =>
      validateWorkspaceManifests(root, lock, { remediated: true }),
    ).toThrow('workspace override');
  });

  it.each(['require', 'import'])(
    'rejects malformed ICNS, HEIF and JXL without hanging (%s)',
    (mode) => {
      // Bound the actual installed parser in a child process: a regression must
      // fail with a timeout, not hang the complete CI runner or exhaust memory.
      const script = `
      const assert = require('node:assert/strict');
      (async () => {
        const mod = ${mode === 'require' ? "require('image-size')" : "await import('image-size')"};
        const imageSize = mod.imageSize;
        const box = (type, length = 8) => { const b = Buffer.alloc(Math.max(length, 8)); b.writeUInt32BE(length); b.write(type, 4); return b; };
        const icns = Buffer.alloc(16); icns.write('icns'); icns.writeUInt32BE(16, 4); icns.write('icp4', 8);
        const heif = box('ftyp', 16); heif.write('heic', 8);
        const jxlHeader = box('JXL ', 12); jxlHeader.set([13, 10, 135, 10], 8);
        const jxlType = box('ftyp', 20); jxlType.write('jxl ', 8);
        const meta = box('meta', 44); const iprp = box('iprp', 32); const ipco = box('ipco', 24);
        box('ispe', 0).copy(ipco, 8); ipco.copy(iprp, 8); iprp.copy(meta, 12);
        for (const data of [icns, Buffer.concat([heif, meta]), Buffer.concat([jxlHeader, jxlType, box('jxlp', 0)])]) {
          assert.throws(() => imageSize(data));
        }
        const good = Buffer.alloc(16); good.write('icns'); good.writeUInt32BE(16, 4); good.write('icp4', 8); good.writeUInt32BE(8, 12);
        assert.equal(imageSize(good).width, 16);
        process.stdout.write('parser fixtures passed');
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `;
      const result = spawnSync(
        process.execPath,
        ['--max-old-space-size=64', '-e', script],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('parser fixtures passed');
    },
    10_000,
  );

  it.each(['require', 'import'])(
    'exports a real PPTX with text, PNG and SVG through the installed %s entry',
    (mode) => {
      const script = `
      const assert = require('node:assert/strict');
      (async () => {
        const Pptx = ${mode === 'require' ? "require('pptxgenjs')" : "(await import('pptxgenjs')).default"};
        const JSZip = require('jszip');
        const pptx = new Pptx(); const slide = pptx.addSlide();
        slide.addText('Otto migration compatibility', { x: 1, y: 1, w: 4, h: 1 });
        slide.addImage({ data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVfoAAAAASUVORK5CYII=', x: 1, y: 2, w: 1, h: 1 });
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
        slide.addImage({ data: 'image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), x: 3, y: 2, w: 1, h: 1 });
        const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
        assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /Otto migration compatibility/);
        assert.ok(Object.keys(zip.files).some(p => p.startsWith('ppt/media/') && p.endsWith('.png')));
        assert.ok(Object.keys(zip.files).some(p => p.startsWith('ppt/media/') && p.endsWith('.svg')));
        assert.ok(!Object.keys(require.cache).some(p => /[\\\\/]image-size[\\\\/]/.test(p)));
        process.stdout.write('PPTX compatibility passed');
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `;
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('PPTX compatibility passed');
    },
    15_000,
  );

  it('fails when a package version or dependency edge changes', async () => {
    const [policy, lock] = await Promise.all([
      readJson(policyPath),
      historicalLock(),
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
    for (const include of ['dev', 'optional', 'peer']) {
      expect(verifier).toContain(`--include=${include}`);
    }
    const ci = await readFile(
      path.join(repoRoot, '.github/workflows/ci.yml'),
      'utf8',
    );
    expect(ci).toContain('name: Enforce live dependency audit before merge');
    expect(ci).toContain('run: npm run security:dependencies:release');
    expect(ci).not.toContain('security:dependencies:release -- --audit-json');
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
