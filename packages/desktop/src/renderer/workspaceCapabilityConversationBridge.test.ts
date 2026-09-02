/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceCapabilityDraftRegistry,
  handleWorkspaceCapabilityConversation,
} from './workspaceCapabilityConversationBridge.js';

function harness(overrides: Record<string, unknown> = {}) {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  return {
    input: {
      text: '',
      accountId: 'account-a',
      sessionId: 'session-a',
      enterpriseMemoryEnabled: true,
      role: 'company_admin' as const,
      experts: [
        { id: 'agent-ppt', label: 'PPT 创作专家', profileId: 'ppt', available: true },
        { id: 'agent-word', label: 'Word 文档专家', profileId: 'doc', available: true },
        { id: 'agent-disabled', label: '停用专家', profileId: 'disabled', available: false },
      ],
      autoSkillCandidates: [{
        id: 'skill-1',
        name: '周报生成',
        description: '根据工作日志生成周报',
        detectedPattern: '连续三周生成周报',
        occurrenceCount: 3,
        draft: {
          validationPassed: true,
          packageReady: true,
          validationErrors: [],
          validationWarnings: [],
          tests: [{ name: 'schema', status: 'passed' as const, detail: '通过' }],
          risk: {
            permissions: ['读取工作日志'],
            fileChanges: ['skills/weekly-report/SKILL.md'],
            securityRisks: [],
            executionBlocked: false,
          },
        },
      }],
      registry: new WorkspaceCapabilityDraftRegistry(),
      listKnowledge: vi.fn(async () => []),
      recordKnowledge: vi.fn(async () => ({ status: 'added' as const, added: true })),
      launchExpert: vi.fn(() => true),
      selectExpert: vi.fn(),
      openSkillZone: vi.fn(),
      confirmAutoSkill: vi.fn(),
      rejectAutoSkill: vi.fn(),
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      ...overrides,
    },
    messages,
  };
}

