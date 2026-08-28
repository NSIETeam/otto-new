/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildEnterpriseKnowledgePromptContext } from './enterpriseKnowledgePromptContext.js';

describe('enterprise knowledge prompt context', () => {
  it('includes citations and excludes pending or archived records', () => {
    const context = buildEnterpriseKnowledgePromptContext([
      {
        id: '12', organizationId: 'org-1', sourceId: 'policy-1', title: '合同审批规则',
        department: '法务部', category: 'policy', content: '合同必须经过法务复核。',
        contributor: '管理员', confidence: 0.95, status: 'active', version: 3,
        sourceLabel: '员工手册 2026', createdAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: '13', organizationId: 'org-1', sourceId: 'candidate-1', title: '未经确认',
        department: '法务部', category: 'draft', content: '不能进入回答。',
        contributor: '成员', confidence: 0.8, status: 'pending_review', version: 1,
        createdAt: '2026-07-02T00:00:00.000Z',
      },
    ]);

    expect(context).toContain('[企业知识#12 v3]');
    expect(context).toContain('员工手册 2026');
    expect(context).not.toContain('不能进入回答');
  });

  it('excludes stale auto-captured memory from operational context', () => {
    const context = buildEnterpriseKnowledgePromptContext([{
      id: 'stale-1', organizationId: 'org-1', sourceId: 'retention-1', title: '旧部署流程',
      department: '研发部', category: 'solution', content: '生产部署使用旧网关。',
      contributor: null, confidence: 0.74, status: 'active', version: 2,
      sourceType: 'auto_capture', evidenceCount: 4, distinctSessionCount: 4,
      distinctContributorCount: 2, verifiedEvidenceCount: 1,
      lastObservedAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z',
    }]);

    expect(context).not.toContain('生产部署使用旧网关');
    expect(context).toContain('已排除 1 条不可直接使用的企业记忆');
    expect(context).toContain('超过 180 天未获新证据');
  });

  it('fails closed when an active record still carries a conflict marker', () => {
    const context = buildEnterpriseKnowledgePromptContext([{
      id: 'conflict-1', organizationId: 'org-1', sourceId: 'retention-conflict',
      title: '生产认证规则', department: '安全部', category: 'convention',
      content: '生产环境禁止启用双因素认证。', contributor: null,
      confidence: 0.3, status: 'active', version: 3, sourceType: 'auto_capture',
      sourceLabel: '证据存在冲突，需人工裁决', createdAt: new Date().toISOString(),
    }]);

    expect(context).not.toContain('生产环境禁止启用双因素认证');
    expect(context).toContain('存在尚未裁决的证据冲突');
  });

  it('bounds context size', () => {
    const context = buildEnterpriseKnowledgePromptContext(Array.from({ length: 20 }, (_, index) => ({
      id: String(index), organizationId: 'org-1', sourceId: null, department: null,
      category: 'long', content: 'x'.repeat(2_000), contributor: null,
      confidence: 1, status: 'active' as const, createdAt: '2026-07-01T00:00:00.000Z',
    })));
    expect(context.length).toBeLessThanOrEqual(8_000);
  });
});
