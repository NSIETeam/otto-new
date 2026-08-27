/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  decideEnterpriseKnowledgeRetention,
  enterpriseKnowledgeContradictoryEvidenceCount,
  enterpriseKnowledgeObservationSimilarity,
  normalizeEnterpriseKnowledgeAtom,
  synthesizeEnterpriseKnowledgeDocument,
} from './knowledgeRetentionPolicy.js';

const emptySummary = {
  evidenceCount: 1,
  distinctSessionCount: 1,
  distinctContributorCount: 1,
  spanDays: 0,
  averageConfidence: 0.9,
  maximumImpactScore: 0.9,
  hasVerifiedEvidence: true,
};

describe('enterprise knowledge retention policy', () => {
  it('keeps even a verified high-impact conclusion incubating until another session corroborates it', () => {
    expect(decideEnterpriseKnowledgeRetention({
      category: 'solution',
      content: '重大生产事故的根因是租户缓存未隔离，加入企业编号后验证通过。',
      confidence: 0.92,
      verified: true,
    }, emptySummary)).toMatchObject({
      promote: false,
      reason: 'incubating',
    });

    expect(decideEnterpriseKnowledgeRetention({
      category: 'solution',
      content: '重大生产事故的根因是租户缓存未隔离，加入企业编号后验证通过。',
      confidence: 0.92,
      verified: true,
    }, {
      ...emptySummary,
      evidenceCount: 2,
      distinctSessionCount: 2,
      distinctContributorCount: 2,
    })).toMatchObject({
      promote: true,
      reason: 'high_impact_verified',
    });

    expect(decideEnterpriseKnowledgeRetention({
      category: 'research',
      content: '可以考虑以后换一种展示方式。',
      confidence: 0.9,
      verified: false,
    }, emptySummary)).toMatchObject({ promote: false, reason: 'incubating' });

    expect(decideEnterpriseKnowledgeRetention({
      category: 'solution',
      content: '重大生产事故可能与缓存有关，但尚未完成验证。',
      confidence: 0.95,
      verified: true,
    }, emptySummary)).toMatchObject({ promote: false, reason: 'incubating' });
  });

  it('promotes knowledge repeated across sessions and time', () => {
    expect(decideEnterpriseKnowledgeRetention({
      category: 'research',
      content: '客户验收前需要先完成安全扫描。',
      confidence: 0.78,
      verified: false,
    }, {
      evidenceCount: 4,
      distinctSessionCount: 3,
      distinctContributorCount: 1,
      spanDays: 9,
      averageConfidence: 0.79,
      maximumImpactScore: 0.68,
      hasVerifiedEvidence: false,
    })).toMatchObject({ promote: true, reason: 'long_term_recurrence' });
  });

  it('never promotes a personal preference merely because one person repeats it', () => {
    expect(decideEnterpriseKnowledgeRetention({
      category: 'preference',
      content: '我喜欢所有报告都使用蓝色标题。',
      confidence: 0.95,
      verified: true,
    }, {
      evidenceCount: 10,
      distinctSessionCount: 10,
      distinctContributorCount: 1,
      spanDays: 60,
      averageConfidence: 0.95,
      maximumImpactScore: 1,
      hasVerifiedEvidence: true,
    })).toMatchObject({ promote: false, reason: 'incubating' });
  });

  it('rejects temporary conversation state even when it is repeated', () => {
    expect(decideEnterpriseKnowledgeRetention({
      category: 'research',
      content: '本周临时先使用测试账号，明天再决定正式流程。',
      confidence: 0.95,
      verified: true,
    }, {
      evidenceCount: 8,
      distinctSessionCount: 8,
      distinctContributorCount: 4,
      spanDays: 30,
      averageConfidence: 0.95,
      maximumImpactScore: 0.9,
      hasVerifiedEvidence: true,
      contradictoryEvidenceCount: 0,
    })).toMatchObject({ promote: false, reason: 'transient' });
  });

  it('keeps recurring speculation incubating until the claim is actually verified', () => {
    expect(decideEnterpriseKnowledgeRetention({
      category: 'solution',
      content: '生产事故可能与缓存有关，但根因尚未验证。',
      confidence: 0.92,
      verified: false,
    }, {
      evidenceCount: 6,
      distinctSessionCount: 5,
      distinctContributorCount: 3,
      spanDays: 21,
      averageConfidence: 0.86,
      maximumImpactScore: 0.8,
      hasVerifiedEvidence: false,
      contradictoryEvidenceCount: 0,
    })).toMatchObject({
      promote: false,
      reason: 'incubating',
      reasons: expect.arrayContaining(['结论仍含未确认或待验证表述']),
    });
  });

  it('blocks promotion when similar observations contradict one another', () => {
    const evidence = [
      '客户验收前必须完成安全扫描。',
      '客户验收前无需完成安全扫描。',
      '客户验收前必须先完成安全扫描。',
    ];
    expect(enterpriseKnowledgeContradictoryEvidenceCount(evidence)).toBeGreaterThan(0);
    expect(enterpriseKnowledgeContradictoryEvidenceCount([
      '生产环境必须使用双因素认证。',
      '生产环境禁止使用双因素认证。',
    ])).toBe(2);
    expect(decideEnterpriseKnowledgeRetention({
      category: 'convention',
      content: evidence[2],
      confidence: 0.9,
      verified: true,
    }, {
      evidenceCount: 3,
      distinctSessionCount: 3,
      distinctContributorCount: 2,
      spanDays: 9,
      averageConfidence: 0.9,
      maximumImpactScore: 0.9,
      hasVerifiedEvidence: true,
      contradictoryEvidenceCount: 1,
    })).toMatchObject({ promote: false, reason: 'contested' });
  });

  it('synthesizes a traceable organization memory instead of copying one answer', () => {
    const document = synthesizeEnterpriseKnowledgeDocument({
      category: 'convention',
      department: '交付部',
      summary: {
        evidenceCount: 3,
        distinctSessionCount: 3,
        distinctContributorCount: 2,
        spanDays: 12,
        averageConfidence: 0.86,
        maximumImpactScore: 0.82,
        hasVerifiedEvidence: true,
        contradictoryEvidenceCount: 0,
      },
      evidence: [
        { content: '客户验收前必须完成安全扫描。', confidence: 0.84, verified: false, impactScore: 0.7 },
        { content: '交付流程规定：客户验收之前必须完成安全扫描，并保存扫描结果。', confidence: 0.9, verified: true, impactScore: 0.82 },
        { content: '验收前先做安全扫描，扫描报告需纳入交付材料。', confidence: 0.85, verified: true, impactScore: 0.78 },
      ],
    });
    expect(document.title).toContain('安全扫描');
    expect(document.content).toContain('## 长期结论');
    expect(document.content).toContain('## 适用范围');
    expect(document.content).toContain('交付部');
    expect(document.content).toContain('3 条独立证据');
    expect(document.content).toContain('3 个会话');
    expect(document.content).not.toContain('助手：');
  });

  it('reduces transcript-like answers to atomic conclusions and clusters paraphrases', () => {
    const atom = normalizeEnterpriseKnowledgeAtom(
      `助手：这里有很长的背景解释。\n根因是缓存键缺少企业编号。\n修复方案是加入 organizationId。\n验证通过：隔离测试通过。`,
    );
    expect(atom).not.toContain('助手：');
    expect(atom).toContain('根因是缓存键缺少企业编号');
    expect(atom.split('\n')).toHaveLength(3);
    expect(enterpriseKnowledgeObservationSimilarity(
      '缓存键加入企业编号后，跨租户隔离测试通过。',
      '修复缓存串数据：在缓存 key 中增加企业编号，并通过隔离测试。',
    )).toBeGreaterThan(0.3);
  });
});
