/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { TaskContractLedger } from './taskContract.js';
import { ToolCallStatus, type ToolCall } from './protocol.js';
import { mkdtempSync, writeFileSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TurnConstraintGuard } from './turnConstraints.js';
it('accepts only native constraint evidence, not an approval invented by the plan', () => {
  const request = '不要打开 WPS';
  const ledger = new TaskContractLedger(request);
  const guard = new TurnConstraintGuard(request, { turnId: 't' });
  ledger.update({ expectedRevision: 0, nativeConstraintChecks: [{ status: 'passed' }], objectives: [{
    id: 'constraint', description: '禁止外部打开', sourceQuote: request, dependsOn: [],
    criteria: [{ id: 'prevent', kind: 'constraint', requirementQuote: request, description: '原生检查' }],
    evidence: [{ criterionId: 'prevent', toolCallId: 'invented', quote: 'approved' }],
  }] });
  expect(ledger.checks()[0].status).toBe('not_run');
  ledger.setNativeConstraintChecks(guard.checks(''));
  expect(ledger.checks()[0].status).toBe('not_run');
  guard.coverageStarted();
  ledger.setNativeConstraintChecks(guard.checks(''));
  expect(ledger.checks()[0].status).toBe('passed');
  guard.markGap();
  ledger.setNativeConstraintChecks(guard.checks(''));
  expect(ledger.checks()[0].status).toBe('not_run');
});

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
  it('allows a reporter-only change after a successful but unreadable report, never a scope change', () => {
    const ledger = new TaskContractLedger('修复登录');
    const initial = {
      ...objective,
      criteria: [
        {
          ...objective.criteria[0],
          command: 'npx vitest run login',
          testCase: { name: 'login normal', scenario: 'normal' },
        },
      ],
    };
    ledger.update({ expectedRevision: 0, objectives: [initial] });
    ledger.observe(tool('old', initial.criteria[0].command), false);
    const command = 'npx vitest run login --reporter=json';
    const replacement = tool('new', command);
    replacement.result!.data = JSON.stringify({
      testResults: [
        { assertionResults: [{ fullName: 'login normal', status: 'passed' }] },
      ],
    });
    ledger.observe(replacement, false);
    const wrongScope = tool(
      'wrong-scope',
      'npx vitest run unrelated --reporter=json',
    );
    wrongScope.result!.data = replacement.result!.data;
    ledger.observe(wrongScope, false);
    expect(() =>
      ledger.update({
        expectedRevision: 1,
        revisionReason: '不能通过格式调整更换测试目标',
        objectives: [
          {
            ...initial,
            criteria: [
              {
                ...initial.criteria[0],
                command: String(wrongScope.parameters.command),
              },
            ],
          },
        ],
      }),
    ).toThrow();
    ledger.update({
      expectedRevision: 1,
      revisionReason: '只调整报告格式以取得用例回执',
      objectives: [
        {
          ...initial,
          criteria: [{ ...initial.criteria[0], command }],
          evidence: [{ criterionId: 'login-test', toolCallId: 'new' }],
        },
      ],
    });
    expect(ledger.checks()[0].status).toBe('passed');
  });
  it('replaces a broken runner only with the same case and native successful replacement receipt', () => {
    const ledger = new TaskContractLedger('修复登录');
    const initial = {
      ...objective,
      criteria: [
        {
          ...objective.criteria[0],
          testCase: { name: 'login normal', scenario: 'normal' },
        },
      ],
    };
    ledger.update({ expectedRevision: 0, objectives: [initial] });
    const changed = {
      ...initial,
      criteria: [
        { ...initial.criteria[0], command: 'npx vitest run --reporter=json' },
      ],
      evidence: [{ criterionId: 'login-test', toolCallId: 'replacement' }],
    };
    expect(() =>
      ledger.update({
        expectedRevision: 1,
        revisionReason: '脚本不存在，使用相同用例',
        objectives: [changed],
      }),
    ).toThrow();
    const broken = tool('broken');
    broken.status = ToolCallStatus.Error;
    broken.result!.success = false;
    broken.result!.error = 'Missing script: test';
    broken.result!.process!.exitCode = 1;
    ledger.observe(broken, false);
    const replacement = tool('replacement', changed.criteria[0].command);
    replacement.result!.data = JSON.stringify({
      testResults: [
        { assertionResults: [{ fullName: 'login normal', status: 'passed' }] },
      ],
    });
    ledger.observe(replacement, false);
    ledger.update({
      expectedRevision: 1,
      revisionReason: '脚本不存在，使用相同用例',
      objectives: [changed],
    });
    expect(ledger.checks()[0].status).toBe('passed');
    expect(ledger.supersededVerificationScopes().size).toBe(1);
    expect(
      ledger.snapshot().revisions?.at(-1)?.replacements?.[0].fromCommand,
    ).toBe(initial.criteria[0].command);
    ledger.observe({ ...tool('new-write'), toolName: 'replace' }, true);
    expect(ledger.supersededVerificationScopes().size).toBe(0);
  });
  it('cannot replace an assertion failure or change the required case to weaken acceptance', () => {
    const ledger = new TaskContractLedger('修复登录');
    const initial = {
      ...objective,
      criteria: [
        {
          ...objective.criteria[0],
          testCase: { name: 'login normal', scenario: 'normal' },
        },
      ],
    };
    ledger.update({ expectedRevision: 0, objectives: [initial] });
    const broken = tool('broken');
    broken.status = ToolCallStatus.Error;
    broken.result!.error = 'AssertionError';
    broken.result!.success = false;
    broken.result!.process!.exitCode = 1;
    ledger.observe(broken, false);
    const replacement = tool('replacement', 'npx vitest run');
    replacement.result!.data = 'TAP version 13\nok 1 - login normal\n1..1';
    ledger.observe(replacement, false);
    expect(() =>
      ledger.update({
        expectedRevision: 1,
        revisionReason: '跳过失败',
        objectives: [
          {
            ...initial,
            criteria: [{ ...initial.criteria[0], command: 'npx vitest run' }],
          },
        ],
      }),
    ).toThrow();
    expect(ledger.snapshot().revision).toBe(1);
  });
  it('requires the named test case, not just a successful process or an unrelated passing case', () => {
    const ledger = new TaskContractLedger('修复登录');
    const named = {
      ...objective,
      criteria: [
        {
          ...objective.criteria[0],
          testCase: { name: 'login rejects expired', scenario: 'error' },
        },
      ],
      evidence: [{ criterionId: 'login-test', toolCallId: 'case' }],
    };
    ledger.update({ expectedRevision: 0, objectives: [named] });
    ledger.observe(tool('case'), false);
    expect(ledger.checks()[0].status).toBe('not_run');
    const result = tool('case');
    result.result!.data = 'TAP version 13\nok 1 - other case\n1..1\n';
    ledger.observe(result, false);
    expect(ledger.checks()[0].status).toBe('not_run');
    result.result!.data =
      'TAP version 13\nok 1 - login rejects expired\n1..1\n';
    ledger.observe(result, false);
    expect(ledger.checks()[0].status).toBe('passed');
  });
  it('permits stronger acceptance without removing previous criteria, with revision history', () => {
    const ledger = new TaskContractLedger('修复登录');
    ledger.update({ expectedRevision: 0, objectives: [objective] });
    const stronger = {
      ...objective,
      criteria: [
        ...objective.criteria,
        {
          ...objective.criteria[0],
          id: 'expired',
          command: 'npm test -- expired',
        },
      ],
    };
    expect(() =>
      ledger.update({
        expectedRevision: 1,
        revisionReason: '增加会话过期回归',
        objectives: [stronger],
      }),
    ).not.toThrow();
    expect(ledger.snapshot().revisions?.at(-1)?.reason).toBe(
      '增加会话过期回归',
    );
    expect(
      new TaskContractLedger('修复登录', ledger.snapshot()).snapshot()
        .revisions,
    ).toEqual(ledger.snapshot().revisions);
    expect(() =>
      ledger.update({ expectedRevision: 2, objectives: [objective] }),
    ).toThrow(/removed|weakened/);
  });
  it('preserves a native single-file observation after an unrelated file write, not a related or unknown write', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'otto-evidence-scope-'));
    const source = path.join(root, 'login.ts');
    const other = path.join(root, 'readme.md');
    const alias = path.join(root, 'alias.ts');
    writeFileSync(source, 'login');
    writeFileSync(other, 'note');
    linkSync(source, alias);
    try {
      const ledger = new TaskContractLedger('分析登录文件');
      const reading = {
        ...objective,
        sourceQuote: '分析登录文件',
        criteria: [
          {
            id: 'source',
            description: '观察源文件',
            kind: 'observation',
            toolName: 'read_file',
          },
        ],
        evidence: [
          { criterionId: 'source', toolCallId: 'read', quote: 'login' },
        ],
      };
      ledger.update({ expectedRevision: 0, objectives: [reading] });
      ledger.observe(
        {
          ...tool('read'),
          toolName: 'read_file',
          parameters: { file_path: source },
          result: {
            success: true,
            executionTime: 1,
            toolName: 'read_file',
            data: 'login',
          },
        },
        false,
      );
      ledger.observe(
        {
          ...tool('write'),
          toolName: 'write_file',
          parameters: { file_path: other },
        },
        true,
      );
      expect(ledger.checks()[0].status).toBe('passed');
      ledger.observe(
        {
          ...tool('related'),
          toolName: 'replace',
          parameters: { file_path: alias },
        },
        true,
      );
      expect(ledger.checks()[0].status).toBe('not_run');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('allows dependency reordering only with a reason and satisfied prerequisites', () => {
    const ledger = new TaskContractLedger('修复登录');
    const dependent = { ...objective, id: 'dependent', dependsOn: ['login'] };
    ledger.update({ expectedRevision: 0, objectives: [objective, dependent] });
    expect(() =>
      ledger.update({
        expectedRevision: 1,
        revisionReason: '重排',
        objectives: [objective, { ...dependent, dependsOn: [] }],
      }),
    ).toThrow(/unfinished/);
    ledger.observe(tool('test'), false);
    const verified = {
      ...objective,
      evidence: [{ criterionId: 'login-test', toolCallId: 'test' }],
    };
    ledger.update({ expectedRevision: 1, objectives: [verified, dependent] });
    expect(() =>
      ledger.update({
        expectedRevision: 2,
        objectives: [verified, { ...dependent, dependsOn: [] }],
      }),
    ).toThrow();
    expect(() =>
      ledger.update({
        expectedRevision: 2,
        revisionReason: '前置验收已通过，调整执行顺序',
        objectives: [verified, { ...dependent, dependsOn: [] }],
      }),
    ).not.toThrow();
  });
  it('rejects invented bindings atomically and never restores native evidence', () => {
    const ledger = new TaskContractLedger('修复登录');
    ledger.update({ expectedRevision: 0, objectives: [objective] });
    expect(() =>
      ledger.update({
        expectedRevision: 1,
        objectives: [
          {
            ...objective,
            criteria: [
              { ...objective.criteria[0], requirementQuote: '上线部署' },
            ],
          },
        ],
      }),
    ).toThrow(/requirement/);
    expect(ledger.snapshot().revision).toBe(1);
    const snapshot = ledger.snapshot();
    expect(
      () =>
        new TaskContractLedger('修复登录', {
          ...snapshot,
          revisions: [{ revision: 999, reason: '伪造' }],
        }),
    ).toThrow(/history/);
  });
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

  it('does not allow a plan to omit an explicitly listed prohibition', () => {
    const ledger = new TaskContractLedger('1. 修复登录\n2. 不要部署服务器');
    expect(() =>
      ledger.update({ expectedRevision: 0, objectives: [objective] }),
    ).toThrow(/omits/);
  });

  it('exposes constraint polarity and preserves it in parsed acceptance', () => {
    const request = '不要打开 WPS';
    const ledger = new TaskContractLedger(request);
    ledger.update({
      expectedRevision: 0,
      objectives: [
        {
          ...objective,
          sourceQuote: request,
          criteria: [
            {
              ...objective.criteria[0],
              requirementQuote: request,
              testCase: {
                name: 'does not open WPS',
                scenario: 'normal',
                expectedOutcome: 'must_not_happen',
              },
            },
          ],
        },
      ],
    });
    expect(ledger.snapshot().objectives[0].criteria[0].testCase).toEqual({
      name: 'does not open WPS',
      scenario: 'normal',
      expectedOutcome: 'must_not_happen',
    });
    expect(JSON.parse(ledger.directive()).requirements[0]).toEqual(
      expect.objectContaining({
        kind: 'prohibition',
        expectedOutcome: 'must_not_happen',
      }),
    );
    expect(ledger.coverageChecks()[0].status).toBe('passed');
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
