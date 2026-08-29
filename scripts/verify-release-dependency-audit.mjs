/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const defaultPolicyPath = path.join(
  repoRoot,
  'config',
  'security',
  'npm-audit-exception-1.9.14.json',
);

export const POLICY_EXPIRES_AT = '2026-09-15T00:00:00Z';
const EXPECTED_ADVISORIES = Object.freeze([
  'GHSA-5p2g-fcmc-qvqq',
  'GHSA-w3rx-r6r6-pgpr',
]);
const EXPECTED_PPTXGENJS_INTEGRITY =
  'sha512-TeJISr8wouAuXw4C1F/mC33xbZs/FuEG6nH9FG1Zj+nuPcGMP5YRHl6X+j3HSUnS1f3at6k75ZZXPMZlA5Lj9A==';
const EXPECTED_IMAGE_SIZE_INTEGRITY =
  'sha512-rH+46sQJ2dlwfjfhCyNx5thzrv+dtmBIhPHk0zgRUukHzZ/kRueTJXoYYsclBaKcSMBWuGbOFXtioLpzTb5euw==';
const EXPECTED_RUNTIME_HASHES = Object.freeze({
  'pptxgen.bundle.js':
    '4fb9eac5cfefb213e2d8743c2b7151025f31bfb3f834c73c12062916daa0f3f8',
  'pptxgen.cjs.js':
    '873d182a8e2e1c0b5e522ef146117936b96b9b2024667bd4c1de59e2b031d27a',
  'pptxgen.es.js':
    '05844c5625e2cda3b449eb967c2246dd57ca57341886a7c28eeebca263b29bd4',
  'pptxgen.min.js':
    '097f0b92e15035a72bba72b59ef1ece62ab45ec6075ac85fe0e2d80d3f59b8e3',
});
const EXPECTED_FORBIDDEN_RUNTIME_TOKENS = Object.freeze(['image-size']);
const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);
const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const SOURCE_SCAN_EXCLUSIONS = new Set([
  'scripts/tests/release-dependency-audit.test.js',
  'scripts/verify-release-dependency-audit.mjs',
]);

function fail(message) {
  throw new Error(`[dependency-audit] ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizedJson(value[key])]),
    );
  }
  return value;
}

function assertExact(actual, expected, label) {
  const actualText = JSON.stringify(normalizedJson(actual));
  const expectedText = JSON.stringify(normalizedJson(expected));
  assert(actualText === expectedText, `${label} changed`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function validateExceptionPolicy(policy, now = new Date()) {
  assert(policy?.schemaVersion === 1, 'policy schemaVersion must remain 1');
  assert(
    policy.policyId === 'otto-1.9.14-image-size-unreachable',
    'unexpected policy id',
  );
  assert(policy.release === '1.9.14', 'policy release must remain 1.9.14');
  assert(
    policy.reviewedAt === '2026-08-29',
    'policy review date changed without gate review',
  );
  assert(
    policy.expiresAt === POLICY_EXPIRES_AT,
    'exception expiry changed without gate review',
  );
  const expiresAt = Date.parse(policy.expiresAt);
  assert(Number.isFinite(expiresAt), 'exception expiry is invalid');
  assert(now.getTime() < expiresAt, `exception expired at ${policy.expiresAt}`);

  const exception = policy.exception;
  assert(exception && typeof exception === 'object', 'exception is missing');
  assertExact(
    exception.advisories.map((advisory) => advisory.id).sort(),
    EXPECTED_ADVISORIES,
    'allowed advisory ids',
  );
  for (const advisory of exception.advisories) {
    assert(advisory.severity === 'high', `${advisory.id} severity changed`);
    assert(
      advisory.affectedRange === '<=2.0.2',
      `${advisory.id} affected range changed`,
    );
    assert(
      advisory.patchedVersion === null,
      `${advisory.id} patched version changed`,
    );
    assert(
      advisory.url === `https://github.com/advisories/${advisory.id}`,
      `${advisory.id} URL changed`,
    );
  }
  assertExact(
    exception.vulnerablePackage,
    {
      name: 'image-size',
      version: '1.2.1',
      lockPath: 'node_modules/image-size',
      integrity: EXPECTED_IMAGE_SIZE_INTEGRITY,
    },
    'image-size policy identity',
  );
  assertExact(
    exception.parentPackage,
    {
      name: 'pptxgenjs',
      version: '4.0.1',
      lockPath: 'node_modules/pptxgenjs',
      dependencySpecifier: '^1.2.1',
      integrity: EXPECTED_PPTXGENJS_INTEGRITY,
    },
    'pptxgenjs policy identity',
  );
  assertExact(
    exception.workspaceConsumers,
    [
      { lockPath: '', dependencySpecifier: '^4.0.1' },
      { lockPath: 'packages/core', dependencySpecifier: '4.0.1' },
    ],
    'workspace pptxgenjs consumers',
  );
  assert(
    exception.installedContract?.browserImageSize === false,
    'pptxgenjs browser image-size barrier changed',
  );
  assertExact(
    exception.installedContract.runtimeFiles,
    EXPECTED_RUNTIME_HASHES,
    'pptxgenjs runtime hashes',
  );
  assertExact(
    exception.installedContract.forbiddenRuntimeTokens,
    EXPECTED_FORBIDDEN_RUNTIME_TOKENS,
    'runtime reachability tokens',
  );
  return exception;
}

