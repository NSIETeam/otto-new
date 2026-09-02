/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendCompressionInvariantSnapshot,
  captureCompressionInvariants,
  validateCompressionInvariants,
  type Content,
} from 'otto-core';
import {
  AdaptiveExecutionCoordinator,
  TaskGraphCoordinator,
  deriveTurnControlPolicy,
  routeTurnComplexity,
  type AdaptiveFailureCategory,
  type AdaptiveStrategyAction,
  type TurnExecutionRoute,
  type TurnIntent,
  type TurnRiskLevel,
} from '../../server/src/index.js';
import type { DeterministicScenario, EvaluationReport } from './contracts.js';
import { runDeterministicScenarios, writeEvaluationReport } from './runner.js';

const artifactDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../artifacts',
);

const neutralSuffixes = [
  '',
  '请用中文。',
  '面向非技术用户。',
  '结果使用短句。',
  '保持术语一致。',
  '输入来自桌面端。',
  '不要复述问题。',
  '表达尽量清晰。',
] as const;

const routeFixtures: ReadonlyArray<{
  id: string;
  text: string;
  intent: TurnIntent;
  risk: TurnRiskLevel;
  toolFree?: boolean;
  allowed: readonly TurnExecutionRoute[];
  workflow: boolean;
}> = [
  {
    id: 'concept-task-graph',
    text: '任务图是什么？',
    intent: 'answer',
    risk: 'read_only',
    allowed: ['direct'],
    workflow: false,
  },
  {
    id: 'fact',
    text: '17 乘以 9 是多少？',
    intent: 'answer',
    risk: 'read_only',
    allowed: ['direct'],
    workflow: false,
  },
  {
    id: 'research',
    text: '查找并比较三家供应商的官方资料',
    intent: 'research',
    risk: 'read_only',
    allowed: ['parallel_tools'],
    workflow: false,
  },
  {
    id: 'diagnose',
    text: '排查登录白屏为什么发生',
    intent: 'diagnose',
    risk: 'read_only',
    allowed: ['parallel_tools'],
    workflow: false,
  },
  {
    id: 'local-change',
    text: '修改登录组件并运行测试',
    intent: 'change',
    risk: 'local_write',
    allowed: ['planned_agent'],
    workflow: false,
  },
  {
    id: 'artifact',
    text: '生成产品说明文档并验证',
    intent: 'create_artifact',
    risk: 'local_write',
    allowed: ['planned_agent'],
    workflow: false,
  },
  {
    id: 'enterprise',
    text: '配置企业成员权限并核对回执',
    intent: 'enterprise_action',
    risk: 'local_write',
    allowed: ['planned_agent'],
    workflow: false,
  },
  {
    id: 'cross-layer',
    text: '全面检查前端、服务端、数据库迁移和所有分支，修复问题，补充测试并完成生产构建',
    intent: 'change',
    risk: 'local_write',
    allowed: ['workflow'],
    workflow: true,
  },
  {
    id: 'explicit-orchestration',
    text: '用任务图并行检查前端、后端和测试，修复并完成构建',
    intent: 'change',
    risk: 'local_write',
    allowed: ['workflow'],
    workflow: true,
  },
  {
    id: 'four-objectives',
    text: '优化复杂度路由、显式任务图、压缩后目标校验和大规模真实评测',
    intent: 'change',
    risk: 'local_write',
    allowed: ['subagents', 'workflow'],
    workflow: false,
  },
  {
    id: 'external-write',
    text: '全面核对版本然后发布并部署线上服务器',
    intent: 'change',
    risk: 'external_write',
    allowed: ['planned_agent'],
    workflow: false,
  },
  {
    id: 'destructive',
    text: '清空生产数据库并删除全部账户',
    intent: 'change',
    risk: 'destructive',
    allowed: ['planned_agent'],
    workflow: false,
  },
  {
    id: 'tool-free',
    text: '全面分析全部代码',
    intent: 'change',
    risk: 'read_only',
    toolFree: true,
    allowed: ['restricted'],
    workflow: false,
  },
  {
    id: 'policy-compare',
    text: '查找最新政策并比较官方来源',
    intent: 'research',
    risk: 'read_only',
    allowed: ['parallel_tools'],
    workflow: false,
  },
  {
    id: 'production-grade',
    text: '一口气完成整个前端、后端、数据库和发布测试的生产级优化',
    intent: 'change',
    risk: 'local_write',
    allowed: ['workflow'],
    workflow: true,
  },
  {
    id: 'single-source-diagnosis',
    text: '诊断消息时间错了八小时的原因并给出证据',
    intent: 'diagnose',
    risk: 'read_only',
    allowed: ['parallel_tools'],
    workflow: false,
  },
];

