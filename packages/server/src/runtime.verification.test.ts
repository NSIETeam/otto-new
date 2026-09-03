/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import type { Config, ToolResult } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import { ToolCallStatus, type ServerToClient } from './protocol.js';

describe('native execution receipt → runtime → completion', () => {
  it.each([
    [0, false],
    [2, false],
    [0, true],
    [2, true],
  ] as const)(
    'uses exit %i rather than success-like stdout (native contract %s)',
    async (exitCode, usePlan) => {
      const makeTool = (name: string, execute: () => Promise<ToolResult>) => ({
        name,
        execute,
        shouldConfirmExecute: async () => false,
      });
      const tools = [
        makeTool('read_file', async () => ({
          llmContent: 'source',
          returnDisplay: 'source',
        })),
        makeTool('replace', async () => ({
          llmContent: 'edited',
          returnDisplay: 'edited',
        })),
        makeTool('run_shell_command', async () => ({
          llmContent: 'all tests passed',
          returnDisplay: 'all tests passed',
          process: {
            command: 'npm test',
            directory: '/repo',
            exitCode,
            signal: null,
            status: 'exited',
          },
        })),
      ];
      const objective = {
        id: 'change',
        description: '修改代码并运行测试',
        sourceQuote: '修改代码并运行测试',
        dependsOn: [],
        criteria: [
          {
            id: 'test',
            description: '回归测试通过',
            kind: 'process',
            command: 'npm test',
            directory: '/repo',
          },
        ],
        evidence: [],
      };
      const calls = [
        ...(usePlan
          ? [
              {
                name: 'update_task_plan',
                id: 'plan-start',
                args: { expectedRevision: 0, objectives: [objective] },
              },
            ]
          : []),
        ...tools.map((tool) => ({
          name: tool.name,
          id: tool.name,
          args:
            tool.name === 'run_shell_command'
              ? { command: 'npm test', directory: '/repo' }
              : {},
        })),
        ...(usePlan
          ? [
              {
                name: 'update_task_plan',
                id: 'plan-evidence',
                args: {
                  expectedRevision: 1,
                  objectives: [
                    {
                      ...objective,
                      evidence: [
                        {
                          criterionId: 'test',
                          toolCallId: 'run_shell_command',
                        },
                      ],
                    },
                  ],
                },
              },
            ]
          : []),
      ];
      let round = 0;
      const config = {
        initialize: async () => undefined,
        refreshAuth: async () => undefined,
        getModel: () => 'test-model',
        getMaxSessionTurns: () => 10,
        getToolRegistry: async () => ({
          getTool: (name: string) => tools.find((tool) => tool.name === name),
          getAllTools: () => tools,
          getFunctionDeclarations: () => [],
          discoverMcpTools: async () => undefined,
        }),
        getOttoClient: () => ({
          getChat: async () => ({
            sendMessageStream: async () =>
              (async function* () {
                const tool = calls[round++];
                if (tool)
                  yield {
                    candidates: [{ content: { parts: [] } }],
                    functionCalls: [tool],
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
      const frames: ServerToClient[] = [];
      store.subscribe(session.sessionId, (frame) => frames.push(frame));
      const runtime = new CoreSessionRuntime(
        store,
        session.sessionId,
        config,
        { log: async () => undefined },
        { recoveryStore: false },
      );
      await runtime.initialize();
      await runtime.run(
        [{ type: 'text', value: '修改代码并运行测试' }],
        'local',
      );
      const history = store.getHistory(session.sessionId);
      expect(
        history
          .filter((message) => message.role === 'assistant')
          .map((message) => message.phase),
      ).toEqual([...calls.map(() => 'commentary'), 'final_answer']);
      expect(
        new Set(
          history
            .filter((message) => message.role === 'assistant')
            .map((message) => message.turnId),
        ).size,
      ).toBe(1);
      const turn = history.find((message) => message.turn)?.turn;
      expect(turn?.status).toBe(exitCode === 0 ? 'completed' : 'incomplete');
      if (usePlan) {
        expect(turn?.taskGraph?.taskContract?.revision).toBe(2);
        expect(
          turn?.verification?.checks.find(
            (check) => check.id === 'objective:change:test',
          )?.status,
        ).toBe(exitCode === 0 ? 'passed' : 'not_run');
      }
      const shell = history
        .flatMap((message) => message.associatedToolCalls ?? [])
        .find((tool) => tool.toolName === 'run_shell_command');
      expect(shell?.result?.process?.exitCode).toBe(exitCode);
      expect(shell?.status).toBe(
        exitCode === 0 ? ToolCallStatus.Success : ToolCallStatus.Error,
      );
      const final = frames
        .filter((frame) => frame.type === 'chat_complete')
        .at(-1);
      expect(
        final?.type === 'chat_complete' &&
          final.payload.text?.includes('尚未完成验收'),
      ).toBe(exitCode !== 0);
    },
  );
});
