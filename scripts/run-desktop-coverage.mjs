#!/usr/bin/env node
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCoverageBaseline,
  sourceInventory,
  verifyDesktopCoverageRatchet,
} from './verify-desktop-coverage-ratchet.mjs';

const ownRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const harnessFiles = [
  'run-desktop-coverage.mjs',
  'verify-desktop-coverage-ratchet.mjs',
].map((name) => path.join(ownRoot, 'scripts', name));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (message) => {
  throw new Error(`[desktop-coverage-runner] ${message}`);
};

function regular(file, maxBytes = 64 * 1024 * 1024) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    fail('input must be a bounded regular file');
  return readFileSync(file);
}

function safeDirectory(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`))
    fail('directory outside intended root');
  let current = path.resolve(root);
  const rootStat = lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    fail('directory root is redirected or not regular');
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('directory is redirected or not regular');
  }
  return target;
}

function environment(root) {
  const version = (dep) =>
    JSON.parse(regular(path.join(root, 'node_modules', dep, 'package.json')))
      .version;
  const actual = {
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    vitest: version('vitest'),
    coverageV8: version('@vitest/coverage-v8'),
    mapper: 'ast',
    configSha256: sha(
      regular(path.join(root, 'packages/desktop/vitest.config.ts')),
    ),
    lockSha256: sha(regular(path.join(root, 'package-lock.json'))),
  };
  if (
    actual.nodeMajor !== 22 ||
    !['win32', 'darwin', 'linux'].includes(actual.platform) ||
    !['x64', 'arm64'].includes(actual.arch) ||
    !/^4\./.test(actual.vitest) ||
    actual.vitest !== actual.coverageV8
  )
    fail('unsupported actual platform, Node or coverage toolchain');
  return actual;
}

function inputHashes(inventory) {
  return Object.fromEntries(
    Object.entries({ ...inventory.sources, ...inventory.tests }).map(
      ([file, code]) => [file, sha(code)],
    ),
  );
}

function supportingHashes(desktop, inventory) {
  const result = {};
  const known = { ...inventory.sources, ...inventory.tests };
  function visit(relative) {
    const file = path.join(desktop, relative);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) fail('supporting input is redirected');
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(`${relative}/${name}`);
    } else if (!Object.hasOwn(known, relative))
      result[relative] = sha(regular(file));
  }
  // All remaining src inputs include test setup, declarations, CSS and images.
  // Scripts/resources are bound without including generated dist or coverage.
  for (const dir of ['src', 'scripts', 'resources', 'assets']) {
    if (existsSync(path.join(desktop, dir))) visit(dir);
  }
  for (const name of [
    'package.json',
    'tsconfig.json',
    'tsconfig.main.json',
    'tsconfig.preload.json',
    'tsconfig.renderer.json',
  ]) {
    if (existsSync(path.join(desktop, name)))
      result[name] = sha(regular(path.join(desktop, name)));
  }
  return result;
}

function sameHashes(before, after) {
  const entries = (value) =>
    JSON.stringify(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    );
  return entries(before) === entries(after);
}

function checkLatest(file) {
  if (!existsSync(file)) return;
  let value;
  try {
    value = JSON.parse(regular(file, 16 * 1024));
  } catch {
    fail('latest index is not a runner-owned regular file');
  }
  if (
    value?.kind !== 'otto-desktop-coverage-run-pointer' ||
    value.schemaVersion !== 1 ||
    !uuidPattern.test(value.runId) ||
    value.receipt !== `desktop-runs/${value.runId}/receipt.json`
  )
    fail('latest index is not runner-owned');
}

function updateLatest(file, receipt) {
  checkLatest(file);
  const temporary = `${file}.${receipt.runId}.tmp`;
  const value = {
    kind: 'otto-desktop-coverage-run-pointer',
    schemaVersion: 1,
    runId: receipt.runId,
    receipt: `desktop-runs/${receipt.runId}/receipt.json`,
    exitCode: receipt.exitCode,
    gate: receipt.gate.status,
  };
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  // Only this explicitly validated managed index is replaced, never old runs.
  checkLatest(file);
  renameSync(temporary, file);
}

function isolatedEnvironment(directory) {
  const env = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'NUMBER_OF_PROCESSORS',
  ])
    if (process.env[key]) env[key] = process.env[key];
  const systemPaths =
    process.platform === 'win32'
      ? [
          path.join(process.env.SystemRoot || 'C:/Windows', 'System32'),
          process.env.SystemRoot || 'C:/Windows',
          'C:/Program Files/Git/cmd',
          'D:/git/cmd',
        ]
      : [
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
          '/usr/local/bin',
          '/opt/homebrew/bin',
        ];
  env.PATH = [path.dirname(process.execPath), ...systemPaths].join(
    path.delimiter,
  );
  env.HOME = env.USERPROFILE = safeDirectory(directory, 'isolated-home');
  env.APPDATA = safeDirectory(directory, 'isolated-home/appdata');
  env.LOCALAPPDATA = safeDirectory(directory, 'isolated-home/localappdata');
  env.TEMP = env.TMP = env.TMPDIR = safeDirectory(directory, 'isolated-temp');
  env.OTTO_USER_DIR = safeDirectory(directory, 'isolated-home/otto-user');
  env.NODE_ENV = 'test';
  env.CI = 'true';
  env.npm_config_update_notifier = 'false';
  return env;
}

async function execute(executable, args, cwd, env, directory) {
  const descriptors = [];
  let spawnError = null;
  try {
    for (const name of ['stdout.txt', 'stderr.txt'])
      descriptors.push(openSync(path.join(directory, name), 'wx', 0o600));
    // Direct file descriptors avoid pipe backpressure and stream-finish races.
    // Only the exact child is observed; no shell or unrelated process controls.
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', ...descriptors],
    });
    child.once('error', (error) => {
      spawnError = error.message;
    });
    const [exitCode, signal] = await new Promise((resolve) =>
      child.once('close', (...result) => resolve(result)),
    );
    return { exitCode, signal, spawnError };
  } catch (error) {
    return { exitCode: null, signal: null, spawnError: error.message };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}

/** Programmatic root parameter is for native runner fixture tests only.
 * The user-facing CLI accepts no arguments and always uses this checkout. */
export async function runDesktopCoverage({
  projectRoot = ownRoot,
  platform = process.platform,
} = {}) {
  if (
    platform !== process.platform ||
    !['win32', 'darwin', 'linux'].includes(platform)
  )
    fail('unsupported actual platform');
  const root = path.resolve(projectRoot);
  const desktop = path.join(root, 'packages/desktop');
  const beforeEnvironment = environment(root);
  const executable = process.execPath;
  const tool = path.join(root, 'node_modules/vitest/vitest.mjs');
  const toolSha256 = sha(regular(tool));
  const harnessHashesBefore = Object.fromEntries(
    harnessFiles.map((file) => [path.basename(file), sha(regular(file))]),
  );
  const executableSha256 = sha(regular(executable, 160 * 1024 * 1024));
  for (const component of [root, path.join(root, 'packages'), desktop]) {
    const stat = lstatSync(component);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('checkout directory is redirected or not regular');
  }
  const coverageRoot = safeDirectory(desktop, 'coverage');
  const latest = path.join(coverageRoot, 'desktop-coverage-latest.json');
  checkLatest(latest);
  safeDirectory(coverageRoot, 'desktop-runs');
  const runId = randomUUID();
  const directory = safeDirectory(coverageRoot, `desktop-runs/${runId}`);
  const reports = safeDirectory(directory, 'coverage');
  const resultFile = path.join(directory, 'test-results.json');
  const coverageFile = path.join(reports, 'coverage-final.json');
  const baseline = path.join(
    root,
    'config/test-baselines/desktop',
    `${process.platform}-${process.arch}-node22-vitest4.json.gz`,
  );
  const baselineSha256 = existsSync(baseline)
    ? sha(regular(baseline, 4 * 1024 * 1024))
    : null;
  const before = sourceInventory(desktop);
  const supportingHashesBefore = supportingHashes(desktop, before);
  const args = [
    tool,
    'run',
    '--coverage',
    '--maxWorkers=2',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${resultFile}`,
    `--coverage.reportsDirectory=${reports}`,
  ];
  const startedAt = new Date().toISOString();
  console.log(`[desktop-coverage-runner] native run ${runId}`);
  const native = await execute(
    executable,
    args,
    desktop,
    isolatedEnvironment(directory),
    directory,
  );
  const receipt = {
    schemaVersion: 1,
    runId,
    ...native,
    startedAt,
    finishedAt: new Date().toISOString(),
    executable,
    executableSha256,
    toolSha256,
    baselineSha256,
    args,
    cwd: desktop,
    harnessHashesBefore,
    harnessHashesAfter: null,
    environment: beforeEnvironment,
    environmentAfter: null,
    sourceHashesBefore: inputHashes(before),
    sourceHashesAfter: null,
    supportingHashesBefore,
    supportingHashesAfter: null,
    reportHashes: { coverage: null, tests: null },
    gate: {
      status: 'not-run',
      reason: 'native process did not exit successfully',
    },
  };
  let after;
  let coverageBytes;
  let testBytes;
  try {
    after = sourceInventory(desktop);
    receipt.sourceHashesAfter = inputHashes(after);
    receipt.supportingHashesAfter = supportingHashes(desktop, after);
    receipt.environmentAfter = environment(root);
    receipt.harnessHashesAfter = Object.fromEntries(
      harnessFiles.map((file) => [path.basename(file), sha(regular(file))]),
    );
    // Recheck each managed ancestor after the child, before reading any report.
    safeDirectory(desktop, `coverage/desktop-runs/${runId}/coverage`);
    if (existsSync(coverageFile)) {
      coverageBytes = regular(coverageFile);
      receipt.reportHashes.coverage = sha(coverageBytes);
    }
    if (existsSync(resultFile)) {
      testBytes = regular(resultFile);
      receipt.reportHashes.tests = sha(testBytes);
    }
    if (native.exitCode === 0 && !native.signal && !native.spawnError) {
      receipt.gate = {
        status: 'failed',
        reason: 'verification did not complete',
      };
      if (!coverageBytes || !testBytes)
        fail('current execution is missing its raw report');
      if (
        !sameHashes(receipt.sourceHashesBefore, receipt.sourceHashesAfter) ||
        !sameHashes(
          receipt.supportingHashesBefore,
          receipt.supportingHashesAfter,
        ) ||
        !sameHashes(receipt.environment, receipt.environmentAfter)
      )
        fail(
          'source, test, supporting input or execution environment changed during run',
        );
      if (
        toolSha256 !== sha(regular(tool)) ||
        executableSha256 !== sha(regular(executable, 160 * 1024 * 1024))
      )
        fail('native toolchain changed during run');
      if (!sameHashes(receipt.harnessHashesBefore, receipt.harnessHashesAfter))
        fail('execution harness changed during run');
      if (!baselineSha256 || !existsSync(baseline))
        fail('reviewed platform baseline is missing');
      if (baselineSha256 !== sha(regular(baseline, 4 * 1024 * 1024)))
        fail('reviewed platform baseline changed during run');
      const result = verifyDesktopCoverageRatchet({
        root: desktop,
        ...after,
        environment: receipt.environmentAfter,
        baseline: readCoverageBaseline(baseline),
        coverage: JSON.parse(coverageBytes),
        testResults: JSON.parse(testBytes),
        reportHashes: receipt.reportHashes,
        receipt,
      });
      receipt.gate = { status: 'passed', result };
    }
  } catch (error) {
    if (native.exitCode === 0)
      receipt.gate = { status: 'failed', reason: error.message };
    else receipt.observationError = error.message;
  }
  writeFileSync(
    path.join(directory, 'receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  updateLatest(latest, receipt);
  const code =
    receipt.gate.status === 'passed' && native.exitCode === 0 ? 0 : 1;
  console.log(
    `[desktop-coverage-runner] ${JSON.stringify({ runId, directory, exitCode: native.exitCode, gate: receipt.gate.status, code })}`,
  );
  return { code, directory, receipt };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2) {
    console.error('[desktop-coverage-runner] does not accept arguments');
    process.exitCode = 1;
  } else
    runDesktopCoverage()
      .then((result) => {
        process.exitCode = result.code;
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