function dependencyReferences(packages, dependencyName) {
  const references = [];
  for (const [lockPath, manifest] of Object.entries(packages)) {
    for (const field of DEPENDENCY_FIELDS) {
      if (manifest?.[field]?.[dependencyName] !== undefined) {
        references.push({
          lockPath,
          field,
          specifier: manifest[field][dependencyName],
        });
      }
    }
  }
  return references;
}

export function validateLockfile(lock, exception) {
  assert(
    lock?.lockfileVersion === 3,
    'package-lock must use lockfileVersion 3',
  );
  const packages = lock.packages;
  assert(
    packages && typeof packages === 'object',
    'package-lock packages missing',
  );

  const pptxNodes = Object.keys(packages).filter(
    (lockPath) =>
      lockPath === 'node_modules/pptxgenjs' ||
      lockPath.endsWith('/node_modules/pptxgenjs'),
  );
  const imageSizeNodes = Object.keys(packages).filter(
    (lockPath) =>
      lockPath === 'node_modules/image-size' ||
      lockPath.endsWith('/node_modules/image-size'),
  );
  assertExact(pptxNodes, ['node_modules/pptxgenjs'], 'pptxgenjs lock paths');
  assertExact(
    imageSizeNodes,
    ['node_modules/image-size'],
    'image-size lock paths',
  );

  const pptxNode = packages['node_modules/pptxgenjs'];
  const imageSizeNode = packages['node_modules/image-size'];
  assert(
    pptxNode.version === exception.parentPackage.version &&
      pptxNode.integrity === exception.parentPackage.integrity &&
      pptxNode.dependencies?.['image-size'] ===
        exception.parentPackage.dependencySpecifier,
    'pptxgenjs lock identity or image-size edge changed',
  );
  assert(
    imageSizeNode.version === exception.vulnerablePackage.version &&
      imageSizeNode.integrity === exception.vulnerablePackage.integrity,
    'image-size lock identity changed',
  );

  assertExact(
    dependencyReferences(packages, 'image-size'),
    [
      {
        lockPath: 'node_modules/pptxgenjs',
        field: 'dependencies',
        specifier: '^1.2.1',
      },
    ],
    'image-size dependency path',
  );
  assertExact(
    dependencyReferences(packages, 'pptxgenjs'),
    [
      { lockPath: '', field: 'dependencies', specifier: '^4.0.1' },
      {
        lockPath: 'packages/core',
        field: 'dependencies',
        specifier: '4.0.1',
      },
    ],
    'pptxgenjs workspace dependency path',
  );
}

function containsDependencyKey(value, targetKey) {
  if (!value || typeof value !== 'object') return false;
  if (
    Object.keys(value).some(
      (key) => key === targetKey || key.startsWith(`${targetKey}@`),
    )
  ) {
    return true;
  }
  return Object.values(value).some((nested) =>
    containsDependencyKey(nested, targetKey),
  );
}

export function validateWorkspaceManifests(root, lock) {
  const workspaceLockPaths = Object.keys(lock.packages).filter(
    (lockPath) => !lockPath.includes('node_modules'),
  );
  for (const lockPath of workspaceLockPaths) {
    const manifestPath = path.join(root, lockPath, 'package.json');
    assert(
      existsSync(manifestPath),
      `workspace manifest missing: ${manifestPath}`,
    );
    const manifest = readJson(manifestPath);
    assert(
      !DEPENDENCY_FIELDS.some((field) =>
        Object.entries(manifest[field] ?? {}).some(
          ([name, specifier]) =>
            name === 'image-size' ||
            String(specifier).startsWith('npm:image-size@'),
        ),
      ),
      `workspace directly references image-size: ${lockPath || '.'}`,
    );
    assert(
      !containsDependencyKey(manifest.overrides, 'image-size') &&
        !containsDependencyKey(manifest.resolutions, 'image-size'),
      `workspace override changed image-size resolution: ${lockPath || '.'}`,
    );
  }
}

