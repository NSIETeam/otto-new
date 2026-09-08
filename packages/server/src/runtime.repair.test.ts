import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import { extractTaskRequirements } from './taskRequirements.js';

it('fails a check, rereads, repairs and retests without another user prompt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-runtime-repair-'));
  try {
    const file = path.join(root, 'login.ts');
    writeFileSync(file, 'original');
    const testSource = path.join(root, 'login.test.cjs');
    writeFileSync(testSource, `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');\n` +
      [0, 1].map(i => `test('case-${i}',()=>assert.equal(fs.readFileSync(${JSON.stringify(file)},'utf8'),'fixed'));`).join('\n'));
    const prompt = '修复登录并运行测试';
    const objective = {
      id: 'login',
      description: prompt,
      sourceQuote: prompt,
      dependsOn: [],
      criteria: extractTaskRequirements(prompt).map((r, i) => ({
        id: `c${i}`,
        description: r.quote,
        requirementQuote: r.quote,
        kind: 'process',
        command: 'npm test',
        directory: root,
        testCase: { name: `case-${i}`, scenario: 'normal' },
        inputFiles: [file, testSource],
      })),
      evidence: [],
    };
    let round = 0;
    let writes = 0;
    let checks = 0;
    const tools = [
      {
        name: 'read_file',
        execute: async () => ({
          llmContent: readFileSync(file, 'utf8'),
          returnDisplay: readFileSync(file, 'utf8'),
        }),
        shouldConfirmExecute: async () => false,
      },
      {
        name: 'replace',
        execute: async () => {
          writes++;
          writeFileSync(file, writes === 1 ? 'broken' : 'fixed');
          return { llmContent: 'edited', returnDisplay: 'edited' };
        },
        shouldConfirmExecute: async () => false,
      },
      {
        name: 'run_shell_command',
        execute: async () => {
          checks++;
          const pass = readFileSync(file, 'utf8') === 'fixed';
          return {
            llmContent: pass ? 'passed' : 'failed',
            returnDisplay: `TAP version 13\n${pass ? 'ok' : 'not ok'} 1 - case-0\n${pass ? 'ok' : 'not ok'} 2 - case-1\n1..2\n`,
            process: {
              command: 'npm test',
              directory: root,
              exitCode: pass ? 0 : 1,
              signal: null,
              status: 'exited',
            },
          };
        },
        shouldConfirmExecute: async () => false,
      },
    ];
    const calls = [
      [
        {
          name: 'update_task_plan',
          id: 'plan',
          args: { expectedRevision: 0, objectives: [objective] },
        },
      ],
      [
        { name: 'read_file', id: 'read', args: { file_path: file } },
        { name: 'replace', id: 'initial-write', args: { file_path: file } },
      ],
      [
        {
          name: 'run_shell_command',
          id: 'failed-test',
          args: { command: 'npm test', directory: root },
        },
      ],
      null,
      [{ name: 'read_file', id: 'fresh-read', args: { file_path: file } }],
      [{ name: 'replace', id: 'repair', args: { file_path: file } }],
      [
        {
          name: 'run_shell_command',
          id: 'passed-test',
          args: { command: 'npm test', directory: root },
        },
      ],
      [
        {
          name: 'update_task_plan',
          id: 'evidence',
          args: {
            expectedRevision: 1,
            objectives: [
              {
                ...objective,
                evidence: objective.criteria.map((c) => ({
                  criterionId: c.id,
                  toolCallId: 'passed-test',
                })),
              },
            ],
          },
        },
      ],
      null,
    ];
    const config = {
      initialize: async () => undefined,
      refreshAuth: async () => undefined,
      getModel: () => 'fixture',
      getMaxSessionTurns: () => 16,
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
              const selected = calls[round++];
              yield selected
                ? {
                    candidates: [{ content: { parts: [] } }],
                    functionCalls: selected,
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
    const session = store.createSession({ workspacePath: root });
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      { log: async () => undefined },
      { recoveryStore: false },
    );
    await runtime.initialize();
    await runtime.run([{ type: 'text', value: prompt }], 'local');
    expect(writes).toBe(2);
    expect(checks).toBe(2);
    expect(round).toBe(9);
    expect(
      store.getHistory(session.sessionId).find((m) => m.turn)?.turn?.status,
      JSON.stringify(store.getHistory(session.sessionId).find(m => m.turn)?.turn?.verification?.checks.filter(c => c.status !== 'passed')),
    ).toBe('completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