const routeScenarios: DeterministicScenario[] = routeFixtures.flatMap(
  (fixture) =>
    neutralSuffixes.map((suffix, index) => ({
      id: `adversarial-route-${fixture.id}-${index + 1}`,
      lane: 'planning' as const,
      description:
        'Routing remains stable under presentation-only prompt changes.',
      requiredEvidence: ['assertion' as const, 'plan_revision' as const],
      async execute() {
        const profile = routeTurnComplexity({
          text: `${fixture.text}${suffix}`,
          intent: fixture.intent,
          riskLevel: fixture.risk,
          toolFree: fixture.toolFree ?? false,
        });
        return {
          passed:
            fixture.allowed.includes(profile.route) &&
            profile.exposesWorkflowTool === fixture.workflow &&
            profile.budget.maxParallelTools >= 1 &&
            profile.budget.maxModelRounds >= 1 &&
            profile.budget.maxToolCalls >= profile.budget.maxParallelTools,
          evidence: [
            {
              kind: 'assertion' as const,
              summary: `route=${profile.route}; level=${profile.level}`,
            },
            {
              kind: 'plan_revision' as const,
              summary: `rounds=${profile.budget.maxModelRounds}; tools=${profile.budget.maxToolCalls}`,
            },
          ],
        };
      },
    })),
);

const graphPrompts = [
  '检查并修改登录代码，然后运行测试',
  '检查并修改消息持久化，然后运行测试',
  '检查并修改园区工单回流，然后运行测试',
  '检查并修改桌宠拖动，然后运行测试',
  '检查并修改企业授权，然后运行测试',
  '检查并修改 MCP 安装审计，然后运行测试',
  '检查并修改 Skill 草稿审核，然后运行测试',
  '检查并修改 PPT 预览，然后运行测试',
  '检查并修改时区解析，然后运行测试',
  '检查并修改自动更新，然后运行测试',
  '检查并修改组织架构，然后运行测试',
  '检查并修改企业记忆，然后运行测试',
  '检查并修改候选人审计，然后运行测试',
  '检查并修改个人 API 配置，然后运行测试',
  '检查并修改功能组删除，然后运行测试',
  '检查并修改邀请码登录，然后运行测试',
] as const;

const adaptations: ReadonlyArray<{
  category: AdaptiveFailureCategory;
  action: AdaptiveStrategyAction;
}> = [
  { category: 'transient', action: 'retry_once' },
  { category: 'stale_state', action: 'switch_strategy' },
  { category: 'permission', action: 'request_input' },
  { category: 'context_overflow', action: 'compact_context' },
  { category: 'unknown_side_effect', action: 'reconcile' },
  { category: 'unsupported', action: 'switch_strategy' },
  { category: 'not_found', action: 'switch_strategy' },
  { category: 'invalid_input', action: 'switch_strategy' },
];