export function findDirectImageSizeReferences(files) {
  const moduleSpecifier = /(["'`])image-size(?:\/[^"'`]*)?\1/iu;
  return files
    .filter(({ contents }) => moduleSpecifier.test(contents))
    .map(({ filePath }) => filePath)
    .sort();
}

function trackedSourceFiles(root) {
  // CI and local release verification may run under a different OS account
  // from the account that created the isolated worktree. Scope the ownership
  // exception to this exact read-only command instead of mutating global Git
  // configuration.
  const result = spawnSync(
    'git',
    ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'ls-files', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
    },
  );
  assert(
    !result.error && result.status === 0,
    `cannot enumerate tracked source files: ${result.stderr || result.error}`,
  );
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((filePath) => filePath.replaceAll('\\', '/'))
    .filter(
      (filePath) =>
        SOURCE_EXTENSIONS.has(path.posix.extname(filePath)) &&
        !SOURCE_SCAN_EXCLUSIONS.has(filePath),
    )
    .map((filePath) => ({
      filePath,
      contents: readFileSync(path.join(root, filePath), 'utf8'),
    }));
}

export function validateProjectSourceReachability(root) {
  const references = findDirectImageSizeReferences(trackedSourceFiles(root));
  assert(
    references.length === 0,
    `project source directly references image-size: ${references.join(', ')}`,
  );
}

function runtimeJavaScriptFiles(directory, relativeDirectory = '') {
  const files = [];
  for (const entry of readdirSync(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  })) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeJavaScriptFiles(directory, relativePath));
    } else if (
      entry.isFile() &&
      ['.cjs', '.js', '.mjs'].includes(path.posix.extname(entry.name))
    ) {
      files.push(relativePath);
    } else if (entry.isSymbolicLink()) {
      fail(`pptxgenjs dist contains a symbolic link: ${relativePath}`);
    }
  }
  return files.sort();
}

export function validateInstalledReachability(root, exception) {
  const pptxRoot = path.join(root, 'node_modules', 'pptxgenjs');
  const imageSizeRoot = path.join(root, 'node_modules', 'image-size');
  for (const directory of [pptxRoot, imageSizeRoot]) {
    assert(existsSync(directory), `installed dependency missing: ${directory}`);
    assert(
      !lstatSync(directory).isSymbolicLink(),
      `installed dependency must not be a symbolic link: ${directory}`,
    );
  }

  const pptxManifest = readJson(path.join(pptxRoot, 'package.json'));
  const imageSizeManifest = readJson(path.join(imageSizeRoot, 'package.json'));
  assert(
    pptxManifest.version === exception.parentPackage.version &&
      pptxManifest.dependencies?.['image-size'] ===
        exception.parentPackage.dependencySpecifier &&
      pptxManifest.browser?.['image-size'] === false &&
      pptxManifest.main === 'dist/pptxgen.cjs.js' &&
      pptxManifest.module === 'dist/pptxgen.es.js' &&
      pptxManifest.exports?.import === './dist/pptxgen.es.js' &&
      pptxManifest.exports?.require === './dist/pptxgen.cjs.js',
    'installed pptxgenjs identity or browser barrier changed',
  );
  assert(
    imageSizeManifest.version === exception.vulnerablePackage.version,
    'installed image-size version changed',
  );

  const distRoot = path.join(pptxRoot, 'dist');
  assert(existsSync(distRoot), 'installed pptxgenjs dist directory missing');
  const runtimeFiles = runtimeJavaScriptFiles(distRoot);
  assertExact(
    runtimeFiles,
    Object.keys(exception.installedContract.runtimeFiles).sort(),
    'pptxgenjs runtime file set',
  );
  for (const relativePath of runtimeFiles) {
    const contents = readFileSync(path.join(distRoot, relativePath));
    const digest = createHash('sha256').update(contents).digest('hex');
    assert(
      digest === exception.installedContract.runtimeFiles[relativePath],
      `pptxgenjs runtime hash changed: ${relativePath}`,
    );
    const text = contents.toString('utf8');
    for (const token of exception.installedContract.forbiddenRuntimeTokens) {
      assert(
        !text.includes(token),
        `pptxgenjs runtime reached forbidden token ${JSON.stringify(token)} in ${relativePath}`,
      );
    }
  }
}

function advisoryId(via) {
  const match = String(via?.url ?? '').match(
    /github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/iu,
  );
  return match?.[1] ?? null;
}

