/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  PolicyConversationRegistry,
  handlePolicyIntelligenceConversation,
} from './policyIntelligenceConversationBridge.js';

const DETAIL_URL = 'https://kw.beijing.gov.cn/zwgk/zwgksbrl/202609/t20260901_1.html';

function harness(overrides: Record<string, unknown> = {}) {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  return {
    messages,
    input: {
      text: '', scopeId: 'org-a', sessionId: 'session-a', registry: new PolicyConversationRegistry(),
      getState: vi.fn(async () => ({
        enabled: true,
        profile: { organizationName: '甲公司' },
        policies: [], assessments: [], syncStatus: 'idle' as const,
      })),
      sync: vi.fn(async () => ({
        enabled: true,
        profile: { organizationName: '甲公司', registeredRegion: '北京市昌平区', industry: '企业软件' },
        policies: [], assessments: [], syncStatus: 'idle' as const,
      })),
      updateProfile: vi.fn(),
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      ...overrides,
    },
  };
}

describe('政策智能服务对话桥', () => {
  it('服务关闭时明确提示开启且不静默联网', async () => {
    const state = harness({ getState: vi.fn(async () => ({ enabled: false, profile: {}, policies: [], assessments: [], syncStatus: 'idle' })) });
    expect(await handlePolicyIntelligenceConversation({ ...state.input, text: '我们公司最近能申报什么政策？' })).toBe(true);
    expect(state.messages.at(-1)?.text).toContain('当前未开启');
    expect(state.input.sync).not.toHaveBeenCalled();
  });

  it('资料不足时主动追问，补充后必须确认才保存并重评估', async () => {
    const state = harness();
    await handlePolicyIntelligenceConversation({ ...state.input, text: '我们公司最近能申报什么政策？' });
    expect(state.messages.at(-1)?.text).toContain('注册地区');
    expect(state.messages.at(-1)?.text).toContain('主营行业');

    await handlePolicyIntelligenceConversation({ ...state.input, text: '注册在北京昌平，主营企业软件' });
    expect(state.messages.at(-1)?.text).toContain('确认保存');
    expect(state.input.updateProfile).not.toHaveBeenCalled();

    await handlePolicyIntelligenceConversation({ ...state.input, text: '确认保存并重新评估' });
    expect(state.input.updateProfile).toHaveBeenCalledWith(expect.objectContaining({
      registeredRegion: '北京市昌平区', industry: '企业软件',
    }));
    expect(state.input.sync).toHaveBeenCalled();
  });

  it('在对话里返回判断、缺口和官方原文链接', async () => {
    const state = harness({
      getState: vi.fn(async () => ({
        enabled: true, profile: { organizationName: '甲公司', registeredRegion: '北京市', industry: '软件' }, syncStatus: 'idle',
        policies: [{ id: 'p1', title: '软件企业研发补助', url: DETAIL_URL, sourceName: '北京市科委', publishedAt: '2026-09-01', fetchedAt: '2026-09-02T00:00:00.000Z', contentHash: 'a', bodyText: '原文' }],
        assessments: [{ policyId: 'p1', status: 'has_gaps', score: 70, summary: '行业匹配', conditions: [], gaps: ['研发费用比例还差 2 个百分点'], missingFields: [], resourceConnections: ['市科委申报平台'], assessedAt: '2026-09-02T00:00:00.000Z', profileFingerprint: 'b', policyContentHash: 'a' }],
      })),
    });
    await handlePolicyIntelligenceConversation({ ...state.input, text: '这个政策我们还差什么条件？' });
    expect(state.messages.at(-1)?.text).toContain('研发费用比例还差 2 个百分点');
    expect(state.messages.at(-1)?.text).toContain(DETAIL_URL);
    expect(state.messages.at(-1)?.text).toContain('辅助判断');
  });

  it('模型标记企业材料不明确时主动追问金额资料并继续走确认', async () => {
    const state = harness({
      getState: vi.fn(async () => ({
        enabled: true, profile: { organizationName: '甲公司', registeredRegion: '北京市', industry: '软件' }, syncStatus: 'idle',
        policies: [{ id: 'p1', title: '研发补助', url: DETAIL_URL, sourceName: '北京市科委', fetchedAt: '2026-09-02T00:00:00.000Z', contentHash: 'a', bodyText: '原文' }],
        assessments: [{ policyId: 'p1', status: 'unknown', score: 40, summary: '缺少经营数据', conditions: [], gaps: [], missingFields: ['annualRevenueCny', 'rdExpenseCny'], resourceConnections: [], assessedAt: '2026-09-02T00:00:00.000Z', profileFingerprint: 'b', policyContentHash: 'a' }],
      })),
    });
    await handlePolicyIntelligenceConversation({ ...state.input, text: '我们能申报哪些政策？' });
    expect(state.messages.at(-1)?.text).toContain('年营业收入');
    expect(state.messages.at(-1)?.text).toContain('研发费用');

    await handlePolicyIntelligenceConversation({ ...state.input, text: '年营业收入500万元，研发费用80万元' });
    expect(state.messages.at(-1)?.text).toContain('确认保存');
    await handlePolicyIntelligenceConversation({ ...state.input, text: '确认保存并重新评估' });
    expect(state.input.updateProfile).toHaveBeenCalledWith(expect.objectContaining({ annualRevenueCny: 5_000_000, rdExpenseCny: 800_000 }));
  });
});
