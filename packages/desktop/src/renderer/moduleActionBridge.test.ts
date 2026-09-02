/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ModuleActionDraftRegistry,
  handleModuleActionConversation,
  prepareModuleAction,
  submitModuleAction,
  updateModuleDraft,
  type RepairModuleDefaults,
  type RepairTicketSubmitInput,
} from './moduleActionBridge.js';

const defaults: RepairModuleDefaults = {
  company: '序动科技',
  roomNumber: 'A座1203室',
  contact: '张三',
  phone: '13800138000',
};

describe('物业报修对话模块桥', () => {
  it('从企业档案预填身份，只询问仍缺少的报修信息', () => {
    const prepared = prepareModuleAction({
      text: '我要物业报修',
      sessionId: 'session-1',
      accountId: 'account-1',
      defaults,
      now: 1_000,
    });

    if (!prepared?.draft) throw new Error('expected repair draft');
    expect(prepared.draft.fields).toMatchObject(defaults);
    expect(prepared.draft.phase).toBe('collecting');
    expect(prepared.assistantMessage).toContain('已获取公司名称、房间号、联系人和联系电话');
    expect(prepared.assistantMessage).toContain('报修类别');
    expect(prepared.assistantMessage).toContain('故障描述');
    expect(prepared.assistantMessage).toContain('紧急程度');
  });

  it('从补充话语提取类别、故障和紧急程度，信息齐全后等待确认', () => {
    const prepared = prepareModuleAction({
      text: '我要物业报修',
      sessionId: 'session-1',
      accountId: 'account-1',
      defaults,
      now: 1_000,
    });
    if (!prepared?.draft) throw new Error('expected repair draft');

    const updated = updateModuleDraft(
      prepared.draft,
      '会议室顶灯不亮，普通',
      2_000,
    );

    expect(updated.shouldSubmit).toBe(false);
    expect(updated.draft?.phase).toBe('awaiting_confirmation');
    expect(updated.draft?.fields.category).toBe('灯具维修');
    expect(updated.draft?.fields.issue).toContain('顶灯不亮');
    expect(updated.draft?.fields.urgency).toBe('普通');
    expect(updated.assistantMessage).toContain('A座1203室');
    expect(updated.assistantMessage).toContain('138****8000');
    expect(updated.assistantMessage).toContain('确认提交');
  });

  it('只有明确确认后才生成真实工单提交参数', async () => {
    const prepared = prepareModuleAction({
      text: '我要报修，A座1203室会议室顶灯不亮，普通',
      sessionId: 'session-1',
      accountId: 'account-1',
      defaults,
      now: 1_000,
    });
    if (!prepared?.draft) throw new Error('expected repair draft');
    expect(prepared.draft.phase).toBe('awaiting_confirmation');

    const confirmation = updateModuleDraft(prepared.draft, '确认提交', 2_000);
    expect(confirmation.shouldSubmit).toBe(true);

    const executor = vi.fn(async () => ({
      id: 'ticket-00001234',
      applicationNumber: 'BX-2026-0012',
      status: '待接单',
      recipients: [{ id: 'repairer-1', name: '李师傅' }],
      recipientCount: 1,
    }));
    const result = await submitModuleAction(confirmation.draft!, executor);

    expect(executor).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'repair',
      category: '灯具维修',
      location: 'A座1203室',
      urgency: '普通',
      contact: '张三',
      contactPhone: '13800138000',
      formData: expect.objectContaining({ issue: expect.stringContaining('顶灯不亮') }),
    }));
    expect(result.assistantMessage).toContain('BX-2026-0012');
    expect(result.assistantMessage).toContain('李师傅');
    expect(result.assistantMessage).toContain('右侧“物业报修”');
  });

  it('显式要求直接提交后，信息一旦齐全即可跳过二次确认', () => {
    const prepared = prepareModuleAction({
      text: '我要物业报修，信息齐了直接提交',
      sessionId: 'session-1',
      accountId: 'account-1',
      defaults,
      now: 1_000,
    });
    if (!prepared?.draft) throw new Error('expected repair draft');
    expect(prepared.draft.autoSubmit).toBe(true);

    const updated = updateModuleDraft(prepared.draft, '空调不制冷，影响办公', 2_000);
    expect(updated.shouldSubmit).toBe(true);
    expect(updated.draft?.fields.category).toBe('暖通维修');
  });

  it('草稿严格绑定账号和会话，并在超时后失效', () => {
    const registry = new ModuleActionDraftRegistry();
    const prepared = prepareModuleAction({
      text: '我要物业报修',
      sessionId: 'session-1',
      accountId: 'account-1',
      defaults,
      now: 1_000,
    });
    if (!prepared?.draft) throw new Error('expected repair draft');
    registry.save(prepared.draft);

    expect(registry.get('session-1', 'account-1', 2_000)).toBeTruthy();
    expect(registry.get('session-2', 'account-1', 2_000)).toBeNull();
    expect(registry.get('session-1', 'account-2', 2_000)).toBeNull();
    expect(registry.get('session-1', 'account-1', prepared.draft.expiresAt + 1)).toBeNull();
  });

  it('为每份草稿生成独立幂等键，并在网络失败后的重试中复用', async () => {
    const first = prepareModuleAction({
      text: '我要报修，会议室顶灯不亮，普通',
      sessionId: 'session-1',
      accountId: 'account-1',
      defaults,
      now: 1_000,
    });
    const second = prepareModuleAction({
      text: '我要报修，空调不制冷，普通',
      sessionId: 'session-2',
      accountId: 'account-1',
      defaults,
      now: 1_000,
    });
    if (!first?.draft || !second?.draft) throw new Error('expected repair drafts');

    expect(first.draft.idempotencyKey).toMatch(/^repair:[A-Za-z0-9._:-]{16,121}$/);
    expect(second.draft.idempotencyKey).not.toBe(first.draft.idempotencyKey);

    const inputs: RepairTicketSubmitInput[] = [];
    const executor = vi.fn(async (input: RepairTicketSubmitInput) => {
      inputs.push(input);
      if (inputs.length === 1) throw new Error('response lost');
      return {
        id: 'ticket-1',
        applicationNumber: 'BX-1',
        status: '待接单',
        recipients: [],
        recipientCount: 1,
      };
    });

    await expect(submitModuleAction(first.draft, executor)).rejects.toThrow('response lost');
    await expect(submitModuleAction(first.draft, executor)).resolves.toMatchObject({
      ticket: { id: 'ticket-1' },
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.idempotencyKey).toBe(first.draft.idempotencyKey);
    expect(inputs[1]?.idempotencyKey).toBe(first.draft.idempotencyKey);
  });

  it('端到端处理时拦截报修对话、保留失败草稿并在成功后清理', async () => {
    const registry = new ModuleActionDraftRegistry();
    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error('网络暂不可用'))
      .mockResolvedValueOnce({
        id: 'ticket-1',
        applicationNumber: 'BX-1',
        status: '待接单',
        recipients: [],
        recipientCount: 1,
      });
    const common = {
      sessionId: 'session-1',
      accountId: 'account-1',
      enabled: true,
      registry,
      loadDefaults: async () => defaults,
      submit,
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      now: () => 1_000,
    };

    expect(await handleModuleActionConversation({ ...common, text: '我要物业报修' })).toBe(true);
    expect(await handleModuleActionConversation({ ...common, text: '会议室顶灯不亮，普通' })).toBe(true);
    expect(await handleModuleActionConversation({ ...common, text: '确认提交' })).toBe(true);
    expect(messages.at(-1)?.text).toContain('网络暂不可用');
    expect(registry.get('session-1', 'account-1', 1_000)).toBeTruthy();

    expect(await handleModuleActionConversation({ ...common, text: '确认提交' })).toBe(true);
    expect(messages.at(-1)?.text).toContain('BX-1');
    expect(registry.get('session-1', 'account-1', 1_000)).toBeNull();
  });

  it('重复确认时同一账号和会话只允许一个工单请求在途', async () => {
    const registry = new ModuleActionDraftRegistry();
    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    let finishSubmit: ((value: {
      id: string;
      applicationNumber: string;
      status: string;
      recipients: never[];
      recipientCount: number;
    }) => void) | undefined;
    const submit = vi.fn(() => new Promise<{
      id: string;
      applicationNumber: string;
      status: string;
      recipients: never[];
      recipientCount: number;
    }>((resolve) => { finishSubmit = resolve; }));
    const common = {
      sessionId: 'session-1',
      accountId: 'account-1',
      enabled: true,
      registry,
      loadDefaults: async () => defaults,
      submit,
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      now: () => 1_000,
    };

    await handleModuleActionConversation({ ...common, text: '我要报修，会议室顶灯不亮，普通' });
    const firstConfirmation = handleModuleActionConversation({ ...common, text: '确认提交' });
    await Promise.resolve();
    await handleModuleActionConversation({ ...common, text: '确认提交' });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)?.text).toContain('正在提交，请勿重复操作');
    finishSubmit?.({
      id: 'ticket-1',
      applicationNumber: 'BX-1',
      status: '待接单',
      recipients: [],
      recipientCount: 1,
    });
    await firstConfirmation;
  });

  it('向统一草稿中心提供严格隔离的报修摘要，并只取消指定草稿', () => {
    const registry = new ModuleActionDraftRegistry();
    const transition = prepareModuleAction({
      text: '我要物业报修', sessionId: 'session-1', accountId: 'account-1', defaults, now: 1_000,
    });
    expect(transition?.draft).toBeTruthy();
    registry.save(transition!.draft!);

    expect(registry.summary('session-1', 'account-2', 1_000)).toBeNull();
    expect(registry.summary('session-1', 'account-1', 1_000)).toMatchObject({
      source: 'repair', title: '物业报修', phase: 'collecting',
      missingFields: ['报修类别', '故障描述', '紧急程度'],
    });
    expect(registry.discard('wrong-id', 'session-1', 'account-1', 1_000)).toBe(false);
    expect(registry.beginSubmission('session-1', 'account-1')).toBe(true);
    expect(registry.summary('session-1', 'account-1', 1_000)?.phase).toBe('submitting');
    expect(registry.discard(transition!.draft!.id, 'session-1', 'account-1', 1_000)).toBe(false);
    registry.finishSubmission('session-1', 'account-1');
    expect(registry.discard(transition!.draft!.id, 'session-1', 'account-1', 1_000)).toBe(true);
    expect(registry.get('session-1', 'account-1', 1_000)).toBeNull();
  });

  it('草稿中心确认必须匹配精确草稿 ID，旧卡片不能提交新草稿', async () => {
    const registry = new ModuleActionDraftRegistry();
    const submit = vi.fn();
    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    const common = {
      sessionId: 'session-1', accountId: 'account-1', enabled: true, registry,
      loadDefaults: async () => defaults, submit,
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      now: () => 1_000,
    };
    await handleModuleActionConversation({ ...common, text: '我要报修，会议室顶灯不亮，普通' });
    const currentId = registry.get('session-1', 'account-1', 1_000)!.id;

    await handleModuleActionConversation({
      ...common, text: '确认提交', expectedDraftId: `${currentId}:stale`,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(registry.get('session-1', 'account-1', 1_000)?.id).toBe(currentId);
    expect(messages.at(-1)?.text).toContain('已变化或过期');
  });

  it('本地进展关联失败不会把已创建工单误报为提交失败', async () => {
    const registry = new ModuleActionDraftRegistry();
    const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    const common = {
      sessionId: 'session-1', accountId: 'account-1', enabled: true, registry,
      loadDefaults: async () => defaults,
      submit: async () => ({
        id: 'ticket-1', applicationNumber: 'BX-1', status: '待接单', recipients: [], recipientCount: 1,
      }),
      onSubmitted: () => { throw new Error('local link unavailable'); },
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      now: () => 1_000,
    };
    await handleModuleActionConversation({ ...common, text: '我要报修，会议室顶灯不亮，普通' });
    await handleModuleActionConversation({ ...common, text: '确认提交' });
    expect(messages.at(-1)?.text).toContain('BX-1');
    expect(messages.at(-1)?.text).not.toContain('暂未提交成功');
    expect(registry.get('session-1', 'account-1', 1_000)).toBeNull();
  });
});
