/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import type { Config, ToolResult } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import { ToolCallStatus, type ServerToClient } from './protocol.js';
import { extractTaskRequirements } from './taskRequirements.js';
import { receiptTestFixture } from '../test-utils/semanticFixtures.js';
import path from 'node:path';

describe('native execution receipt → runtime → completion', () => {
  it.each([
    [0, false],
    [2, false],
    [0, true],
    [2, true],
  ] as const)(
    'uses exit %i rather than success-like stdout (native contract %s)',
    async (exitCode, usePlan) => {
      const testSource = receiptTestFixture(['change normal', 'runner executes']);
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
          returnDisplay:
            'TAP version 13\nok 1 - change normal\nok 2 - runner executes\n1..2\n',
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
            requirementQuote: '修改代码',
            testCase: { name: 'change normal', scenario: 'normal' },
            inputFiles: [testSource],
          },
          {
            id: 'run',
            description: '执行测试',
            kind: 'process',
            command: 'npm test',
            directory: '/repo',
            requirementQuote: '运行测试',
            testCase: { name: 'runner executes', scenario: 'normal' },
            inputFiles: [testSource],
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
                        { criterionId: 'run', toolCallId: 'run_shell_command' },
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
      const session = store.createSession({ workspacePath: path.dirname(testSource) });
      const frames: ServerToClient[] = [];
      const acceptedAtPublication: boolean[] = [];
      store.subscribe(session.sessionId, (frame) => {
        frames.push(frame);
        if (
          frame.type === 'chat_complete' &&
          frame.payload.text === '已完成。'
        ) {
          acceptedAtPublication.push(
            store.getHistory(session.sessionId).find((m) => m.turn)?.turn
              ?.status === 'completed',
          );
        }
      });
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
      if (exitCode === 0 && usePlan) expect(history.find(m => m.turn)?.turn?.status, JSON.stringify(history.find(m => m.turn)?.turn?.verification?.checks.filter(c => c.status !== 'passed'))).toBe('completed');
      expect(
        history
          .filter((message) => message.role === 'assistant')
          .map((message) => message.phase),
      ).toEqual([
        ...calls.map(() => 'commentary'),
        ...(exitCode || !usePlan ? ['commentary'] : []),
        'final_answer',
      ]);
      expect(
        new Set(
          history
            .filter((message) => message.role === 'assistant')
            .map((message) => message.turnId),
        ).size,
      ).toBe(1);
      const turn = history.find((message) => message.turn)?.turn;
      expect(turn?.status).toBe(
        exitCode === 0 && usePlan ? 'completed' : 'incomplete',
      );
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
      ).toBe(exitCode !== 0 || !usePlan);
      expect(acceptedAtPublication).toEqual(
        exitCode === 0 && usePlan ? [true] : [],
      );
      expect(
        frames.filter((frame) => frame.type === 'chat_chunk'),
      ).toHaveLength(0);
    },
  );
});

describe('finishes missing verification without another user message', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    'runs only permitted closure checks (permission denied: %s, new write: %s)',
    async (denied, extraWrite) => {
      const testSource = receiptTestFixture(['requirement-0', 'requirement-1']);
      let shellCalls = 0;
      let writeCalls = 0;
      let rounds = 0;
      const prompt = '修复登录并运行测试';
      const objective = {
        id: 'login',
        description: prompt,
        sourceQuote: prompt,
        dependsOn: [],
        criteria: extractTaskRequirements(prompt).map((r, i) => ({
          id: `check-${i}`,
          description: r.quote,
          requirementQuote: r.quote,
          testCase: { name: `requirement-${i}`, scenario: 'normal' },
          inputFiles: [testSource],
          kind: 'process',
          command: 'npm test',
          directory: '/repo',
        })),
        evidence: [],
      };
      const tools = [
        {
          name: 'read_file',
          execute: async () => ({
            llmContent: 'source',
            returnDisplay: 'source',
          }),
          shouldConfirmExecute: async () => false,
        },
        {
          name: 'replace',
          execute: async () => {
            if (denied) throw new Error('permission denied');
            writeCalls++;
            return { llmContent: 'edited', returnDisplay: 'edited' };
          },
          shouldConfirmExecute: async () => false,
        },
        {
          name: 'run_shell_command',
          execute: async () => {
            shellCalls++;
            return {
              llmContent: 'passed',
              returnDisplay:
                'TAP version 13\nok 1 - requirement-0\nok 2 - requirement-1\n1..2\n',
              process: {
                command: 'npm test',
                directory: '/repo',
                status: 'exited',
                exitCode: 0,
                signal: null,
              },
            };
          },
          shouldConfirmExecute: async () => false,
        },
      ];
      const sequence = [
        {
          name: 'update_task_plan',
          id: 'plan',
          args: { expectedRevision: 0, objectives: [objective] },
        },
        { name: 'read_file', id: 'read', args: {} },
        { name: 'replace', id: 'write', args: {} },
        null, // premature final; no user has to say "continue"
        {
          name: extraWrite ? 'replace' : 'run_shell_command',
          id: 'test',
          args: { command: 'npm test', directory: '/repo' },
        },
        {
          name: 'update_task_plan',
          id: 'proof',
          args: {
            expectedRevision: 1,
            objectives: [
              {
                ...objective,
                evidence: objective.criteria.map((c) => ({
                  criterionId: c.id,
                  toolCallId: 'test',
                })),
              },
            ],
          },
        },
        null,
      ];
      const config = {
        initialize: async () => undefined,
        refreshAuth: async () => undefined,
        getModel: () => 'test-model',
        getMaxSessionTurns: () => 10,
        getToolRegistry: async () => ({
          getTool: (name: string) => tools.find((t) => t.name === name),
          getAllTools: () => tools,
          getFunctionDeclarations: () => [],
          discoverMcpTools: async () => undefined,
        }),
        getOttoClient: () => ({
          getChat: async () => ({
            sendMessageStream: async () =>
              (async function* () {
                const call = sequence[rounds++];
                yield call
                  ? {
                      candidates: [{ content: { parts: [] } }],
                      functionCalls: [call],
                    }
                  : {
                      candidates: [
                        {
                          content: { parts: [{ text: '全部完成。' }] },
                          finishReason: 'STOP',
                        },
                      ],
                    };
              })(),
          }),
        }),
      } as unknown as Config;
      const store = new InMemorySessionStore();
      const session = store.createSession({ workspacePath: path.dirname(testSource) });
      const logged: boolean[] = [];
      const runtime = new CoreSessionRuntime(
        store,
        session.sessionId,
        config,
        {
          log: async (entry) => {
            logged.push(entry.success);
          },
        },
        { recoveryStore: false },
      );
      await runtime.initialize();
      await runtime.run([{ type: 'text', value: prompt }], 'local');
      const history = store.getHistory(session.sessionId);
      expect(shellCalls).toBe(denied || extraWrite ? 0 : 1);
      expect(writeCalls).toBe(denied ? 0 : 1);
      expect(rounds).toBe(denied ? 4 : 7);
      expect(history.find((m) => m.turn)?.turn?.status).toBe(
        denied || extraWrite ? 'incomplete' : 'completed',
      );
      const finals = history.filter((m) => m.phase === 'final_answer');
      expect(finals).toHaveLength(1);
      expect(JSON.stringify(finals[0].content).includes('全部完成')).toBe(
        !denied && !extraWrite,
      );
      expect(logged).toEqual([!denied && !extraWrite]);
    },
  );
});
