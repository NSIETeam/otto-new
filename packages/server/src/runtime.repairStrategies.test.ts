import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import { extractTaskRequirements } from './taskRequirements.js';
import { FileTurnRecoveryStore } from './turnRecoveryStore.js';

it.each([
  'pass',
  'skip-retest',
  'stale-after-test',
  'assertion-403',
  'assertion-404',
  'recovery-requires-review',
])('multi-file repair requires current revalidation: %s', async (mode) => {
  const root = mkdtempSync(path.join(tmpdir(), 'otto-runtime-repair-'));
  try {
    const file = path.join(root, 'login.ts');
    writeFileSync(file, 'original');
    const helper = path.join(root, 'helper.ts');
    const regression = path.join(root, 'login.test.ts');
    writeFileSync(helper, 'export const value=0;');
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
        inputFiles: [file, helper, regression],
      })),
      evidence: [],
    };
    let round = 0;
    let writes = 0;
    let checks = 0;
    const tools = [
      {
        name: 'write_file',
        shouldConfirmExecute: async () => false,
        execute: async (args: { file_path: string; content: string }) => {
          writes++;
          writeFileSync(args.file_path, args.content);
          return { llmContent: 'written', returnDisplay: 'written' };
        },
      },
      {
        name: 'read_file',
        execute: async () => ({
          llmContent: 'read',
          returnDisplay: 'read',
        }),
        shouldConfirmExecute: async () => false,
      },
      {
        name: 'replace',
        execute: async (args: { file_path: string }) => {
          writes++;
          writeFileSync(
            args.file_path,
            writes === 1
              ? "import { value } from './helper.js'; export const login=value;"
              : 'fixed',
          );
          return { llmContent: 'edited', returnDisplay: 'edited' };
        },
        shouldConfirmExecute: async () => false,
      },
      {
        name: 'run_shell_command',
        execute: async () => {
          checks++;
          const pass =
            readFileSync(file, 'utf8') === 'fixed' &&
            readFileSync(helper, 'utf8') === 'fixed' &&
            readFileSync(regression, 'utf8').includes('test');
          if (pass && mode === 'stale-after-test')
            writeFileSync(helper, 'concurrent modification after test');
          return {
            llmContent: pass
              ? 'passed'
              : mode.startsWith('assertion-')
                ? `AssertionError: expected ${mode.slice(10)} forbidden, received 200`
                : 'failed',
            returnDisplay: `TAP version 13\n${pass ? 'ok' : 'not ok'} 1 - case-0\n${pass ? 'ok' : 'not ok'} 2 - case-1\n1..2\n`,
            process: {
              command: 'npm test',
              directory: root,
              exitCode: pass
                ? 0
                : mode.startsWith('assertion-')
                  ? Number(mode.slice(10))
                  : 1,
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
        { name: 'read_file', id: 'read-helper', args: { file_path: helper } },
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
      [
        { name: 'read_file', id: 'fresh-read', args: { file_path: file } },
        {
          name: 'read_file',
          id: 'fresh-helper',
          args: { file_path: helper },
        },
      ],
      [
        {
          name: 'plan_delivery_repair',
          id: 'repair-plan',
          args: {
            requestRevision: 1,
            failedToolCallId: 'failed-test',
            alternatives: [
              {
                id: 'local-fix',
                reason: 'Repair observed connected inputs and add regression',
                files: [file, helper, regression],
              },
            ],
          },
        },
      ],
      [
        { name: 'replace', id: 'repair', args: { file_path: file } },
        { name: 'replace', id: 'repair-helper', args: { file_path: helper } },
        {
          name: 'write_file',
          id: 'regression',
          args: {
            file_path: regression,
            content:
              `const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');\n` +
              [0, 1]
                .map(
                  (i) =>
                    `test('case-${i}',()=>assert.equal(fs.readFileSync(${JSON.stringify(i ? helper : file)},'utf8'),'fixed'));`,
                )
                .join('\n'),
          },
        },
      ],
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
    if (mode === 'skip-retest')
      calls[7] = [
        { name: 'read_file', id: 'passed-test', args: { file_path: file } },
      ];
    const store = new InMemorySessionStore();
    const session = store.createSession({ workspacePath: root });
    const recovery =
      mode === 'recovery-requires-review'
        ? new FileTurnRecoveryStore(path.join(root, 'recovery'))
        : false;
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      { log: async () => undefined },
      { recoveryStore: recovery },
    );
    await runtime.initialize();
    await runtime.run([{ type: 'text', value: prompt }], 'local');
    if (recovery) {
      // A generic shell is not a sandboxed local verifier. With durable
      // recovery enabled, an ambiguous side effect must still stop replay.
      expect(writes).toBe(1);
      expect(checks).toBe(1);
      expect((await recovery.load(session.sessionId))?.status).toBe(
        'reconciliation_required',
      );
      expect(
        store.getHistory(session.sessionId).find((m) => m.turn)?.turn?.status,
      ).not.toBe('completed');
      return;
    }
    expect(writes).toBe(4);
    expect(
      checks,
      JSON.stringify(
        store.getHistory(session.sessionId).map((m) => ({
          tools: m.toolCalls,
          adaptations: m.turn?.adaptations,
        })),
      ),
    ).toBe(mode === 'skip-retest' ? 1 : 2);
    const adaptation = store
      .getHistory(session.sessionId)
      .find((m) => m.turn)
      ?.turn?.adaptations?.find((a) => a.failedToolCallId === 'failed-test');
    expect(adaptation?.alternatives?.find((a) => a.selected)?.action).toBe(
      'switch_strategy',
    );
    const status = store.getHistory(session.sessionId).find((m) => m.turn)
      ?.turn?.status;
    if (['pass', 'assertion-403', 'assertion-404'].includes(mode)) {
      expect(round).toBe(10);
      expect(
        status,
        JSON.stringify(
          store
            .getHistory(session.sessionId)
            .find((m) => m.turn)
            ?.turn?.verification?.checks.filter((c) => c.status !== 'passed'),
        ),
      ).toBe('completed');
    } else expect(status).not.toBe('completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