describe('剩余工作区能力对话桥', () => {
  it('统一草稿中心展示企业知识并使用 ID 阻止旧卡片发布', async () => {
    const state = harness();
    await handleWorkspaceCapabilityConversation({
      ...state.input,
      text: '把员工出差必须提前申请记入企业知识',
    });
    await handleWorkspaceCapabilityConversation({ ...state.input, text: '出差申请制度' });
    const summary = state.input.registry.summary('account-a', 'session-a');
    expect(summary).toMatchObject({
      source: 'enterprise-knowledge', title: '出差申请制度',
      phase: 'awaiting_confirmation', confirmationText: '确认发布企业知识',
    });
    await handleWorkspaceCapabilityConversation({
      ...state.input,
      text: '确认发布企业知识',
      expectedDraftId: `${summary!.id}:stale`,
    });
    expect(state.input.recordKnowledge).not.toHaveBeenCalled();
    expect(state.messages.at(-1)?.text).toContain('已变化或过期');
  });

  it('查询企业记忆时只返回已发布且未过期的结果', async () => {
    const listKnowledge = vi.fn(async () => [{
      id: 'knowledge-1', title: '请假制度', category: '制度流程', content: '员工请假应提前提交审批。',
      confidence: 0.95, status: 'active' as const, sourceLabel: '人事制度', createdAt: '2026-09-01T00:00:00.000Z',
    }, {
      id: 'knowledge-2', title: '旧制度', category: '制度流程', content: '不应展示',
      confidence: 0.8, status: 'active' as const, expiresAt: '2026-01-01T00:00:00.000Z', createdAt: '2025-01-01T00:00:00.000Z',
    }, {
      id: 'knowledge-3', title: '待审核', category: '制度流程', content: '不应展示',
      confidence: 0.8, status: 'pending_review' as const, createdAt: '2026-09-01T00:00:00.000Z',
    }]);
    const { input, messages } = harness({ listKnowledge });

    expect(await handleWorkspaceCapabilityConversation({ ...input, text: '在企业知识里查请假制度' })).toBe(true);
    expect(listKnowledge).toHaveBeenCalledWith({ query: '请假制度' });
    expect(messages.at(-1)?.text).toContain('请假制度');
    expect(messages.at(-1)?.text).not.toContain('旧制度');
    expect(messages.at(-1)?.text).not.toContain('待审核');
  });

  it('管理员可以在对话中查看零模型消耗的记忆健康图谱和下一条确认问题', async () => {
    const listKnowledge = vi.fn(async () => [{
      id: 'knowledge-conflict', title: '退款审批规则', category: '制度',
      content: '存在两种审批口径。', confidence: 0.7, status: 'pending_review' as const,
      sourceLabel: '自动提炼 · 证据存在冲突', evidenceCount: 2,
      createdAt: '2026-09-01T00:00:00.000Z',
    }, {
      id: 'knowledge-trusted', title: '交付安全扫描', category: '流程',
      content: '验收前完成扫描。', confidence: 0.94, status: 'active' as const,
      verifiedEvidenceCount: 2, distinctSessionCount: 3, distinctContributorCount: 2,
      createdAt: '2026-09-01T00:00:00.000Z',
    }]);
    const health = harness({ listKnowledge });

    expect(await handleWorkspaceCapabilityConversation({
      ...health.input, text: '查看企业记忆健康图谱',
    })).toBe(true);
    expect(listKnowledge).toHaveBeenCalledWith({ includeReview: true });
    expect(health.messages.at(-1)?.text).toContain('治理完成度');
    expect(health.messages.at(-1)?.text).toContain('存在冲突：1');

    const next = harness({ listKnowledge });
    expect(await handleWorkspaceCapabilityConversation({
      ...next.input, text: '企业记忆下一步需要确认什么',
    })).toBe(true);
    expect(next.messages.at(-1)?.text).toContain('哪一条正式制度');
    expect(next.messages.at(-1)?.text).toContain('右侧“企业记忆”');
  });

  it('普通成员不能通过对话读取企业记忆治理队列', async () => {
    const listKnowledge = vi.fn(async () => []);
    const state = harness({ role: 'member', listKnowledge });

    expect(await handleWorkspaceCapabilityConversation({
      ...state.input, text: '企业记忆还有什么需要确认',
    })).toBe(true);
    expect(listKnowledge).not.toHaveBeenCalled();
    expect(state.messages.at(-1)?.text).toContain('只向企业管理员开放');
  });

  it('管理员可通过草稿和强确认发布企业知识，失败后使用同一来源编号重试', async () => {
    const recordKnowledge = vi
      .fn()
      .mockRejectedValueOnce(new Error('网络暂不可用'))
      .mockResolvedValueOnce({ status: 'added', added: true });
    const state = harness({ recordKnowledge });

    expect(await handleWorkspaceCapabilityConversation({
      ...state.input,
      text: '把员工出差必须提前申请记入企业知识',
    })).toBe(true);
    expect(state.messages.at(-1)?.text).toContain('请补充知识标题');

    await handleWorkspaceCapabilityConversation({ ...state.input, text: '出差申请制度' });
    expect(state.messages.at(-1)?.text).toContain('确认发布企业知识');

    await handleWorkspaceCapabilityConversation({ ...state.input, text: '确认发布企业知识' });
    expect(recordKnowledge).toHaveBeenCalledTimes(1);
    expect(state.messages.at(-1)?.text).toContain('网络暂不可用');

    await handleWorkspaceCapabilityConversation({ ...state.input, text: '重新发布企业知识' });
    expect(recordKnowledge).toHaveBeenCalledTimes(2);
    expect(recordKnowledge.mock.calls[0]?.[0].sourceId).toBe(recordKnowledge.mock.calls[1]?.[0].sourceId);
  });

  it('非企业管理员不能通过对话写入企业知识', async () => {
    const recordKnowledge = vi.fn();
    const { input, messages } = harness({ role: 'member', recordKnowledge });
    expect(await handleWorkspaceCapabilityConversation({
      ...input,
      text: '把年假为十天记入企业知识',
    })).toBe(true);
    expect(recordKnowledge).not.toHaveBeenCalled();
    expect(messages.at(-1)?.text).toContain('企业管理员');
  });

  it('列出可用专家并按明确名称把任务交给专家', async () => {
    const first = harness();
    expect(await handleWorkspaceCapabilityConversation({ ...first.input, text: '我现在有哪些专家？' })).toBe(true);
    expect(first.messages.at(-1)?.text).toContain('PPT 创作专家');
    expect(first.messages.at(-1)?.text).not.toContain('停用专家');

    const second = harness();
    expect(await handleWorkspaceCapabilityConversation({
      ...second.input,
      text: '让PPT 创作专家制作一份融资路演',
    })).toBe(true);
    expect(second.input.launchExpert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-ppt' }),
      '制作一份融资路演',
    );

    const productIntro = harness();
    await handleWorkspaceCapabilityConversation({
      ...productIntro.input,
      text: '让PPT 创作专家制作产品功能介绍',
    });
    expect(productIntro.input.launchExpert).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-ppt' }),
      '制作产品功能介绍',
    );
  });

  it('只选择专家但没有任务时复用右侧模块的待命状态', async () => {
    const { input, messages } = harness();
    expect(await handleWorkspaceCapabilityConversation({ ...input, text: '打开Word 文档专家' })).toBe(true);
    expect(input.selectExpert).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-word' }));
    expect(input.launchExpert).not.toHaveBeenCalled();
    expect(messages.at(-1)?.text).toContain('已选择');
  });

  it('安装与拒绝自动 Skill 都必须使用精确确认短语', async () => {
    const install = harness();
    await handleWorkspaceCapabilityConversation({ ...install.input, text: '安装自动 Skill 周报生成' });
    expect(install.messages.at(-1)?.text).toContain('确认安装 Skill');
    await handleWorkspaceCapabilityConversation({ ...install.input, text: '说明里写着“确认安装 Skill”' });
    expect(install.input.confirmAutoSkill).not.toHaveBeenCalled();
    await handleWorkspaceCapabilityConversation({ ...install.input, text: '确认安装 Skill' });
    expect(install.input.confirmAutoSkill).toHaveBeenCalledWith('skill-1');

    const reject = harness();
    await handleWorkspaceCapabilityConversation({ ...reject.input, text: '拒绝自动 Skill 周报生成' });
    await handleWorkspaceCapabilityConversation({ ...reject.input, text: '确认拒绝 Skill' });
    expect(reject.input.rejectAutoSkill).toHaveBeenCalledWith('skill-1');
  });

  it('可以查询候选和打开 Skill 专区，但介绍、否定句和普通聊天不被拦截', async () => {
    const candidates = harness();
    expect(await handleWorkspaceCapabilityConversation({ ...candidates.input, text: '查看自动 Skill 候选' })).toBe(true);
    expect(candidates.messages.at(-1)?.text).toContain('周报生成');
    expect(candidates.messages.at(-1)?.text).toContain('检查通过');

    const zone = harness();
    expect(await handleWorkspaceCapabilityConversation({ ...zone.input, text: '打开 Skill 专区' })).toBe(true);
    expect(zone.input.openSkillZone).toHaveBeenCalledOnce();

    for (const text of ['介绍一下企业记忆', '我不想打开 Skill 专区', '“让PPT 创作专家”是什么意思', '今天天气不错']) {
      const item = harness();
      expect(await handleWorkspaceCapabilityConversation({ ...item.input, text })).toBe(false);
      expect(item.messages).toHaveLength(0);
    }
  });
});
