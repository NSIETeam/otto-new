/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FileTurnRecoveryStore,
  TurnRecoveryCorruptError,
  classifyRecoveryTool,
  toolExecutionFingerprint,
} from './turnRecoveryStore.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
import { TaskGraphCoordinator } from './taskGraph.js';
import { TaskContinuityLedger } from './taskContinuity.js';
import { TurnConstraintGuard } from './turnConstraints.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let root: string;
let store: FileTurnRecoveryStore;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  root = await mkdtemp(path.join(os.tmpdir(), 'otto-turn-recovery-'));
  store = new FileTurnRecoveryStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FileTurnRecoveryStore', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'preserves the started record while retrying a transient %s replacement',
    async (code) => {
      const record = await store.begin({
        sessionId: 'retry',
        turnId: 'turn',
        intentHash: 'intent',
      });
      const operation = {
        name: 'send_message',
        fingerprint: 'send-once',
        replayClass: 'never_replay' as const,
      };
      await store.recordStarted(record, operation);
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
      vi.mocked(rename)
        .mockClear()
        .mockImplementationOnce(async () => {
          expect((await store.load('retry'))?.tools[0]?.state).toBe('started');
          throw Object.assign(new Error('replacement temporarily busy'), { code });
        })
        .mockImplementation(actual.rename);
      await store.recordSucceeded(record, {
        ...operation,
        resultSummary: 'receipt-1',
      });
      expect(rename).toHaveBeenCalledTimes(2);
      expect((await store.load('retry'))?.tools[0]).toMatchObject({
        state: 'succeeded',
        resultSummary: 'receipt-1',
      });
      expect((await readdir(root)).some((file) => file.endsWith('.tmp'))).toBe(false);
    },
  );

  it.each([
    ['EPERM', 5],
    ['ENOSPC', 1],
  ] as const)(
    'fails closed after bounded %s replacement failure without losing the started record',
    async (code, attempts) => {
      const record = await store.begin({
        sessionId: 'blocked',
        turnId: 'turn',
        intentHash: 'intent',
      });
      const operation = {
        name: 'send_message',
        fingerprint: 'send-once',
        replayClass: 'never_replay' as const,
      };
      await store.recordStarted(record, operation);
      const failure = Object.assign(new Error('replacement failed'), { code });
      vi.mocked(rename).mockClear().mockRejectedValue(failure);
      await expect(store.recordSucceeded(record, operation)).rejects.toBe(failure);
      expect(rename).toHaveBeenCalledTimes(attempts);
      const saved = (await store.load('blocked'))!;
      expect(saved.tools[0]?.state).toBe('started');
      expect(store.decisionForTool(saved, operation).action).toBe('reconcile');
      expect((await readdir(root)).some((file) => file.endsWith('.tmp'))).toBe(false);
    },
  );

  it('persists repair spending across restart and rejects attempts to reset that budget', async () => {
    const record = await store.begin({ sessionId: 'repair', turnId: 'turn', intentHash: 'intent' });
    const ledger = new TaskContinuityLedger('turn', { version: 1, text: '修复登录', source: 'local' });
    const budget = { version: 1 as const, batches: 1, comparisons: 2, formats: 1 };
    await store.recordContinuity(record, ledger.snapshot(), undefined, undefined, undefined, budget);
    const restored = await new FileTurnRecoveryStore(root).load('repair');
    expect(restored?.repairBudget).toEqual(budget);
    await expect(store.recordContinuity(record, ledger.snapshot(), undefined, undefined, undefined, { ...budget, batches: 0 })).rejects.toThrow('cannot decrease');
  });
  it('rejects stale checkpoints, rewritten authority and missing original constraint observations', async () => {
    const record = await store.begin({ sessionId: 'continuity', turnId: 'turn', intentHash: 'intent' });
    const initial = { version: 1 as const, text: '解释代码。不要打开 WPS。', source: 'local' as const };
    const ledger = new TaskContinuityLedger('turn', initial);
    const guard = new TurnConstraintGuard(initial.text, { turnId: 'turn' }); guard.coverageStarted();
    const graph = new TaskGraphCoordinator(deriveTurnControlPolicy({ text: initial.text, source: 'local', toolFree: false }));
    await store.recordContinuity(record, ledger.snapshot(), guard.snapshot(), graph.snapshot());
    const original = ledger.snapshot();
    ledger.accept({ version: 1, turnId: 'turn', expectedRevision: 1, clientMessageId: 'one', text: '补充示例', mode: 'append' });
    await store.recordContinuity(record, ledger.snapshot(), guard.snapshot(), graph.snapshot());
    await expect(store.recordContinuity(record, original)).rejects.toThrow('Stale');
    const tampered = ledger.snapshot(); tampered.initial.text = '打开 WPS';
    await expect(store.recordContinuity(record, tampered)).rejects.toThrow('Stale');
    const saved = await store.load('continuity');
    await writeFile(store.pathForSession('continuity'), JSON.stringify({ ...saved, constraints: { ...saved!.constraints, monitors: [] } }));
    await expect(store.load('continuity')).rejects.toBeInstanceOf(TurnRecoveryCorruptError);
  });
  it('persists only an argument hash and can reuse a completed irreversible result', async () => {
    const record = await store.begin({
      sessionId: 'session-a',
      turnId: 'turn-a',
      intentHash: 'intent-a',
    });
    const fingerprint = toolExecutionFingerprint('send_message', {
      token: 'secret-token-value',
      text: 'hello',
    });
    await store.recordStarted(record, {
      callId: 'call-a',
      name: 'send_message',
      fingerprint,
      replayClass: 'never_replay',
    });
    await store.recordSucceeded(record, {
      callId: 'call-a',
      name: 'send_message',
      fingerprint,
      replayClass: 'never_replay',
      resultSummary: 'message sent receipt-1',
    });

    const recovered = await store.load('session-a');
    expect(recovered?.tools[0]).toMatchObject({
      state: 'succeeded',
      fingerprint,
      resultSummary: 'message sent receipt-1',
    });
    expect(JSON.stringify(recovered)).not.toContain('secret-token-value');
    expect(
      store.decisionForTool(recovered!, {
        name: 'send_message',
        fingerprint,
        replayClass: 'never_replay',
      }),
    ).toMatchObject({
      action: 'reuse',
      resultSummary: 'message sent receipt-1',
    });
  });

  it('marks an interrupted irreversible tool as reconciliation-required and blocks replay', async () => {
    const record = await store.begin({
      sessionId: 'session-b',
      turnId: 'turn-b',
      intentHash: 'intent-b',
    });
    const fingerprint = toolExecutionFingerprint('deploy_service', {
      environment: 'production',
    });
    await store.recordStarted(record, {
      callId: 'call-b',
      name: 'deploy_service',
      fingerprint,
      replayClass: 'never_replay',
    });

    const afterRestart = new FileTurnRecoveryStore(root);
    const recovered = await afterRestart.recoverInterrupted('session-b');
    expect(recovered).toMatchObject({
      status: 'reconciliation_required',
      attempt: 2,
    });
    expect(
      afterRestart.decisionForTool(recovered!, {
        name: 'deploy_service',
        fingerprint,
        replayClass: 'never_replay',
      }),
    ).toMatchObject({ action: 'reconcile' });
  });

  it('replays reads, reuses completed idempotent writes and clears a reconciled turn', async () => {
    expect(classifyRecoveryTool('read_file')).toBe('replayable');
    expect(classifyRecoveryTool('write_file')).toBe('idempotent');
    expect(classifyRecoveryTool('unknown_extension_tool')).toBe('never_replay');

    const record = await store.begin({
      sessionId: 'session-c',
      turnId: 'turn-c',
      intentHash: 'intent-c',
    });
    const readFingerprint = toolExecutionFingerprint('read_file', {
      path: 'a.txt',
    });
    const writeFingerprint = toolExecutionFingerprint('write_file', {
      path: 'a.txt',
    });
    await store.recordSucceeded(record, {
      callId: 'read',
      name: 'read_file',
      fingerprint: readFingerprint,
      replayClass: 'replayable',
      resultSummary: 'read ok',
    });
    await store.recordSucceeded(record, {
      callId: 'write',
      name: 'write_file',
      fingerprint: writeFingerprint,
      replayClass: 'idempotent',
      resultSummary: 'write ok',
    });
    const loaded = (await store.load('session-c'))!;
    expect(
      store.decisionForTool(loaded, {
        name: 'read_file',
        fingerprint: readFingerprint,
        replayClass: 'replayable',
      }).action,
    ).toBe('execute');
    expect(
      store.decisionForTool(loaded, {
        name: 'write_file',
        fingerprint: writeFingerprint,
        replayClass: 'idempotent',
      }).action,
    ).toBe('reuse');

    await store.markReconciliationRequired(loaded, 'operator check required');
    await store.resolve('session-c', 'turn-c', 'confirmed_succeeded');
    expect(await store.load('session-c')).toBeNull();
  });

  it('blocks every new tool while any prior side effect awaits reconciliation', async () => {
    let record = await store.begin({
      sessionId: 'session-blocked',
      turnId: 'turn-blocked',
      intentHash: 'intent-blocked',
    });
    record = await store.markReconciliationRequired(
      record,
      'external result unknown',
    );
    expect(
      store.decisionForTool(record, {
        name: 'read_file',
        fingerprint: toolExecutionFingerprint('read_file', { path: 'a' }),
        replayClass: 'replayable',
      }),
    ).toEqual({ action: 'reconcile', reason: 'external result unknown' });
  });

  it('fails closed on a corrupt recovery record instead of silently replaying work', async () => {
    const record = await store.begin({
      sessionId: 'session-d',
      turnId: 'turn-d',
      intentHash: 'intent-d',
    });
    await writeFile(store.pathForSession(record.sessionId), '{broken', 'utf8');
    await expect(store.load('session-d')).rejects.toBeInstanceOf(
      TurnRecoveryCorruptError,
    );
  });

  it('uses atomic versioned JSON records', async () => {
    await store.begin({
      sessionId: 'session-e',
      turnId: 'turn-e',
      intentHash: 'intent-e',
    });
    const raw = JSON.parse(
      await readFile(store.pathForSession('session-e'), 'utf8'),
    ) as Record<string, unknown>;
    expect(raw).toMatchObject({ version: 1, sessionId: 'session-e' });
  });

  it('persists the task graph so a restarted turn keeps completed evidence', async () => {
    const record = await store.begin({
      sessionId: 'session-graph',
      turnId: 'turn-graph',
      intentHash: 'intent-graph',
    });
    const policy = deriveTurnControlPolicy({
      text: '检查并修改登录代码，然后运行测试',
      source: 'local',
      toolFree: false,
    });
    const graph = new TaskGraphCoordinator(policy);
    graph.observeTools([
      {
        name: 'read_file',
        status: 'success',
        mutating: false,
        verification: false,
        evidenceId: 'read-login-1',
      },
    ]);

    await store.recordTaskGraph(record, graph.snapshot());
    const recovered = await new FileTurnRecoveryStore(root).recoverInterrupted(
      'session-graph',
    );
    const restored = TaskGraphCoordinator.restore(
      policy,
      recovered!.taskGraph!,
    );

    expect(
      restored.snapshot().nodes.find((node) => node.kind === 'gather'),
    ).toMatchObject({
      status: 'completed',
      evidenceIds: ['read-login-1'],
    });
  });
});
