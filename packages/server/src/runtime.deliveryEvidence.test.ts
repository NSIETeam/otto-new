/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import type { Config } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';

it.each([false, true])(
  'applies a failure gate before the next serial call in the SAME batch (unrelated success: %s)',
  async (unrelated) => {
    const executions: string[] = [];
    let round = 0;
    const tools = [
      {
        name: 'run_shell_command',
        shouldConfirmExecute: async () => false,
        execute: async (args: { command: string }) => {
          executions.push(args.command);
          if (args.command === 'bad') throw new Error('400 invalid input');
          return { llmContent: args.command, returnDisplay: args.command };
        },
      },
    ];
    const config = {
      initialize: async () => undefined,
      refreshAuth: async () => undefined,
      getModel: () => 'fixture',
      getMaxSessionTurns: () => 5,
      getToolRegistry: async () => ({
        getTool: () => tools[0],
        getAllTools: () => tools,
        getFunctionDeclarations: () => [],
        discoverMcpTools: async () => undefined,
      }),
      getOttoClient: () => ({
        getChat: async () => ({
          sendMessageStream: async () =>
            (async function* () {
              if (!round++)
                yield {
                  candidates: [{ content: { parts: [] } }],
                  functionCalls: [
                    'bad',
                    ...(unrelated ? ['other'] : []),
                    'bad',
                  ].map((command, i) => ({
                    name: 'run_shell_command',
                    id: `call-${i}`,
                    args: { command },
                  })),
                };
              else
                yield {
                  candidates: [
                    {
                      content: { parts: [{ text: '已完成。' }] },
                      finishReason: 'STOP',
                    },
                  ],
                };
            })(),
        }),
      }),
    } as unknown as Config;
    const store = new InMemorySessionStore();
    const session = store.createSession();
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      { log: async () => undefined },
      { recoveryStore: false },
    );
    await runtime.initialize();
    await runtime.run([{ type: 'text', value: '修改代码并运行测试' }], 'local');
    expect(executions.filter((c) => c === 'bad')).toHaveLength(1);
    if (unrelated) expect(executions).toContain('other');
    const turn = store.getHistory(session.sessionId).find((m) => m.turn)?.turn;
    expect(turn?.status).not.toBe('completed');
    expect(turn?.adaptations).toHaveLength(1);
  },
);