const graphScenarios: DeterministicScenario[] = graphPrompts.flatMap(
  (text, promptIndex) =>
    adaptations.map((adaptation, adaptationIndex) => ({
      id: `adversarial-graph-${promptIndex + 1}-${adaptationIndex + 1}`,
      lane: 'recovery' as const,
      description:
        'A failed dependency blocks delivery, then a bounded replan restores the graph and evidence.',
      requiredEvidence: [
        'tool_trace' as const,
        'plan_revision' as const,
        'recovery_checkpoint' as const,
      ],
      async execute() {
        const policy = deriveTurnControlPolicy({
          text,
          source: 'local',
          toolFree: false,
        });
        const graph = new TaskGraphCoordinator(policy);
        graph.observeTools([
          {
            name: 'read_file',
            status: 'success',
            mutating: false,
            verification: false,
            evidenceId: `read-${promptIndex}`,
          },
          {
            name: 'replace',
            status: 'error',
            mutating: true,
            verification: false,
          },
        ]);
        const blockedBeforeRecovery =
          !graph.markDelivered() && graph.validate().blockedNodeIds.length > 0;
        graph.applyAdaptation({
          revision: 1,
          timestamp: 1_800_000_000_000 + promptIndex * 10 + adaptationIndex,
          ...adaptation,
          toolName: 'replace',
          attempt: 1,
        });
        graph.observeTools([
          {
            name: 'replace',
            status: 'success',
            mutating: true,
            verification: false,
            evidenceId: `write-${promptIndex}`,
          },
          {
            name: 'npm_test',
            status: 'success',
            mutating: true,
            verification: true,
            evidenceId: `test-${promptIndex}`,
          },
        ]);
        const delivered = graph.markDelivered();
        const snapshot = graph.snapshot();
        const restored = TaskGraphCoordinator.restore(
          policy,
          snapshot,
        ).snapshot();
        return {
          passed:
            blockedBeforeRecovery &&
            delivered &&
            snapshot.nodes.every((node) => node.status === 'completed') &&
            snapshot.nodes.find((node) => node.kind === 'verify')?.evidenceIds
              ?.length === 1 &&
            JSON.stringify(restored) === JSON.stringify(snapshot),
          evidence: [
            {
              kind: 'tool_trace' as const,
              summary: 'read/write/test evidence recorded',
            },
            {
              kind: 'plan_revision' as const,
              summary: `revision=${snapshot.revision}; action=${adaptation.action}`,
            },
            {
              kind: 'recovery_checkpoint' as const,
              summary: 'snapshot restored byte-for-byte',
            },
          ],
        };
      },
    })),
);

const goals = [
  '完成自动复杂度路由',
  '修复企业登录授权',
  '完成园区工单消息回流',
  '生成并验证产品演示文稿',
  '重构桌宠全屏拖动',
  '实现招聘音频分析',
  '完成 MCP 安全审计',
  '核对旧用户自动更新',
  '修复消息会话持久化',
  '优化企业记忆评估',
  '完成 Skill 草稿安全审核',
  '修复组织架构显示',
  '完成 PPT 应用内预览',
  '修复无时区时间解析',
  '优化个人 API 配置',
  '完成功能组级联删除',
] as const;
const constraints = [
  '必须保留已通过测试',
  '不允许推送服务器',
  '不得覆盖用户文件',
  '必须在完成后运行类型检查',
  '禁止伪造工具证据',
  '只能修改请求范围内的文件',
  '不要自动执行高风险操作',
  '务必保留可恢复检查点',
] as const;

const compactionScenarios: DeterministicScenario[] = goals.flatMap(
  (goal, goalIndex) =>
    constraints.map((constraint, constraintIndex) => ({
      id: `adversarial-compaction-${goalIndex + 1}-${constraintIndex + 1}`,
      lane: 'context' as const,
      description:
        'Vague continuation and model claims cannot replace the goal or forge evidence after compaction.',
      requiredEvidence: [
        'context_compaction' as const,
        'verification' as const,
      ],
      async execute() {
        const history: Content[] = [
          { role: 'user', parts: [{ text: '环境' }] },
          { role: 'model', parts: [{ text: '收到' }] },
          { role: 'user', parts: [{ text: `${goal}。${constraint}。` }] },
          {
            role: 'model',
            parts: [{ text: '我声称 fake.ts 已经通过 999 项测试。' }],
          },
          { role: 'user', parts: [{ text: '继续' }] },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'verify_change',
                  response: {
                    success: true,
                    output: `packages/server/src/verified-${goalIndex}.ts passed`,
                  },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'build',
                  response: { success: false, error: 'build failed' },
                },
              },
            ],
          },
        ];
        const snapshot = captureCompressionInvariants(history, 2);
        const canonical = appendCompressionInvariantSnapshot(
          '结构化摘要',
          snapshot,
        );
        const valid = validateCompressionInvariants(snapshot, [
          { role: 'user', parts: [{ text: canonical }] },
        ]);
        const invalid = validateCompressionInvariants(snapshot, [
          {
            role: 'user',
            parts: [{ text: canonical.replace('goal:1=', 'goal:x=') }],
          },
        ]);
        return {
          passed:
            snapshot.goals.some((item) => item.includes(goal)) &&
            snapshot.goals.every((item) => item !== '继续') &&
            snapshot.constraints.some((item) => item.includes(constraint)) &&
            snapshot.evidence.length === 1 &&
            snapshot.evidence[0]?.includes('verify_change') === true &&
            !JSON.stringify(snapshot).includes('fake.ts') &&
            valid.valid &&
            !invalid.valid,
          evidence: [
            {
              kind: 'context_compaction' as const,
              summary: `goal=${goalIndex}; constraint=${constraintIndex}`,
            },
            {
              kind: 'verification' as const,
              summary: `canonical=${valid.valid}; tamperRejected=${!invalid.valid}`,
            },
          ],
        };
      },
    })),
);

