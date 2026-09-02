/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

let root: string;
let store: FileTurnRecoveryStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'otto-turn-recovery-'));
  store = new FileTurnRecoveryStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FileTurnRecoveryStore', () => {
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
