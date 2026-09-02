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
  type TurnExecutionRoute,
  type TurnIntent,
  type TurnRiskLevel,
} from '../../server/src/index.js';
import { runDeterministicScenarios, writeEvaluationReport } from './runner.js';
import type { DeterministicScenario, EvaluationReport } from './contracts.js';

const artifactDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../artifacts',
);

const ROUTE_SUFFIXES = [
  '',
  '请给出可复核证据。',
  '不要遗漏失败分支。',
  '完成后核对目标。',
] as const;

const routeCases: ReadonlyArray<{
  id: string;
  text: string;
  intent: TurnIntent;
  risk: TurnRiskLevel;
  route: TurnExecutionRoute;
  workflow: boolean;
}> = [
  {
    id: 'fact',
    text: '解释闭包是什么',
    intent: 'answer',
    risk: 'read_only',
    route: 'direct',
    workflow: false,
  },
  {
    id: 'research',
    text: '查找并比较三家供应商的官方资料',
    intent: 'research',
    risk: 'read_only',
    route: 'parallel_tools',
    workflow: false,
  },
  {
    id: 'diagnose',
    text: '排查登录白屏为什么发生',
    intent: 'diagnose',
    risk: 'read_only',
    route: 'parallel_tools',
    workflow: false,
  },
  {
    id: 'local-change',
    text: '修改登录组件并运行测试',
    intent: 'change',
    risk: 'local_write',
    route: 'planned_agent',
    workflow: false,
  },
  {
    id: 'artifact',
    text: '生成一份产品说明文档并验证',
    intent: 'create_artifact',
    risk: 'local_write',
    route: 'planned_agent',
    workflow: false,
  },
  {
    id: 'enterprise',
    text: '配置企业成员权限并核对回执',
    intent: 'enterprise_action',
    risk: 'local_write',
    route: 'planned_agent',
    workflow: false,
  },
  {
    id: 'cross-layer',
    text: '全面检查前端、服务端、数据库迁移和所有分支，修复问题，补充测试并完成生产构建',
    intent: 'change',
    risk: 'local_write',
    route: 'workflow',
    workflow: true,
  },
  {
    id: 'external',
    text: '全面核对版本然后发布并部署线上服务器',
    intent: 'change',
    risk: 'external_write',
    route: 'planned_agent',
    workflow: false,
  },
  {
    id: 'destructive',
    text: '清空生产数据库并删除全部账户',
    intent: 'change',
    risk: 'destructive',
    route: 'planned_agent',
    workflow: false,
  },
  {
    id: 'explicit-graph',
    text: '用任务图并行检查前端、后端和测试，修复并完成构建',
    intent: 'change',
    risk: 'local_write',
    route: 'workflow',
    workflow: true,
  },
];

const routeScenarios: DeterministicScenario[] = routeCases.flatMap((fixture) =>
  ROUTE_SUFFIXES.map((suffix, index) => ({
    id: `route-${fixture.id}-${index + 1}`,
    lane: 'planning' as const,
    description: `Real-world complexity routing fixture: ${fixture.id}`,
    requiredEvidence: ['assertion' as const, 'plan_revision' as const],
    async execute() {
      const profile = routeTurnComplexity({
        text: `${fixture.text}${suffix}`,
        intent: fixture.intent,
        riskLevel: fixture.risk,
        toolFree: false,
      });
      return {
        passed:
          profile.route === fixture.route &&
          profile.exposesWorkflowTool === fixture.workflow &&
          (fixture.risk === 'read_only' ||
            profile.recommendedParallelism === 1 ||
            fixture.workflow),
        evidence: [
          {
            kind: 'assertion' as const,
            summary: `route=${profile.route}; level=${profile.level}`,
          },
          {
            kind: 'plan_revision' as const,
            summary: `graph=${profile.requiresTaskGraph}; parallel=${profile.recommendedParallelism}`,
          },
        ],
      };
    },
  })),
);

const graphPrompts = [
  '全面检查前端和服务端，修复问题并完成测试',
  '排查企业登录异常并验证修复',
  '生成园区服务报告并校验产物',
  '检查消息持久化，修改接口并运行回归测试',
  '比较公开来源并形成有引用的结论',
  '重构权限判断并完成类型检查',
  '检查数据库迁移、API 和 UI 并完成构建',
  '修复桌宠拖动并运行交互回归测试',
] as const;

const graphAdaptations = [
  {
    category: 'stale_state',
    action: 'switch_strategy',
    strategy: 'refresh_state',
  },
  {
    category: 'permission',
    action: 'request_input',
    strategy: 'request_access',
  },
  {
    category: 'context_overflow',
    action: 'compact_context',
    strategy: 'compact_context',
  },
  {
    category: 'unknown_side_effect',
    action: 'reconcile',
    strategy: 'reconcile_outcome',
  },
] as const;