const failures = [
  {
    message: 'upstream timed out',
    sideEffect: 'read_only',
    category: 'transient',
    first: 'retry_once',
    second: 'switch_strategy',
  },
  {
    message: '403 permission denied',
    sideEffect: 'read_only',
    category: 'permission',
    first: 'request_input',
    second: 'request_input',
  },
  {
    message: '404 resource not found',
    sideEffect: 'read_only',
    category: 'not_found',
    first: 'switch_strategy',
    second: 'switch_strategy',
  },
  {
    message: '409 revision conflict',
    sideEffect: 'local_write',
    category: 'stale_state',
    first: 'switch_strategy',
    second: 'switch_strategy',
  },
  {
    message: 'maximum context length exceeded',
    sideEffect: 'read_only',
    category: 'context_overflow',
    first: 'compact_context',
    second: 'compact_context',
  },
  {
    message: 'socket closed; outcome unknown',
    sideEffect: 'external_write',
    category: 'unknown_side_effect',
    first: 'reconcile',
    second: 'reconcile',
  },
  {
    message: 'invalid parameter schema',
    sideEffect: 'local_write',
    category: 'invalid_input',
    first: 'switch_strategy',
    second: 'switch_strategy',
  },
  {
    message: 'operation is unsupported',
    sideEffect: 'read_only',
    category: 'unsupported',
    first: 'switch_strategy',
    second: 'switch_strategy',
  },
] as const;

const adaptiveScenarios: DeterministicScenario[] = failures.flatMap(
  (fixture, fixtureIndex) =>
    Array.from({ length: 16 }, (_, variant) => ({
      id: `adversarial-adaptive-${fixtureIndex + 1}-${variant + 1}`,
      lane: 'policy' as const,
      description:
        'Repeated failures use bounded strategy switching and never replay unknown side effects.',
      requiredEvidence: ['tool_trace' as const, 'assertion' as const],
      async execute() {
        const coordinator = new AdaptiveExecutionCoordinator();
        const input = {
          toolName: `fixture_${fixtureIndex}_${variant}`,
          callFingerprint: `fingerprint_${fixtureIndex}_${variant}`,
          message: fixture.message,
          sideEffect: fixture.sideEffect,
        };
        const first = coordinator.observe(input);
        const second = coordinator.observe(input);
        return {
          passed:
            first.category === fixture.category &&
            first.action === fixture.first &&
            second.action === fixture.second &&
            second.attempt === 2 &&
            (fixture.sideEffect !== 'external_write' ||
              (!first.retryAllowed && first.action === 'reconcile')),
          evidence: [
            {
              kind: 'tool_trace' as const,
              summary: `category=${first.category}; attempt=${second.attempt}`,
            },
            {
              kind: 'assertion' as const,
              summary: `first=${first.action}; second=${second.action}`,
            },
          ],
        };
      },
    })),
);

const scenarios = [
  ...routeScenarios,
  ...graphScenarios,
  ...compactionScenarios,
  ...adaptiveScenarios,
];

describe('agent runtime adversarial and stress matrix', () => {
  it('passes 512 generated scenarios with complete observable evidence', async () => {
    expect(scenarios).toHaveLength(512);
    const report = await runDeterministicScenarios(scenarios);
    const failed = report.scenarios.filter((scenario) => !scenario.passed);
    expect(
      failed,
      failed
        .map(
          (scenario) =>
            `${scenario.id}: ${scenario.failure ?? 'assertion failed'}`,
        )
        .join('\n'),
    ).toEqual([]);
    expect(report.summary.passRate).toBe(1);
    expect(report.summary.evidenceCoverage).toBe(1);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
    await writeEvaluationReport(
      report,
      artifactDirectory,
      'agent-runtime-adversarial-latest.json',
    );
    const persisted = JSON.parse(
      await readFile(
        path.join(artifactDirectory, 'agent-runtime-adversarial-latest.json'),
        'utf8',
      ),
    ) as EvaluationReport;
    expect(persisted.summary.total).toBe(512);
  });
});
