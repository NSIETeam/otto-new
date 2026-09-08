/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  environmentDifferences,
  preparePair,
  verifyPair,
  verifyDependencyCapture,
} from '../prepare-agent-live-pair.mjs';
import {
  freezeBaseline,
  environmentInventory,
  hashEntries,
} from '../agent-eval-baseline.mjs';
import { readSealed, seal, sha } from '../agent-experiment-files.mjs';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
it('seals the actual dirty evaluator and empty slots; rejects slot/identity drift and overwrites', async () => {
  // Sibling of the checkout stays outside source inputs without asking esbuild
  // to inspect restricted ancestors of a Windows user-profile temp directory.
  const testRoot = path.dirname(process.cwd());
  const parent = mkdtempSync(path.join(testRoot, 'otto-pair-registration-'));
  if (
    path.dirname(parent) !== testRoot ||
    !path.basename(parent).startsWith('otto-pair-registration-')
  )
    throw new Error('Unsafe test directory');
  try {
    // Isolated repository: other tasks can legitimately edit the developer tree
    // while this test is running. Copy the real pure grader/gate, not mocks.
    const fixture = path.join(parent, 'repo');
    mkdirSync(fixture);
    const put = (relative, bytes) => {
      mkdirSync(path.dirname(path.join(fixture, relative)), {
        recursive: true,
      });
      writeFileSync(path.join(fixture, relative), bytes);
    };
    put('package.json', '{"name":"fixture","workspaces":[]}');
    put('package-lock.json', '{"lockfileVersion":3,"packages":{}}');
    for (const file of [
      'packages/evals/src/liveEvalGate.ts',
      'packages/evals/src/stage7Comparison.ts',
      'packages/evals/baselines/stage7-real-tasks-v1.json',
      'packages/evals/baselines/stage0-failure-register-v1.json',
    ])
      put(file, readFileSync(file));
    execFileSync('git', ['init', '--quiet'], {
      cwd: fixture,
      windowsHide: true,
    });
    execFileSync('git', ['add', '.'], { cwd: fixture, windowsHide: true });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: fixture, windowsHide: true },
    );
    put('uncommitted.ts', 'export const uncommitted = true;');
    const source = path.join(parent, 'source');
    const frozen = freezeBaseline(fixture, source);
    put('uncommitted.ts', 'export const uncommitted = false;');
    const afterSource = path.join(parent, 'after-source');
    const afterFrozen = freezeBaseline(fixture, afterSource);
    const target = path.join(parent, 'pair');
    const report = await preparePair(
      source,
      afterSource,
      target,
      {},
      { evaluatorWorktree: fixture },
    );
    expect(report.schemaVersion).toBe(3);
    expect(report.identity.beforeSource).toBe(frozen.source.fingerprint);
    expect(report.identity.afterSource).toBe(afterFrozen.source.fingerprint);
    expect(
      readSealed(path.join(target, 'evaluator'), 'manifest').source.files,
    ).toContainEqual(
      expect.objectContaining({ path: 'uncommitted.ts', state: 'untracked' }),
    );
    expect(report.identity.modelDeclaration.ready).toBe(false);
    expect(report.identity.toolProfile.realModelExecutionAdmitted).toBe(false);
    expect(report.blockers).toContain(
      'confined_real_model_pair_executor_not_provisioned',
    );
    expect(report.sourceChanges).toEqual([
      expect.objectContaining({ path: 'uncommitted.ts', change: 'modified' }),
    ]);
    expect(verifyPair(target)).toMatchObject({
      valid: true,
      readyForLive: false,
    });
    await expect(preparePair(source, source, target, {})).rejects.toThrow(
      /overwrite/,
    );
    const slots = readSealed(target, 'run-slots');
    expect(slots.runs).toHaveLength(24);
    expect(
      slots.runs.every((s) => s.status === 'not_run' && s.costUsd === null),
    ).toBe(true);
    const capture = path.join(parent, 'captured');
    mkdirSync(path.join(capture, 'payload'), { recursive: true });
    const content = '{"lockfileVersion":3,"packages":{}}';
    const lockPath = path.join(capture, 'payload/package-lock.json');
    writeFileSync(lockPath, content);
    const environment = environmentInventory(path.join(capture, 'payload'));
    const files = [
      {
        path: 'package-lock.json',
        bytes: Buffer.byteLength(content),
        sha256: sha(content),
      },
    ];
    seal(capture, 'manifest', {
      schemaVersion: 1,
      kind: 'private-dependency-byte-capture',
      files,
      fingerprint: hashEntries(files),
      environment,
    });
    expect(verifyDependencyCapture(capture, environment).fingerprint).toBe(
      hashEntries(files),
    );
    expect(() =>
      verifyDependencyCapture(capture, {
        ...environment,
        lockSha256: 'different',
      }),
    ).toThrow(/environment/);
    writeFileSync(lockPath, content.replace('3', '2'));
    expect(() => verifyDependencyCapture(capture, environment)).toThrow(
      /bytes/,
    );
    // A self-consistent checksum is not enough: the registration is not a result file.
    slots.runs[0].status = 'passed';
    const changed = JSON.stringify(slots);
    writeFileSync(path.join(target, 'run-slots.json'), changed);
    writeFileSync(path.join(target, 'run-slots.sha256'), sha(changed));
    expect(() => verifyPair(target)).toThrow(/slots/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 120000);
it('does not normalize away dependency drift or missing environment metadata', () => {
  const environment = {
    node: '24',
    nodeExecutableSha256: 'a',
    platform: 'win32',
    arch: 'x64',
    osRelease: 'x',
    timeZone: 'UTC',
    cpuModel: 'fixture',
    logicalCpus: 1,
    ramBytes: 1024,
    lockSha256: 'old',
    installed: [],
    missing: [],
  };
  expect(environmentDifferences(environment, { ...environment })).toEqual([]);
  expect(
    environmentDifferences(environment, { ...environment, lockSha256: 'new' }),
  ).toEqual(['lockSha256']);
  expect(environmentDifferences({}, {})).toContain('nodeExecutableSha256');
});
it('rejects relative destinations without executing or creating a campaign', async () => {
  await expect(
    preparePair('relative', 'another', 'output', {}),
  ).rejects.toThrow('Absolute paths');
});
it('the actual live entry refuses missing budget before contacting a provider and does not print a key', async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
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
      OTTO_LIVE_EVAL: '1',
      OTTO_EVAL_API_KEY: 'fixture-private-do-not-print',
      OTTO_EVAL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      OTTO_EVAL_MODEL: 'fixture-2026-09-01',
      OTTO_EVAL_MODEL_REVISION: 'fixture-2026-09-01',
      OTTO_DISABLE_MODEL_HEALTH_CHECK: '1',
      CI: '1',
      NO_COLOR: '1',
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.resolve('node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          'packages/evals/vitest.live.config.ts',
        ],
        {
          cwd: process.cwd(),
          env,
          shell: false,
          windowsHide: true,
          timeout: 30000,
        },
      );
      let output = '';
      child.stdout.on('data', (b) => {
        output = (output + b).slice(-100000);
      });
      child.stderr.on('data', (b) => {
        output = (output + b).slice(-100000);
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(
      'Live evaluation refused before provider access',
    );
    expect(result.output).not.toContain('fixture-private-do-not-print');
    expect(requests).toBe(0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}, 40000);
