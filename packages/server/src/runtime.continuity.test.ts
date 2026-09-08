/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import {
  FileTurnRecoveryStore,
  toolExecutionFingerprint,
  turnIntentHash,
} from './turnRecoveryStore.js';
import { TaskContinuityLedger } from './taskContinuity.js';
import { TurnConstraintGuard } from './turnConstraints.js';
import { TaskGraphCoordinator } from './taskGraph.js';
import { deriveTurnControlPolicy } from './turnControlPolicy.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function seed(requestText = '解释缓存。不要打开 WPS。') {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-continuity-'));
  dirs.push(root);
  const store = new InMemorySessionStore();
  const session = store.createSession({ workspacePath: root });
  const disk = new FileTurnRecoveryStore(path.join(root, 'recovery'));
  const record = await disk.begin({
    sessionId: session.sessionId,
    turnId: 'persistent-turn',
    intentHash: turnIntentHash(requestText),
  });
  const ledger = new TaskContinuityLedger(record.turnId, {
    version: 1,
    text: requestText,
    source: 'local',
    workspacePath: root,
  });
  const guard = new TurnConstraintGuard(requestText, {
    turnId: record.turnId,
    workspacePath: root,
  });
  guard.coverageStarted();
  const graph = new TaskGraphCoordinator(
    deriveTurnControlPolicy({
      text: requestText,
      source: 'local',
      toolFree: false,
    }),
  );
  await disk.recordContinuity(
    record,
    ledger.snapshot(),
    guard.snapshot(),
    graph.snapshot(),
  );
  return { root, store, session, disk, record, ledger, guard, graph };
}
function configFor(input: { onModel?: () => Promise<void>; tool?: string }) {
  const calls: string[] = [];
  let round = 0;
  const execute = vi.fn(async () => ({
    llmContent: 'receipt-existing',
    returnDisplay: 'receipt-existing',
  }));
  const tool = {
    name: input.tool ?? 'read_file',
    shouldConfirmExecute: async () => false,
    execute,
  };
  const config = {
    initialize: async () => undefined,
    refreshAuth: async () => undefined,
    getModel: () => 'fixture',
    getMaxSessionTurns: () => 4,
    getToolRegistry: async () => ({
      getTool: () => tool,
      getAllTools: () => [tool],
      getFunctionDeclarations: () => [],
      discoverMcpTools: async () => undefined,
    }),
    getOttoClient: () => ({
      getChat: async () => ({
        getHistory: () => [],
        sendMessageStream: async (messages: unknown) => {
          calls.push(JSON.stringify(messages));
          await input.onModel?.();
          return (async function* () {
            if (!round++ && input.tool)
              yield {
                candidates: [{ content: { parts: [] } }],
                functionCalls: [
                  {
                    id: 'retry',
                    name: input.tool,
                    args: { target: 'test-only' },
                  },
                ],
              };
            else
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: '这是当前问题的解释。' }] },
                    finishReason: 'STOP',
                  },
                ],
              };
          })();
        },
      }),
    }),
  } as unknown as Config;
  return { config, calls, execute };
}
it('applies a durably accepted pending edit before the first model call after restart', async () => {
  const h = await seed();
  h.ledger.accept({
    version: 1,
    turnId: h.record.turnId,
    expectedRevision: 1,
    clientMessageId: 'edit',
    mode: 'replace',
    text: '解释函数。',
  });
  await h.disk.recordContinuity(
    h.record,
    h.ledger.snapshot(),
    h.guard.snapshot(),
    h.graph.snapshot(),
  );
  const f = configFor({
    onModel: async () => {
      const saved = await h.disk.load(h.session.sessionId);
      expect(saved?.continuity?.appliedRevision).toBe(2);
      expect(saved?.taskGraphRequestRevision).toBe(2);
      expect(saved?.supersededGraphs?.length).toBe(1);
    },
  });
  const runtime = new CoreSessionRuntime(
    h.store,
    h.session.sessionId,
    f.config,
    { log: async () => undefined },
    { recoveryStore: h.disk },
  );
  await runtime.initialize();
  await runtime.run([{ type: 'text', value: '继续' }], 'local');
  expect(f.calls.length).toBeGreaterThan(0);
  expect(f.calls[0]).toContain('解释函数');
  expect(f.calls[0]).not.toContain('解释缓存');
  expect(f.calls[0]).toContain('不要打开 WPS');
  expect(h.store.getHistory(h.session.sessionId).filter(m => m.id === 'edit')).toHaveLength(1);
  expect(
    h.store.getHistory(h.session.sessionId).find((m) => m.turn)?.turn?.request
      ?.revision,
  ).toBe(2);
  expect(
    h.store.getHistory(h.session.sessionId).find((m) => m.turn)?.turn?.status,
  ).toBe('completed');
});
it.each(['send_message', 'deploy_service', 'write_file'])(
  'does not replay %s with an unknown outcome after restart',
  async (name) => {
    const h = await seed('检查操作结果');
    await h.disk.recordStarted(h.record, {
      callId: 'before-crash',
      name,
      fingerprint: toolExecutionFingerprint(name, { target: 'test-only' }),
      replayClass: name === 'write_file' ? 'idempotent' : 'never_replay',
    });
    const f = configFor({ tool: name });
    const runtime = new CoreSessionRuntime(
      h.store,
      h.session.sessionId,
      f.config,
      { log: async () => undefined },
      { recoveryStore: h.disk },
    );
    await runtime.initialize();
    await runtime.run([{ type: 'text', value: '继续' }], 'local');
    expect(f.execute).not.toHaveBeenCalled();
    expect((await h.disk.load(h.session.sessionId))?.status).toBe(
      'reconciliation_required',
    );
  },
);
it('reuses a confirmed external receipt without sending again', async () => {
  const h = await seed('检查操作结果');
  const input = {
    callId: 'sent',
    name: 'send_message',
    fingerprint: toolExecutionFingerprint('send_message', {
      target: 'test-only',
    }),
    replayClass: 'never_replay' as const,
  };
  await h.disk.recordStarted(h.record, input);
  await h.disk.recordSucceeded(h.record, {
    ...input,
    resultSummary: 'receipt-existing',
  });
  const f = configFor({ tool: 'send_message' });
  const runtime = new CoreSessionRuntime(
    h.store,
    h.session.sessionId,
    f.config,
    { log: async () => undefined },
    { recoveryStore: h.disk },
  );
  await runtime.initialize();
  await runtime.run([{ type: 'text', value: '继续' }], 'local');
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.calls.some((c) => c.includes('receipt-existing'))).toBe(true);
  expect(f.calls.some((c) => c.includes('originalCallId') && c.includes('sent'))).toBe(true);
});
it('never recaptures a changed preserved file as the new baseline on recovery', async () => {
  const h = await seed();
  const file = path.join(h.root, 'keep.txt');
  writeFileSync(file, 'original');
  const text = `解释文件。保持 \`${file}\` 不变。`;
  const ledger = new TaskContinuityLedger(h.record.turnId, {
    version: 1,
    text,
    source: 'local',
    workspacePath: h.root,
  });
  const guard = new TurnConstraintGuard(text, {
    turnId: h.record.turnId,
    workspacePath: h.root,
  });
  guard.coverageStarted();
  // A separate initial record is intentional: production authority cannot rewrite an existing initial request.
  await h.disk.clear(h.session.sessionId, h.record.turnId);
  const record = await h.disk.begin({
    sessionId: h.session.sessionId,
    turnId: h.record.turnId,
    intentHash: turnIntentHash(text),
  });
  await h.disk.recordContinuity(
    record,
    ledger.snapshot(),
    guard.snapshot(),
    h.graph.snapshot(),
  );
  writeFileSync(file, 'changed outside the running task');
  const f = configFor({});
  const runtime = new CoreSessionRuntime(
    h.store,
    h.session.sessionId,
    f.config,
    { log: async () => undefined },
    { recoveryStore: h.disk },
  );
  await runtime.initialize();
  await runtime.run([{ type: 'text', value: '继续' }], 'local');
  const turn = h.store
    .getHistory(h.session.sessionId)
    .find((m) => m.turn)?.turn;
  expect(turn?.status).not.toBe('completed');
  expect(
    turn?.verification?.checks.some(
      (c) => c.id.startsWith('constraint:') && c.status === 'failed',
    ),
  ).toBe(true);
});
it('rejects remote-source continuation of local authority', async () => {
  const h = await seed();
  const f = configFor({});
  const runtime = new CoreSessionRuntime(
    h.store,
    h.session.sessionId,
    f.config,
    { log: async () => undefined },
    { recoveryStore: h.disk },
  );
  await runtime.initialize();
  await runtime.run([{ type: 'text', value: '继续' }], 'atoa');
  expect(f.calls).toEqual([]);
});

it('resumes a safely paused revision only through a new explicit user continuation', async () => {
  const h = await seed();
  h.ledger.accept({
    version: 1,
    turnId: h.record.turnId,
    expectedRevision: 1,
    clientMessageId: 'pause',
    mode: 'pause',
    text: '先暂停',
  });
  h.ledger.apply();
  await h.disk.recordContinuity(
    h.record,
    h.ledger.snapshot(),
    h.guard.snapshot(),
    h.graph.snapshot(),
  );
  const f = configFor({});
  const runtime = new CoreSessionRuntime(
    h.store,
    h.session.sessionId,
    f.config,
    { log: async () => undefined },
    { recoveryStore: h.disk },
  );
  await runtime.initialize();
  expect(f.calls).toHaveLength(0); // initialize never resumes a model by itself
  await runtime.run([{ type: 'text', value: '继续' }], 'local');
  const turn = h.store
    .getHistory(h.session.sessionId)
    .find((m) => m.turn)?.turn;
  expect(turn?.request?.revision).toBe(3);
  expect(turn?.request?.text).toContain('不要打开 WPS');
  expect(f.calls.length).toBeGreaterThan(0);
});