const graphScenarios: DeterministicScenario[] = graphPrompts.flatMap(
  (text, promptIndex) =>
    graphAdaptations.map((adaptation, adaptationIndex) => ({
      id: `graph-${promptIndex + 1}-${adaptationIndex + 1}`,
      lane: 'recovery' as const,
      description:
        'Explicit graph preserves completed work across a strategy change.',
      requiredEvidence: ['tool_trace' as const, 'plan_revision' as const],
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
          },
        ]);
        graph.applyAdaptation({
          revision: 1,
          timestamp: 1_800_000_000_000 + promptIndex,
          category: adaptation.category,
          action: adaptation.action,
          toolName: 'fixture_tool',
          attempt: 1,
        });
        const snapshot = graph.snapshot();
        const recovery = snapshot.nodes.find((node) => node.kind === 'recover');
        return {
          passed:
            snapshot.revision === 2 &&
            snapshot.nodes.find((node) => node.kind === 'gather')?.status ===
              'completed' &&
            recovery?.strategy === adaptation.strategy &&
            snapshot.revisions
              .at(-1)
              ?.preservedNodeIds.includes('graph-gather') === true,
          evidence: [
            {
              kind: 'tool_trace' as const,
              summary: 'successful read completed graph-gather',
            },
            {
              kind: 'plan_revision' as const,
              summary: `revision=2; strategy=${recovery?.strategy}`,
            },
          ],
        };
      },
    })),
);

const goalFixtures = [
  '继续完成自动复杂度路由',
  '修复企业登录授权判断',
  '完成园区工单消息回流',
  '生成并验证产品演示文稿',
  '重构桌宠全屏拖动',
  '实现招聘音频分析',
  '完成 MCP 安全审计',
  '核对旧用户自动更新',
] as const;
const constraintFixtures = [
  '必须保留已通过测试',
  '不允许推送服务器',
  '不得覆盖用户文件',
  '必须在完成后运行类型检查',
] as const;

const compactionScenarios: DeterministicScenario[] = goalFixtures.flatMap(
  (goal, goalIndex) =>
    constraintFixtures.map((constraint, constraintIndex) => ({
      id: `compaction-${goalIndex + 1}-${constraintIndex + 1}`,
      lane: 'context' as const,
      description:
        'Compaction restores and validates active objectives, constraints, and evidence.',
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
            parts: [
              {
                text: `已完成第 ${goalIndex + 1} 阶段，packages/server/src/taskGraph.ts 已通过测试。`,
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'verify_task_graph',
                  response: {
                    success: true,
                    output: 'packages/server/src/taskGraph.ts verified',
                  },
                },
              },
            ],
          },
        ];
        const snapshot = captureCompressionInvariants(history, 2);
        const restored = appendCompressionInvariantSnapshot(
          '结构化摘要',
          snapshot,
        );
        const valid = validateCompressionInvariants(snapshot, [
          { role: 'user', parts: [{ text: restored }] },
        ]);
        const invalid = validateCompressionInvariants(snapshot, [
          { role: 'user', parts: [{ text: '丢失约束的摘要' }] },
        ]);
        return {
          passed:
            snapshot.goals.some((item) => item.includes(goal)) &&
            snapshot.constraints.some((item) => item.includes(constraint)) &&
            snapshot.evidence.length > 0 &&
            valid.valid &&
            !invalid.valid,
          evidence: [
            {
              kind: 'context_compaction' as const,
              summary: `goal=${goalIndex + 1}; constraint=${constraintIndex + 1}`,
            },
            {
              kind: 'verification' as const,
              summary: `valid=${valid.valid}; tamperRejected=${!invalid.valid}`,
            },
          ],
        };
      },
    })),
);

const failureFixtures = [
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

const adaptiveScenarios: DeterministicScenario[] = failureFixtures.flatMap(
  (fixture, fixtureIndex) =>
    [1, 2, 3, 4].map((variant) => ({
      id: `adaptive-${fixtureIndex + 1}-${variant}`,
      lane: 'policy' as const,
      description:
        'Failure classification chooses a bounded, side-effect-aware strategy.',
      requiredEvidence: ['tool_trace' as const, 'assertion' as const],
      async execute() {
        const coordinator = new AdaptiveExecutionCoordinator();
        const input = {
          toolName: `fixture_tool_${variant}`,
          callFingerprint: `fixture-${fixtureIndex}-${variant}`,
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
            (fixture.sideEffect !== 'external_write' || !first.retryAllowed),
          evidence: [
            {
              kind: 'tool_trace' as const,
              summary: `category=${first.category}; attempts=${second.attempt}`,
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

describe('large representative agent runtime matrix', () => {
  it('passes at least 120 deterministic real-task regressions with complete evidence', async () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(120);
    const report = await runDeterministicScenarios(scenarios);
    expect(report.summary.total).toBe(scenarios.length);
    expect(report.summary.passRate).toBe(1);
    expect(report.summary.evidenceCoverage).toBe(1);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
    await writeEvaluationReport(
      report,
      artifactDirectory,
      'agent-runtime-matrix-latest.json',
    );
    const persisted = JSON.parse(
      await readFile(
        path.join(artifactDirectory, 'agent-runtime-matrix-latest.json'),
        'utf8',
      ),
    ) as EvaluationReport;
    expect(persisted.summary.total).toBe(scenarios.length);
  });
});
