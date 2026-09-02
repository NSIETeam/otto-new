/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import {
  buildEnterpriseMemoryHealth,
  enterpriseMemoryUsageScenarios,
} from './enterpriseMemoryHealth.js';

const now = Date.parse('2026-09-02T12:00:00.000Z');

describe('enterprise memory health', () => {
  it('prioritizes conflicts, expiry and review gaps ahead of healthy memories', () => {
    const result = buildEnterpriseMemoryHealth([{
      id: 'trusted', title: '交付检查', category: '流程', content: '交付前安全扫描。',
      confidence: 0.94, status: 'active', verifiedEvidenceCount: 2,
      distinctSessionCount: 3, distinctContributorCount: 2,
      createdAt: '2026-08-01T00:00:00.000Z',
    }, {
      id: 'conflict', title: '退款审批', category: '制度', content: '审批口径存在冲突。',
      confidence: 0.72, status: 'pending_review', sourceLabel: '自动提炼 · 证据存在冲突',
      evidenceCount: 2, createdAt: '2026-09-01T00:00:00.000Z',
    }, {
      id: 'expired', title: '旧报价规则', category: '销售', content: '沿用旧报价。',
      confidence: 0.9, status: 'active', expiresAt: '2026-08-31T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    }], now);

    expect(result.counts).toEqual({ trusted: 1, learning: 0, needs_review: 0, conflicted: 1, expired: 1 });
    expect(result.nodes.map((item) => item.id)).toEqual(['conflict', 'expired', 'trusted']);
    expect(result.nextAction).toMatchObject({ id: 'conflict', actionLabel: '去裁决' });
    expect(result.nextAction?.question).toContain('哪一条正式制度');
    expect(result.governanceScore).toBeLessThan(50);
  });

  it('keeps partially learned knowledge visible and explains what evidence is missing', () => {
    const result = buildEnterpriseMemoryHealth([{
      id: 'learning', title: '周报偏好', category: '写作偏好', content: '周报使用表格。',
      confidence: 0.7, status: 'active', evidenceCount: 1,
      distinctSessionCount: 1, distinctContributorCount: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
    }], now);

    expect(result.nodes[0]).toMatchObject({ status: 'learning', actionLabel: '补充验证' });
    expect(result.nodes[0]?.reasons.join('')).toContain('独立会话');
    expect(result.nodes[0]?.question).toContain('谁能确认');
  });

  it('maps memory categories to understandable automatic-use scenarios', () => {
    expect(enterpriseMemoryUsageScenarios({ category: '合同审批制度', title: '合同规则' }))
      .toEqual(expect.arrayContaining(['回答制度与审批问题', '执行相关工作前检查约束']));
    expect(enterpriseMemoryUsageScenarios({ category: '交付流程', title: '验收步骤' }))
      .toEqual(expect.arrayContaining(['规划同类任务步骤', '生成检查清单和复盘']));
  });
});
