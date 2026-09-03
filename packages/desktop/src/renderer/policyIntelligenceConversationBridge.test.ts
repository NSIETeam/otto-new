import { describe, expect, it, vi } from 'vitest';
import {
  handlePolicyIntelligenceConversation,
  PolicyConversationRegistry,
} from './policyIntelligenceConversationBridge.js';
import { emptyPolicyState } from './policyIntelligencePresentation.js';
import type { PolicyIntelligenceState } from '../preload/index.js';
function harness() {
  const state: PolicyIntelligenceState = {
    ...emptyPolicyState(),
    canManage: true,
    enabled: true,
    region: { country: 'CN', city: '上海市' },
    policies: [
      {
        id: 'p',
        title: '数字化专项',
        url: 'https://www.gov.cn/p',
        sourceId: 's',
        sourceName: '国务院',
        issuer: '国务院',
        level: 'national',
        region: { country: 'CN' },
        categories: ['数字化转型'],
        fetchedAt: '2026-09-03',
        contentHash: 'v1',
        version: 1,
        bodyText: '原文',
        summary: '',
        supportText: '',
        conditions: [],
        conditionTree: { all: [] },
        materials: [],
        resources: [],
        attachments: [],
        sourceStatus: 'verified',
        interpretationStatus: 'ready',
      },
    ],
  };
  const input = {
    scopeId: 'o:a',
    sessionId: 's',
    registry: new PolicyConversationRegistry(),
    getState: vi.fn(async () => state),
    act: vi.fn(async () => state),
    postMessage: vi.fn(),
  };
  return {
    input,
    state,
    say: (text: string) =>
      handlePolicyIntelligenceConversation({ ...input, text }),
  };
}
describe('政策对话与模块共用服务', () => {
  it('对话展示排除依据，并将否和不确定按服务端字段类型传递', async () => {
    const h = harness();
    h.state.diagnoses = [
      {
        id: 'd',
        accountId: 'a',
        policyId: 'p',
        policyVersion: 1,
        policyContentHash: 'v1',
        revision: 1,
        status: 'unknown',
        summary: '排除事实待核实',
        conditions: [],
        gaps: [],
        missingFields: ['blacklisted'],
        resourceConnections: [],
        assessedAt: '2026-09-03',
        profileFingerprint: 'f',
        factVersion: 'f',
        answers: {},
        stale: false,
        group: 'evaluate',
        question: {
          field: 'blacklisted',
          label: '是否列入失信名单？',
          valueType: 'boolean',
        },
        exclusions: [
          {
            id: 'credit',
            label: '失信限制',
            quote: '失信企业不予支持',
            result: 'unknown',
            missingFields: ['blacklisted'],
          },
        ],
      },
    ];
    await h.say('有哪些政策');
    await h.say('诊断第1项');
    await h.say('同意诊断');
    expect(
      h.input.postMessage.mock.calls.some(([, text]) =>
        text.includes('失信企业不予支持'),
      ),
    ).toBe(true);
    await h.say('否');
    expect(h.input.act).toHaveBeenLastCalledWith({
      action: 'answer',
      diagnosisId: 'd',
      revision: 1,
      field: 'blacklisted',
      value: false,
    });
    await h.say('不确定');
    expect(h.input.act).toHaveBeenLastCalledWith({
      action: 'answer',
      diagnosisId: 'd',
      revision: 1,
      field: 'blacklisted',
      value: null,
    });
  });
  it('浏览不触发模型，诊断需要单独同意', async () => {
    const h = harness();
    expect(await h.say('有哪些适合我们公司的政策')).toBe(true);
    expect(h.input.act).not.toHaveBeenCalled();
    await h.say('诊断第1项');
    expect(h.input.act).not.toHaveBeenCalled();
    await h.say('同意诊断');
    expect(h.input.act).toHaveBeenCalledWith({
      action: 'diagnose',
      policyId: 'p',
      consent: true,
    });
  });
  it('上海企业资料按单题收集，不限制北京，并在共享前确认', async () => {
    const h = harness();
    h.state.missingProfileFields = ['registeredRegion', 'industry'];
    await h.say('完善政策企业资料');
    await h.say('上海市浦东新区');
    expect(h.input.act).not.toHaveBeenCalled();
    await h.say('软件研发');
    await h.say('确认保存');
    expect(h.input.act).toHaveBeenCalledWith({
      action: 'profile',
      profile: { registeredRegion: '上海市浦东新区', industry: '软件研发' },
      consent: true,
    });
  });
  it('账号和会话隔离，取消及无关提问不会继续提交', async () => {
    const h = harness();
    await h.say('有哪些政策');
    await h.say('诊断第1项');
    expect(
      await handlePolicyIntelligenceConversation({
        ...h.input,
        scopeId: 'o:b',
        text: '同意诊断',
      }),
    ).toBe(false);
    await h.say('取消');
    await h.say('同意诊断');
    expect(h.input.act).not.toHaveBeenCalled();
    expect(await h.say('帮我写一段代码')).toBe(false);
  });
});
