import { describe, expect, it } from 'vitest';
import {
  extractTaskRequirements,
  auditTaskCoverage,
} from './taskRequirements.js';

describe('acceptance coverage independent of the proposed plan', () => {
  it('splits explicit requirements and inline behavior lists, with stable source quotes', () => {
    const request =
      '1. 修复登录并支持短信验证码、密码错误提示和会话过期处理\n2. 不要部署服务器';
    const requirements = extractTaskRequirements(request);
    expect(requirements.map((r) => r.quote)).toContain('支持短信验证码');
    expect(requirements.map((r) => r.quote)).toContain('密码错误提示');
    expect(requirements.map((r) => r.quote)).toContain('会话过期处理');
    expect(requirements.every((r) => request.includes(r.quote))).toBe(true);
    expect(requirements).toContainEqual(
      expect.objectContaining({
        quote: '不要部署服务器',
        kind: 'prohibition',
        expectedOutcome: 'must_not_happen',
        behavioral: true,
      }),
    );
  });
  it('does not accept interface existence as proof of all requested behavior', () => {
    const request = '修复登录并支持短信验证码、密码错误提示和会话过期处理';
    const objectives = [
      {
        id: 'login',
        description: request,
        sourceQuote: request,
        dependsOn: [],
        evidence: [],
        criteria: [
          {
            id: 'exists',
            kind: 'observation' as const,
            description: '存在登录函数',
            toolName: 'read_file',
          },
        ],
      },
    ];
    const checks = auditTaskCoverage(
      extractTaskRequirements(request),
      objectives,
    );
    expect(checks.some((c) => c.status !== 'passed')).toBe(true);
  });
  it('requires separate bindings for separate requirements, not a broad quote', () => {
    const request = '1. 修复登录\n2. 修复消息';
    const objective = {
      id: 'all',
      description: request,
      sourceQuote: request,
      dependsOn: [],
      evidence: [],
      criteria: [
        {
          id: 'test',
          kind: 'process' as const,
          description: 'tests',
          command: 'npm test',
          directory: '/repo',
        },
      ],
    };
    const requirements = extractTaskRequirements(request);
    expect(
      auditTaskCoverage(requirements, [objective]).every(
        (c) => c.status === 'passed',
      ),
    ).toBe(false);
    const scoped = {
      ...objective,
      criteria: requirements.map((r, i) => ({
        ...objective.criteria[0],
        id: `test-${i}`,
        requirementQuote: r.quote,
        testCase: { name: `regression-${i}`, scenario: 'normal' as const },
      })),
    };
    expect(
      auditTaskCoverage(requirements, [scoped]).every(
        (c) => c.status === 'passed',
      ),
    ).toBe(true);
    const reused = {
      ...scoped,
      criteria: scoped.criteria.map((c) => ({
        ...c,
        testCase: { name: 'same test', scenario: 'normal' as const },
      })),
    };
    expect(
      auditTaskCoverage(requirements, [reused]).every(
        (c) => c.status === 'passed',
      ),
    ).toBe(false);
  });
  it('supports markdown tables and ignores fenced examples', () => {
    const requirements = extractTaskRequirements(
      '| 功能 | 要求 |\n|---|---|\n| 登录 | 支持过期处理 |\n| 消息 | 保留已读会话 |\n```\n删除所有数据\n```',
    );
    expect(requirements.map((r) => r.quote)).toEqual([
      '| 登录 | 支持过期处理 |',
      '| 消息 | 保留已读会话 |',
    ]);
  });
  it('keeps module, behavior and conditions as separate source-anchored requirements', () => {
    const request =
      '| 模块 | 行为 | 条件 |\n|---|---|---|\n| 登录 | 支持重试 | 超时后 |\n| 支付 | 支持重试 | 超时后 |';
    const requirements = extractTaskRequirements(request);
    expect(requirements).toHaveLength(2);
    expect(requirements[0].subject).toBe('登录');
    expect(requirements[1].subject).toBe('支付');
    expect(requirements[0].conditions).toBe('超时后');
    expect(new Set(requirements.map((r) => r.id)).size).toBe(2);
    expect(requirements.every((r) => request.includes(r.quote))).toBe(true);
    expect(
      auditTaskCoverage(requirements, [
        {
          id: 'login',
          description: '登录',
          sourceQuote: requirements[0].quote,
          dependsOn: [],
          evidence: [],
          criteria: [{ id: 'c', kind: 'manual', description: '人工核实' }],
        },
      ])[1].status,
    ).toBe('not_run');
  });
  it('inherits behavioral intent across noun lists and keeps a prohibition source-anchored', () => {
    const requirements = extractTaskRequirements(
      '新增登录、支付、通知\n不要删除账户、订单、日志',
    );
    expect(requirements.map((r) => r.quote)).toEqual([
      '新增登录',
      '支付',
      '通知',
      '不要删除账户、订单、日志',
    ]);
    expect(requirements.every((r) => r.behavioral)).toBe(true);
    expect(requirements.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'prohibition',
        expectedOutcome: 'must_not_happen',
      }),
    );
  });
  it('classifies source-anchored prohibitions, scope, preservation and preconditions', () => {
    const request =
      '生成 PPT，但不要打开 WPS，不要显示绝对路径，只允许写入输出目录，保留现有模板，必须先验证再交付';
    const requirements = extractTaskRequirements(request);
    expect(
      requirements.map((r) => [r.quote, r.kind, r.expectedOutcome]),
    ).toEqual([
      ['生成 PPT', 'behavior', 'must_happen'],
      ['不要打开 WPS', 'prohibition', 'must_not_happen'],
      ['不要显示绝对路径', 'prohibition', 'must_not_happen'],
      ['只允许写入输出目录', 'scope', 'must_happen'],
      ['保留现有模板', 'preservation', 'must_happen'],
      ['必须先验证再交付', 'precondition', 'must_happen'],
    ]);
    expect(requirements.every((r) => request.includes(r.quote))).toBe(true);
  });
  it('keeps contrastive constraints instead of attaching them to the deliverable', () => {
    const request = '生成应用内可点击链接，而不是用行内代码显示绝对路径';
    expect(
      extractTaskRequirements(request).map((r) => [
        r.quote,
        r.kind,
        r.expectedOutcome,
      ]),
    ).toEqual([
      ['生成应用内可点击链接', 'behavior', 'must_happen'],
      ['而不是用行内代码显示绝对路径', 'prohibition', 'must_not_happen'],
    ]);
  });
  it('recognizes constraints that follow their subject or condition', () => {
    const request =
      '升级过程不得自动重启，更新后现有功能不受影响，安装只允许写入用户目录，用户确认后才能执行';
    expect(
      extractTaskRequirements(request).map((r) => [
        r.quote,
        r.kind,
        r.expectedOutcome,
      ]),
    ).toEqual([
      ['升级过程不得自动重启', 'prohibition', 'must_not_happen'],
      ['更新后现有功能不受影响', 'preservation', 'must_happen'],
      ['安装只允许写入用户目录', 'scope', 'must_happen'],
      ['用户确认后才能执行', 'precondition', 'must_happen'],
    ]);
  });
  it('keeps negative table rows as native requirements', () => {
    const request =
      '| 模块 | 要求 | 条件 |\n|---|---|---|\n| 更新 | 不允许自动重启 | 用户未确认时 |';
    expect(extractTaskRequirements(request)).toEqual([
      expect.objectContaining({
        quote: '| 更新 | 不允许自动重启 | 用户未确认时 |',
        subject: '更新',
        behavior: '不允许自动重启',
        conditions: '用户未确认时',
        kind: 'prohibition',
        expectedOutcome: 'must_not_happen',
      }),
    ]);
  });
  it('requires a negative test contract for a prohibition', () => {
    const request = '不要打开 WPS';
    const requirement = extractTaskRequirements(request)[0];
    const objective = {
      id: 'preview',
      description: '应用内预览',
      sourceQuote: request,
      dependsOn: [],
      evidence: [],
      criteria: [
        {
          id: 'preview-test',
          kind: 'process' as const,
          description: '预览回归',
          command: 'npm test',
          directory: '/repo',
          requirementQuote: request,
          testCase: { name: 'preview', scenario: 'normal' as const },
        },
      ],
    };
    expect(auditTaskCoverage([requirement], [objective])[0].status).toBe(
      'not_run',
    );
    expect(
      auditTaskCoverage(
        [requirement],
        [
          {
            ...objective,
            criteria: [
              {
                ...objective.criteria[0],
                testCase: {
                  ...objective.criteria[0].testCase,
                  expectedOutcome: 'must_not_happen' as const,
                },
              },
            ],
          },
        ],
      )[0].status,
    ).toBe('passed');
  });
  it('does not use a normal-case test for explicitly requested error and boundary conditions', () => {
    const request = '| 登录 | 支持重试 | 异常和边界条件 |';
    const requirements = extractTaskRequirements(request);
    expect(requirements[0].scenarios).toEqual(['error', 'boundary']);
    const objective = {
      id: 'login',
      description: 'login',
      sourceQuote: request,
      dependsOn: [],
      evidence: [],
      criteria: [
        {
          id: 'normal',
          description: '正常',
          kind: 'process' as const,
          command: 'npm test',
          directory: '/repo',
          requirementQuote: request,
          testCase: { name: 'normal', scenario: 'normal' as const },
        },
      ],
    };
    expect(auditTaskCoverage(requirements, [objective])[0].status).toBe(
      'not_run',
    );
    const improved = {
      ...objective,
      criteria: requirements[0].scenarios.map((s) => ({
        ...objective.criteria[0],
        id: s,
        testCase: { name: s, scenario: s },
      })),
    };
    expect(auditTaskCoverage(requirements, [improved])[0].status).toBe(
      'passed',
    );
  });
});
it('groups positive, preservation, prohibition and human judgments explicitly', () => {
  expect(
    extractTaskRequirements(
      '生成报告。保持 `config.json` 不变。不要打开 WPS。由我人工确认。',
    ).map((r) => r.category),
  ).toEqual([
    'must_implement',
    'must_preserve',
    'must_not_happen',
    'human_judgment',
  ]);
});
