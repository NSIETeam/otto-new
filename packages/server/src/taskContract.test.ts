/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { TaskContractLedger } from './taskContract.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';

const objective = {
  id: 'login',
  description: '修复登录并验证',
  sourceQuote: '修复登录',
  dependsOn: [],
  criteria: [
    {
      id: 'login-test',
      description: '登录回归通过',
      kind: 'process',
      command: 'npm test -- login',
      directory: '/repo',
    },
  ],
  evidence: [],
};
const tool = (id: string, command = 'npm test -- login'): ToolCall => ({
  id,
  toolName: 'run_shell_command',
  parameters: { command, directory: '/repo' },
  status: ToolCallStatus.Success,
  result: {
    success: true,
    executionTime: 1,
    toolName: 'run_shell_command',
    data: 'passed',
    process: {
      command,
      directory: '/repo',
      status: 'exited',
      exitCode: 0,
      signal: null,
    },
  },
});

describe('request-specific acceptance ledger', () => {
  it('cannot pass from a model assertion or a test for another target', () => {
    const ledger = new TaskContractLedger('修复登录和消息列表');
    ledger.update({ expectedRevision: 0, objectives: [objective] });
    ledger.observe(tool('wrong', 'npm test -- inbox'), false);
    ledger.update({
      expectedRevision: 1,
      objectives: [
        {
          ...objective,
          evidence: [{ criterionId: 'login-test', toolCallId: 'wrong' }],
        },
      ],
    });
    expect(ledger.checks()[0].status).not.toBe('passed');
  });
  it('accepts only matching native evidence and invalidates it after a write', () => {
    const ledger = new TaskContractLedger('修复登录');
    ledger.update({ expectedRevision: 0, objectives: [objective] });
    ledger.observe(tool('right'), false);
    ledger.update({
      expectedRevision: 1,
      objectives: [
        {
          ...objective,
          evidence: [{ criterionId: 'login-test', toolCallId: 'right' }],
        },
      ],
    });
    expect(ledger.checks()[0].status).toBe('passed');
    ledger.observe(
      {
        ...tool('edit'),
        toolName: 'replace',
        result: { success: true, executionTime: 1, toolName: 'replace' },
      },
      true,
    );
    expect(ledger.checks()[0].status).toBe('not_run');
  });
  it('rejects invented sources, dependency cycles, stale revisions and deleting acceptance', () => {
    const ledger = new TaskContractLedger('修复登录');
    expect(() =>
      ledger.update({
        expectedRevision: 0,
        objectives: [{ ...objective, sourceQuote: '部署线上' }],
      }),
    ).toThrow();
    expect(() =>
      ledger.update({
        expectedRevision: 0,
        objectives: [{ ...objective, dependsOn: ['login'] }],
      }),
    ).toThrow();
    ledger.update({ expectedRevision: 0, objectives: [objective] });
    expect(() =>
      ledger.update({ expectedRevision: 0, objectives: [objective] }),
    ).toThrow();
    expect(() =>
      ledger.update({ expectedRevision: 1, objectives: [] }),
    ).toThrow();
    expect(() =>
      ledger.update({
        expectedRevision: 1,
        objectives: [
          {
            ...objective,
            criteria: [
              { ...objective.criteria[0], command: 'npm test -- easy' },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it('does not restore claims of passed checks as execution evidence', () => {
    const ledger = new TaskContractLedger('修复登录');
    ledger.update({ expectedRevision: 0, objectives: [objective] });
    ledger.observe(tool('right'), false);
    ledger.update({
      expectedRevision: 1,
      objectives: [
        {
          ...objective,
          evidence: [{ criterionId: 'login-test', toolCallId: 'right' }],
        },
      ],
    });
    const restored = new TaskContractLedger('修复登录', ledger.snapshot());
    expect(restored.checks()[0].status).toBe('not_run');
  });

  it('a failed later check invalidates an earlier pass for the same target', () => {
    const ledger = new TaskContractLedger('修复登录');
    ledger.update({ expectedRevision: 0, objectives: [objective] });
    ledger.observe(tool('old'), false);
    ledger.update({
      expectedRevision: 1,
      objectives: [
        {
          ...objective,
          evidence: [{ criterionId: 'login-test', toolCallId: 'old' }],
        },
      ],
    });
    const failed = tool('new');
    failed.status = ToolCallStatus.Error;
    failed.result!.process!.exitCode = 2;
    ledger.observe(failed, false);
    expect(ledger.checks()[0].status).toBe('not_run');
  });

  it('manual judgments and fabricated source quotes never become passes', () => {
    const ledger = new TaskContractLedger('修复登录');
    const manual = {
      ...objective,
      criteria: [{ id: 'approve', description: '人工验收', kind: 'manual' }],
      evidence: [{ criterionId: 'approve', toolCallId: 'ok' }],
    };
    ledger.observe(tool('ok'), false);
    ledger.update({ expectedRevision: 0, objectives: [manual] });
    expect(ledger.checks()[0].status).toBe('not_run');
  });

  it('requires coverage for every explicitly numbered requirement', () => {
    const ledger = new TaskContractLedger('1. 修复登录\n2. 修复消息列表');
    expect(() =>
      ledger.update({ expectedRevision: 0, objectives: [objective] }),
    ).toThrow(/omits/);
    expect(() =>
      ledger.update({
        expectedRevision: 0,
        objectives: [
          objective,
          { ...objective, id: 'inbox', sourceQuote: '修复消息列表' },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects ambiguous plan IDs and shared-word coverage of separate requirements', () => {
    const ledger = new TaskContractLedger('1. 修复登录\n2. 修复消息列表');
    expect(() =>
      ledger.update({
        expectedRevision: 0,
        objectives: [{ ...objective, sourceQuote: '修复' }],
      }),
    ).toThrow(/omits/);
    expect(() =>
      new TaskContractLedger('修复登录').update({
        expectedRevision: 0,
        objectives: [{ ...objective, id: 'login:test' }],
      }),
    ).toThrow(/id/);
    expect(() =>
      new TaskContractLedger('修复登录').update({
        expectedRevision: 0,
        objectives: [
          {
            ...objective,
            criteria: [{ ...objective.criteria[0], id: 'test:login' }],
          },
        ],
      }),
    ).toThrow(/id/);
  });
});
