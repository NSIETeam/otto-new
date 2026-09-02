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
    expect(result.usedEvidenceIds).toEqual(['e-1']);
  });
});
