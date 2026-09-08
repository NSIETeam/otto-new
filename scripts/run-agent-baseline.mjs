#!/usr/bin/env node
/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
 * Restore into a disposable workspace; run fixed offline source tests only.
 * Does not mutate the frozen source, install dependencies or launch the user's app.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  environmentInventory,
  verifyBaseline,
} from './agent-eval-baseline.mjs';

export function summarizeVitestReport(report) {
  if (!report || !Array.isArray(report.testResults))
    return {
      status: 'no_valid_report',
      passed: 0,
      failed: 0,
      skipped: 0,
      suites: [],
    };
  const suites = report.testResults.map((suite) => ({
    name: suite.name,
    status: suite.status,
    message: suite.message || null,
    assertions: (suite.assertionResults ?? []).map((a) => ({
      name: a.fullName ?? a.title,
      status: a.status,
      failures: (a.failureMessages ?? []).map(String),
    })),
  }));
  const all = suites.flatMap((s) => s.assertions);
  return {
    status: report.success === true && all.length > 0 ? 'passed' : 'failed',
    passed: all.filter((a) => a.status === 'passed').length,
    failed: all.filter((a) => a.status === 'failed').length,
    skipped: all.filter((a) => !['passed', 'failed'].includes(a.status)).length,
    failedSuites: suites.filter((s) => s.status === 'failed').length,
    suites,
  };
}
export async function runBaseline(snapshot, dependencies) {
  snapshot = path.resolve(snapshot);
  dependencies = path.resolve(dependencies);
  const check = verifyBaseline(snapshot);
  if (!check.valid)
    throw new Error('Frozen source integrity failed; refusing execution');
  const manifest = JSON.parse(
    readFileSync(path.join(snapshot, 'manifest.json'), 'utf8'),
  );
  const environment = environmentInventory(dependencies);
  for (const key of [
    'node',
    'nodeExecutableSha256',
    'platform',
    'arch',
    'osRelease',
    'timeZone',
    'lockSha256',
    'installed',
    'missing',
  ]) {
    if (
      JSON.stringify(environment[key]) !==
      JSON.stringify(manifest.environment[key])
    )
      throw new Error(`Dependency/runtime condition changed: ${key}`);
  }
  const vitest = path.join(dependencies, 'node_modules/vitest/vitest.mjs');
  if (!existsSync(vitest))
    throw new Error('Local Vitest missing; no automatic install');
  mkdirSync(path.join(snapshot, 'runs'), { recursive: true });
  const run = mkdtempSync(path.join(snapshot, 'runs/offline-'));
  const workspace = path.join(run, 'workspace'),
    output = path.join(run, 'results');
  mkdirSync(workspace);
  mkdirSync(output);
  for (const entry of manifest.source.files) {
    const target = path.join(workspace, entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(snapshot, 'source', entry.path), target);
  }
  // Only third-party dependencies are reused. The fixed test config aliases all
  // workspace packages to restored TS source, never another checkout's dist.
  symlinkSync(
    path.join(dependencies, 'node_modules'),
    path.join(workspace, 'node_modules'),
    'junction',
  );
  // npm also installs non-hoisted versions under individual workspace packages.
  const workspaces =
    JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'))
      .workspaces ?? [];
  for (const relative of workspaces) {
    if (
      typeof relative !== 'string' ||
      !/^[a-zA-Z0-9_/-]+$/.test(relative) ||
      relative.includes('..') ||
      path.isAbsolute(relative)
    )
      throw new Error(
        'Explicit safe workspace paths required for dependency restoration',
      );
    const installed = path.join(dependencies, relative, 'node_modules');
    if (existsSync(installed))
      symlinkSync(
        installed,
        path.join(workspace, relative, 'node_modules'),
        'junction',
      );
  }
  const env = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'PATH',
    'Path',
    'TEMP',
    'TMP',
    'PATHEXT',
  ])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    OTTO_USER_DIR: path.join(run, 'profile'),
    OTTO_BASELINE_OUTPUT: output,
    OTTO_LIVE_EVAL: '0',
    OTTO_DISABLE_MODEL_HEALTH_CHECK: '1',
    NO_COLOR: '1',
    CI: '1',
  });
  const reportFile = path.join(output, 'vitest.json');
  const args = [
    vitest,
    'run',
    '--config',
    'scripts/agent-baseline.vitest.config.mjs',
    '--reporter=json',
    `--outputFile=${reportFile}`,
  ];
  const started = Date.now();
  const execution = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env,
      shell: false,
      windowsHide: true,
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        // Only the owned test-process tree; never search/kill other Otto processes.
        const cleanup = spawn(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, shell: false, stdio: 'ignore' },
        );
        cleanup.once('error', () => child.kill());
      } else child.kill();
    }, 240000);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-500000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-500000);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut,
        stdout,
        stderr,
        error: 'runner_spawn_failed',
      });
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
  writeFileSync(path.join(output, 'stdout.log'), execution.stdout, {
    flag: 'wx',
  });
  writeFileSync(path.join(output, 'stderr.log'), execution.stderr, {
    flag: 'wx',
  });
  let raw;
  try {
    raw = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch {
    /* Explicitly unknown, never success. */
  }
  const summary = summarizeVitestReport(raw);
  const sourceUnchanged = manifest.source.files.every((entry) => {
    try {
      return (
        createHash('sha256')
          .update(readFileSync(path.join(workspace, entry.path)))
          .digest('hex') === entry.sha256
      );
    } catch {
      return false;
    }
  });
  const frozenUnchanged = verifyBaseline(snapshot).valid;
  const result = {
    schemaVersion: 1,
    kind: 'offline_source_regression_and_scripted_provider',
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    sourceFingerprint: manifest.source.fingerprint,
    harnessFingerprint: manifest.identities?.harnessFingerprint ?? null,
    runnerSha256: createHash('sha256')
      .update(readFileSync(new URL(import.meta.url)))
      .digest('hex'),
    command: [process.execPath, ...args],
    cwd: workspace,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    sourceUnchanged,
    frozenUnchanged,
    passed:
      execution.exitCode === 0 &&
      !execution.timedOut &&
      sourceUnchanged &&
      frozenUnchanged &&
      summary.status === 'passed',
    modelCallsPaid: 0,
    realModelScore: null,
    summary,
    limitations: [
      'Scripted loopback provider proves runtime wiring only; no real-model quality score.',
      'Third-party dependencies reused after metadata check, not rebuilt or fully byte-hashed.',
      'No Electron GUI, real WPS launch or production server exercised.',
      'Source profile excludes generated JavaScript and aliases workspace package imports to frozen TypeScript.',
    ],
  };
  writeFileSync(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' },
  );
  return { resultFile: path.join(output, 'result.json'), ...result };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [snapshot, dependencies] = process.argv.slice(2);
    if (
      !snapshot ||
      !dependencies ||
      !path.isAbsolute(snapshot) ||
      !path.isAbsolute(dependencies)
    )
      throw new Error(
        'Usage: node scripts/run-agent-baseline.mjs ABSOLUTE_SNAPSHOT ABSOLUTE_DEPENDENCY_WORKTREE',
      );
    const result = await runBaseline(snapshot, dependencies);
    console.log(
      JSON.stringify(
        {
          resultFile: result.resultFile,
          sourceFingerprint: result.sourceFingerprint,
          passed: result.passed,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          tests: {
            passed: result.summary.passed,
            failed: result.summary.failed,
            skipped: result.summary.skipped,
            failedSuites: result.summary.failedSuites ?? null,
          },
          modelCallsPaid: 0,
        },
        null,
        2,
      ),
    );
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