export function validateAuditReport(report, exception) {
  assert(report?.auditReportVersion === 2, 'npm audit report version changed');
  assert(!report.error, 'npm audit endpoint returned an error');
  assertExact(
    report.metadata?.vulnerabilities,
    { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
    'npm audit severity totals',
  );
  assertExact(
    Object.keys(report.vulnerabilities ?? {}).sort(),
    ['image-size', 'pptxgenjs'],
    'npm high/critical vulnerability package set',
  );

  const imageSize = report.vulnerabilities['image-size'];
  const pptxgenjs = report.vulnerabilities.pptxgenjs;
  assert(
    imageSize.name === 'image-size' &&
      imageSize.severity === 'high' &&
      imageSize.isDirect === false &&
      imageSize.range === '*',
    'image-size audit record changed',
  );
  assertExact(imageSize.nodes, ['node_modules/image-size'], 'image-size nodes');
  assertExact(imageSize.effects, ['pptxgenjs'], 'image-size effects');
  assertExact(
    imageSize.fixAvailable,
    { name: 'pptxgenjs', version: '1.1.5', isSemVerMajor: true },
    'image-size audit remediation',
  );
  assert(
    Array.isArray(imageSize.via) && imageSize.via.length === 2,
    'image-size advisory count changed',
  );
  const advisoryIds = imageSize.via.map(advisoryId).sort();
  assertExact(advisoryIds, EXPECTED_ADVISORIES, 'npm advisory ids');
  for (const via of imageSize.via) {
    const id = advisoryId(via);
    const policyAdvisory = exception.advisories.find(
      (advisory) => advisory.id === id,
    );
    assert(
      via.name === 'image-size' &&
        via.dependency === 'image-size' &&
        via.severity === 'high' &&
        via.range === policyAdvisory?.affectedRange &&
        via.url === policyAdvisory?.url,
      `${id ?? 'unknown advisory'} audit identity changed`,
    );
  }

  assert(
    pptxgenjs.name === 'pptxgenjs' &&
      pptxgenjs.severity === 'high' &&
      pptxgenjs.isDirect === true &&
      pptxgenjs.range === '1.1.5-1 || >=1.1.6',
    'pptxgenjs audit record changed',
  );
  assertExact(pptxgenjs.via, ['image-size'], 'pptxgenjs advisory path');
  assertExact(pptxgenjs.effects, [], 'pptxgenjs effects');
  assertExact(pptxgenjs.nodes, ['node_modules/pptxgenjs'], 'pptxgenjs nodes');
  assertExact(
    pptxgenjs.fixAvailable,
    { name: 'pptxgenjs', version: '1.1.5', isSemVerMajor: true },
    'pptxgenjs audit remediation',
  );
}

export function verifyReleaseDependencyAudit({
  root = repoRoot,
  policy = readJson(defaultPolicyPath),
  auditReport,
  now = new Date(),
} = {}) {
  assert(auditReport, 'npm audit report is required');
  const exception = validateExceptionPolicy(policy, now);
  const lock = readJson(path.join(root, 'package-lock.json'));
  validateLockfile(lock, exception);
  validateWorkspaceManifests(root, lock);
  validateProjectSourceReachability(root);
  validateInstalledReachability(root, exception);
  validateAuditReport(auditReport, exception);
  return {
    policyId: policy.policyId,
    expiresAt: policy.expiresAt,
    advisories: EXPECTED_ADVISORIES,
    dependencyPath: 'pptxgenjs@4.0.1 -> image-size@1.2.1',
  };
}

function runNpmAudit(root) {
  // npm exposes the exact CLI entrypoint while running an npm script. Invoke
  // that JavaScript file through the current Node binary so Windows does not
  // have to execute npm.cmd (which spawnSync rejects with EINVAL when
  // shell:false on supported Node 24 builds). This also keeps the audited
  // command free from shell parsing.
  const npmCli = process.env.npm_execpath?.trim();
  const npmExecutable = npmCli
    ? process.env.npm_node_execpath?.trim() || process.execPath
    : process.platform === 'win32'
      ? 'npm.cmd'
      : 'npm';
  const npmArguments = npmCli
    ? [npmCli, 'audit', '--json', '--registry=https://registry.npmjs.org/']
    : ['audit', '--json', '--registry=https://registry.npmjs.org/'];
  const result = spawnSync(
    npmExecutable,
    npmArguments,
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      shell: false,
    },
  );
  assert(!result.error, `npm audit failed to start: ${result.error}`);
  assert(
    result.status === 0 || result.status === 1,
    `npm audit failed with status ${result.status}: ${result.stderr}`,
  );
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    fail(`npm audit did not return valid JSON: ${error.message}`);
  }
}

function main() {
  const auditJsonIndex = process.argv.indexOf('--audit-json');
  const auditJsonPath =
    auditJsonIndex === -1 ? null : process.argv[auditJsonIndex + 1];
  if (auditJsonIndex !== -1 && !auditJsonPath) {
    fail('--audit-json requires a path');
  }
  if (auditJsonPath && process.env.CI === 'true') {
    fail('CI must use a live npm audit report; --audit-json is forbidden');
  }
  const auditReport = auditJsonPath
    ? readJson(path.resolve(process.cwd(), auditJsonPath))
    : runNpmAudit(repoRoot);
  const result = verifyReleaseDependencyAudit({ auditReport });
  console.log(`[dependency-audit] verified ${JSON.stringify(result)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main();
}
