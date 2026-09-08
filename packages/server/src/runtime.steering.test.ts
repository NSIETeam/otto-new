/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import type { Config } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import type { ServerToClient } from './protocol.js';
import { AgentTurnTracker } from './agentTurnTracker.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it('does not finalize an old draft when steering arrives during async delivery validation', async () => {
  const reached = deferred();
  const release = deferred();
  let count = 0;
  const validation = vi
    .spyOn(AgentTurnTracker.prototype, 'prepareDeliveryEvidence')
    .mockImplementation(async () => {
      if (!count++) {
        reached.resolve();
        await release.promise;
      }
    });
  const store = new InMemorySessionStore();
  const session = store.createSession();
  let rounds = 0;
  const config = {
    initialize: async () => undefined,
    refreshAuth: async () => undefined,
    getModel: () => 'fixture',
    getMaxSessionTurns: () => 4,
    getToolRegistry: async () => ({
      getTool: () => undefined,
      getAllTools: () => [],
      getFunctionDeclarations: () => [],
      discoverMcpTools: async () => undefined,
    }),
    getOttoClient: () => ({
      getChat: async () => ({
        sendMessageStream: async () =>
          (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: rounds++ ? '新的回答' : '已经完成旧任务' }],
                  },
                  finishReason: 'STOP',
                },
              ],
            };
          })(),
      }),
    }),
  } as unknown as Config;
  const runtime = new CoreSessionRuntime(
    store,
    session.sessionId,
    config,
    { log: async () => undefined },
    { recoveryStore: false },
  );
  const frames: ServerToClient[] = [];
  store.subscribe(session.sessionId, (frame) => frames.push(frame));
  try {
    await runtime.initialize();
    const run = runtime.run([{ type: 'text', value: '解释缓存' }], 'local');
    await reached.promise;
    const turnId = store.getHistory(session.sessionId).find((m) => m.turn)!
      .turn!.turnId;
    await runtime.steer({
      version: 1,
      turnId,
      expectedRevision: 1,
      clientMessageId: 'late',
      mode: 'replace',
      text: '解释函数',
    });
    release.resolve();
    await run;
    expect(
      frames
        .filter((f) => f.type === 'chat_complete')
        .some(
          (f) =>
            f.type === 'chat_complete' &&
            f.payload.text?.includes('已经完成旧任务'),
        ),
    ).toBe(false);
    expect(rounds).toBe(2);
  } finally {
    release.resolve();
    runtime.cancel();
    validation.mockRestore();
  }
});

it.each(['stream', 'tool', 'approval'] as const)(
  'applies steering at a %s safe point without starting the old remaining calls',
  async (point) => {
    const reached = deferred();
    const release = deferred();
    const executed: string[] = [];
    const modelInputs: string[] = [];
    let round = 0;
    const tool = {
      name: 'test_tool',
      shouldConfirmExecute: async () =>
        point === 'approval'
          ? {
              type: 'exec',
              title: 'test',
              command: 'test',
              onConfirm: async () => undefined,
            }
          : false,
      execute: async (args: { step: string }) => {
        executed.push(args.step);
        if (point === 'tool') {
          reached.resolve();
          await release.promise;
        }
        return { llmContent: 'done', returnDisplay: 'done' };
      },
    };
    const config = {
      initialize: async () => undefined,
      refreshAuth: async () => undefined,
      getModel: () => 'fixture',
      getMaxSessionTurns: () => 8,
      getToolRegistry: async () => ({
        getTool: () => tool,
        getAllTools: () => [tool],
        getFunctionDeclarations: () => [],
        discoverMcpTools: async () => undefined,
      }),
      getOttoClient: () => ({
        getChat: async () => ({
          sendMessageStream: async (input: unknown) => {
            modelInputs.push(JSON.stringify(input));
            return (async function* () {
              if (!round++) {
                if (point === 'stream') {
                  reached.resolve();
                  await release.promise;
                }
                yield {
                  candidates: [{ content: { parts: [] } }],
                  functionCalls: ['first', 'old-second'].map((step) => ({
                    id: step,
                    name: 'test_tool',
                    args: { step },
                  })),
                };
              } else
                yield {
                  candidates: [
                    {
                      content: { parts: [{ text: '只回答新的问题。' }] },
                      finishReason: 'STOP',
                    },
                  ],
                };
            })();
          },
        }),
      }),
    } as unknown as Config;
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (frame) => {
      frames.push(frame);
      if (frame.type === 'tool_confirmation_request') reached.resolve();
    });
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      { log: async () => undefined },
      { recoveryStore: false },
    );
    await runtime.initialize();
    const running = runtime.run([{ type: 'text', value: '修改文件' }], 'local');
    await Promise.race([
      reached.promise,
      running.then(() => {
        throw new Error('Run ended before test safe point');
      }),
    ]);
    const turn = store.getHistory(session.sessionId).find((m) => m.turn)?.turn;
    const request = {
      version: 1 as const,
      turnId: turn!.turnId,
      expectedRevision: 1,
      clientMessageId: 'steer-1',
      mode: 'replace' as const,
      text: '只解释什么是函数，不修改文件',
    };
    expect((await runtime.steer(request)).status).toBe('accepted');
    expect((await runtime.steer(request)).revision).toBe(2);
    if (point === 'tool')
      expect(
        frames.some(
          (f) => f.type === 'turn_steering' && f.payload.status === 'applied',
        ),
      ).toBe(false);
    runtime.resolveToolConfirmation('first', 'approved'); // late approval must not revive the old operation
    release.resolve();
    await running;
    expect(executed).toEqual(point === 'tool' ? ['first'] : []);
    expect(
      frames.some(
        (f) =>
          f.type === 'turn_steering' &&
          f.payload.status === 'applied' &&
          f.payload.revision === 2,
      ),
    ).toBe(true);
    expect(modelInputs.at(-1)).toContain('只解释什么是函数');
    expect(
      store.getHistory(session.sessionId).find((m) => m.turn)?.turn?.request
        ?.revision,
    ).toBe(2);
  },
);
