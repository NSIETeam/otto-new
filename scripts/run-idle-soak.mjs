#!/usr/bin/env node
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { RecurringTaskRegistry } from '../packages/core/dist/index.js';

const ORIGINS = ['model', 'sms', 's3', 'kms', 'control', 'email', 'external-http'];

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseConfiguration() {
  const output = valueAfter('--output');
  if (!output || !path.isAbsolute(output)) throw new Error('--output must be an absolute path outside the workspace');
  const relative = path.relative(process.cwd(), output);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('--output must be outside the workspace');
  const testDuration = valueAfter('--test-duration-ms');
  if (testDuration !== undefined) {
    if (process.env.OTTO_IDLE_SOAK_TEST !== '1') throw new Error('short idle soak is restricted to tool self-tests');
    const durationMs = Number(testDuration);
    if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 60_000) {
      throw new Error('--test-duration-ms must be between 100 and 60000');
    }
    return { output, durationMs, requestedHours: null, evidenceKind: 'tool-self-test' };
  }
  const requestedHours = Number(valueAfter('--hours'));
  if (requestedHours !== 24 && requestedHours !== 72) throw new Error('--hours must be exactly 24 or 72');
  return { output, durationMs: requestedHours * 60 * 60_000, requestedHours, evidenceKind: 'wall-clock' };
}

async function writeReport(output, report) {
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

const configuration = parseConfiguration();
const startedAtMs = Date.now();
const intercepted = Object.fromEntries(ORIGINS.map((origin) => [origin, 0]));
const errors = [];
const registry = new RecurringTaskRegistry({
  allowPaidBackground: false,
  onError: (name, error) => errors.push({ name, error: error instanceof Error ? error.message : String(error) }),
});
for (const origin of ORIGINS) {
  registry.register({
    name: `idle-soak-boundary-${origin}`,
    source: 'scripts/run-idle-soak.mjs',
    definitionVersion: 1,
    intervalMs: 60_000,
    estimatedCostUsdPerRun: 0,
    getInputVersion: () => undefined,
    run: async () => { intercepted[origin] += 1; throw new Error(`idle boundary reached: ${origin}`); },
  });
}
const paidRegistration = registry.register({
  name: 'idle-soak-paid-sentinel',
  source: 'scripts/run-idle-soak.mjs',
  definitionVersion: 1,
  intervalMs: 60_000,
  estimatedCostUsdPerRun: 0.01,
  getInputVersion: () => 'must-never-run',
  run: async () => { throw new Error('paid idle task executed'); },
});

let status = 'running';
let taskInventory = [];
const sourceCommit = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
})();
const baseReport = () => ({
  schemaVersion: 1,
  evidenceKind: configuration.evidenceKind,
  scope: 'resident-registry-wall-clock',
  requestedHours: configuration.requestedHours,
  requestedDurationMs: configuration.durationMs,
  startedAt: new Date(startedAtMs).toISOString(),
  observedDurationMs: Date.now() - startedAtMs,
  status,
  sourceCommit,
  host: { platform: process.platform, arch: process.arch, node: process.version, totalMemoryBytes: os.totalmem() },
  paidBackgroundRegistrationBlocked: paidRegistration === undefined,
  registeredTasks: taskInventory,
  intercepted,
  errors,
});
registry.register({
  name: 'idle-soak-local-checkpoint',
  source: 'scripts/run-idle-soak.mjs',
  definitionVersion: 1,
  intervalMs: 60_000,
  estimatedCostUsdPerRun: 0,
  missedRunPolicy: 'skip',
  getInputVersion: () => `minute:${Math.floor((Date.now() - startedAtMs) / 60_000)}`,
  run: () => writeReport(configuration.output, baseReport()),
});
taskInventory = registry.list().map((task) => ({
  name: task.name,
  source: task.source,
  paid: task.paid,
  estimatedCostUsdPerRun: task.estimatedCostUsdPerRun,
}));

let interrupted = false;
let finishWait = () => {};
let waitTimer;
const stopForSignal = async (signal) => {
  if (interrupted) return;
  interrupted = true;
  status = `interrupted:${signal}`;
  registry.stopAll();
  await writeReport(configuration.output, baseReport());
  process.exitCode = 2;
  clearTimeout(waitTimer);
  finishWait();
};
process.once('SIGINT', () => void stopForSignal('SIGINT'));
process.once('SIGTERM', () => void stopForSignal('SIGTERM'));

await new Promise((resolve) => {
  finishWait = resolve;
  waitTimer = setTimeout(resolve, configuration.durationMs);
});
if (!interrupted) {
  registry.stopAll();
  status = Object.values(intercepted).every((count) => count === 0)
    && errors.length === 0
    && paidRegistration === undefined
    ? 'passed'
    : 'failed';
  await writeReport(configuration.output, baseReport());
  if (status !== 'passed') process.exitCode = 1;
  else process.stdout.write(`${configuration.output}\n`);
}
