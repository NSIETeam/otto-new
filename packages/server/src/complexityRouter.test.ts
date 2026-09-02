/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { routeTurnComplexity } from './complexityRouter.js';

describe('routeTurnComplexity', () => {
  it('keeps a single factual answer on the direct route', () => {
    expect(
      routeTurnComplexity({
        text: '1 + 1 等于多少？',
        intent: 'answer',
        riskLevel: 'read_only',
        toolFree: false,
      }),
    ).toMatchObject({
      level: 'simple',
      route: 'direct',
      recommendedParallelism: 1,
      requiresTaskGraph: false,
      exposesWorkflowTool: false,
    });
  });

  it('automatically routes a broad cross-layer change to an orchestrated workflow without a magic word', () => {
    const profile = routeTurnComplexity({
      text: '全面检查前端、服务端、数据库迁移和各个分支，修复问题，补充测试并完成生产构建，不允许遗漏最新功能',
      intent: 'change',
      riskLevel: 'local_write',
      toolFree: false,
    });

    expect(profile.level).toBe('orchestrated');
    expect(profile.route).toBe('workflow');
    expect(profile.recommendedParallelism).toBeGreaterThanOrEqual(3);
    expect(profile.requiresTaskGraph).toBe(true);
    expect(profile.exposesWorkflowTool).toBe(true);
    expect(profile.reasons).toEqual(
      expect.arrayContaining(['cross_layer', 'broad_scope', 'multi_objective']),
    );
  });

  it('uses bounded parallel reads for source comparison', () => {
    expect(
      routeTurnComplexity({
        text: '查找并比较三家供应商的官方资料，核实价格和许可证',
        intent: 'research',
        riskLevel: 'read_only',
        toolFree: false,
      }),
    ).toMatchObject({
      route: 'parallel_tools',
      requiresTaskGraph: true,
      exposesWorkflowTool: false,
    });
  });

  it('fails closed for destructive, external-write, and tool-free turns', () => {
    for (const input of [
      {
        text: '清空生产数据库并删除全部账户',
        riskLevel: 'destructive' as const,
        toolFree: false,
      },
      {
        text: '发布版本并部署到线上服务器',
        riskLevel: 'external_write' as const,
        toolFree: false,
      },
      {
        text: '全面分析全部代码',
        riskLevel: 'read_only' as const,
        toolFree: true,
      },
    ]) {
      const profile = routeTurnComplexity({ ...input, intent: 'change' });
      expect(profile.exposesWorkflowTool).toBe(false);
      expect(profile.recommendedParallelism).toBe(1);
      expect(['restricted', 'planned_agent']).toContain(profile.route);
    }
  });

  it('recognizes multiple independent runtime objectives and assigns a bounded budget', () => {
    const profile = routeTurnComplexity({
      text: '优化自动复杂度路由、显式任务图、压缩后目标校验和大规模真实评测',
      intent: 'change',
      riskLevel: 'local_write',
      toolFree: false,
    });
    expect(['complex', 'orchestrated']).toContain(profile.level);
    expect(['subagents', 'workflow']).toContain(profile.route);
    expect(profile.reasons).toContain('multi_objective');
    expect(profile.budget.maxParallelTools).toBeGreaterThanOrEqual(2);
    expect(profile.budget.maxModelRounds).toBeGreaterThanOrEqual(12);
    expect(profile.budget.maxToolCalls).toBeGreaterThan(
      profile.budget.maxParallelTools,
    );
  });

  it('does not escalate a conceptual question just because it mentions workflow', () => {
    for (const text of ['workflow 是什么意思？', '任务图是什么？']) {
      expect(
        routeTurnComplexity({
          text,
          intent: 'answer',
          riskLevel: 'read_only',
          toolFree: false,
        }),
      ).toMatchObject({
        level: 'simple',
        route: 'direct',
        requiresTaskGraph: false,
        exposesWorkflowTool: false,
      });
    }
  });
});
