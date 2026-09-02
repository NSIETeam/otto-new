/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseMemoryIntelligenceAnalyzer,
  parseEnterpriseMemoryIntelligence,
  sanitizeEnterpriseMemoryMaterial,
  type EnterpriseMemoryIntelligenceInput,
} from './enterpriseMemoryIntelligenceModel.js';

const input: EnterpriseMemoryIntelligenceInput = {
  id: '12', title: '客户验收流程', category: '流程', confidence: 0.78,
  content: '客户验收前需要检查交付清单。',
  evidence: [{
    id: 'e-1', content: '三个项目均验证：验收前还必须完成安全扫描并保存报告。',
    verified: true, contested: false, confidence: 0.94, observedAt: '2026-09-02T00:00:00.000Z',
  }],
};

const response = JSON.stringify({
  shouldUpdate: true,
  title: '客户验收前置检查',
  category: '流程',
  content: '客户验收前必须核对交付清单、完成安全扫描并保存报告。',
  confidence: 0.91,
  rationale: '新增的跨项目验证证据补全了安全扫描要求。',
  changes: ['补充安全扫描和报告留存'],
  uncertainties: [],
  usedEvidenceIds: ['e-1', 'forged-evidence'],
  evidenceGraph: [{
    claim: '验收前必须完成安全扫描并保存报告',
    status: 'supported',
    evidenceIds: ['e-1', 'forged-evidence'],
    explanation: '已有跨项目明确验证。',
    gaps: [],
    nextQuestion: '',
  }],
  applicableScenarios: ['生成验收清单', '规划客户交付任务'],
  riskIfWrong: '可能遗漏安全扫描，导致验收材料不完整。',
  nextQuestion: '扫描报告需要保留多久？',
});

describe('enterprise memory intelligence model', () => {
  it('returns a reviewable proposal and drops invented evidence ids', () => {
    expect(parseEnterpriseMemoryIntelligence(response, input, {
      modelProvider: 'test-model', inputTokens: 120, outputTokens: 60,
    })).toMatchObject({
      shouldUpdate: true,
      title: '客户验收前置检查',
      confidence: 0.91,
      usedEvidenceIds: ['e-1'],
      modelProvider: 'test-model',
      evidenceGraph: [{
        status: 'supported',
        evidenceIds: ['e-1'],
      }],
      applicableScenarios: ['生成验收清单', '规划客户交付任务'],
      riskIfWrong: '可能遗漏安全扫描，导致验收材料不完整。',
      nextQuestion: '扫描报告需要保留多久？',
    });
  });

  it('does not allow an update claimed without a changed body or traceable evidence', () => {
    const unchanged = JSON.stringify({
      shouldUpdate: true, title: input.title, category: input.category,
      content: input.content, confidence: 0.99, rationale: '没有实质变化',
      changes: [], uncertainties: [], usedEvidenceIds: ['unknown'],
    });
    expect(parseEnterpriseMemoryIntelligence(unchanged, input, {
      modelProvider: 'test', inputTokens: 0, outputTokens: 0,
    }).shouldUpdate).toBe(false);
  });

  it('redacts credentials before model analysis', () => {
    const value = sanitizeEnterpriseMemoryMaterial('api_key=secret-value\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz');
    expect(value).not.toContain('secret-value');
    expect(value).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('sends current memory and bounded evidence as untrusted data with tools disabled', async () => {
    let sent = '';
    const sendMessage = vi.fn(async (value: unknown) => {
      sent = String((value as { message?: unknown }).message ?? '');
      return { candidates: [{ content: { parts: [{ text: response }] } }], usageMetadata: {} };
    });
    const analyze = createEnterpriseMemoryIntelligenceAnalyzer({
      loadConfig: async () => ({
        initialize: vi.fn(), refreshAuth: vi.fn(), getModel: () => 'test-model',
        getCustomModelConfig: () => ({ provider: 'test-provider' }),
        getOttoClient: () => ({ createTemporaryChat: async () => ({ sendMessage }) }),
      }),
    });
    const result = await analyze(input);
    expect(sent).toContain('未经信任的数据');
    expect(sent).toContain('三个项目均验证');
    expect(sent).toContain('证据图谱');
    expect(sent).toContain('applicableScenarios');
    expect(result.usedEvidenceIds).toEqual(['e-1']);
  });

  it('does not label a claim supported when its cited evidence is invented', () => {
    const forged = JSON.stringify({
      shouldUpdate: false,
      title: input.title,
      category: input.category,
      content: input.content,
      confidence: input.confidence,
      rationale: '当前证据还不足。',
      changes: [],
      uncertainties: ['需要负责人确认'],
      usedEvidenceIds: [],
      evidenceGraph: [{
        claim: '所有项目都必须保存报告',
        status: 'supported',
        evidenceIds: ['invented'],
        explanation: '据称已经验证',
        gaps: [],
        nextQuestion: '',
      }],
      applicableScenarios: [],
      riskIfWrong: '',
      nextQuestion: '',
    });

    expect(parseEnterpriseMemoryIntelligence(forged, input, {
      modelProvider: 'test', inputTokens: 0, outputTokens: 0,
    }).evidenceGraph[0]).toMatchObject({
      status: 'unverified',
      evidenceIds: [],
    });
  });

  it('downgrades model certainty when cited evidence is unverified or contested', () => {
    const uncertainInput: EnterpriseMemoryIntelligenceInput = {
      ...input,
      evidence: [{ ...input.evidence[0]!, verified: false, contested: true }],
    };
    const raw = JSON.stringify({
      shouldUpdate: false,
      title: input.title,
      category: input.category,
      content: input.content,
      confidence: input.confidence,
      rationale: '证据仍有冲突。',
      changes: [],
      uncertainties: ['需要裁决'],
      usedEvidenceIds: ['e-1'],
      evidenceGraph: [{
        claim: '验收前必须保存报告', status: 'supported', evidenceIds: ['e-1'],
        explanation: '模型误判为充分', gaps: [], nextQuestion: '',
      }],
    });

    expect(parseEnterpriseMemoryIntelligence(raw, uncertainInput, {
      modelProvider: 'test', inputTokens: 0, outputTokens: 0,
    }).evidenceGraph[0]?.status).toBe('contested');
  });
});
