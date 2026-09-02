/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  ParkServiceActionDraftRegistry,
  handleParkServiceActionConversation,
  type ParkServiceDefaults,
  type ParkServiceTicketSubmitInput,
} from './parkServiceActionBridge.js';

const defaults: ParkServiceDefaults = {
  company: '序动科技', roomNumber: 'A座1203室', contact: '张三', phone: '13800138000',
};

const resources = {
  settings: { parkingTotal: 10, parkingNote: null, updatedAt: '2026-09-01T00:00:00Z' },
  meetingRooms: [
    { id: 'small', name: '第一会议室', location: 'A座2层', capacity: 8, priceHalfDay: 300, equipment: ['投屏'], enabled: true },
    { id: 'large', name: '路演厅', location: 'A座1层', capacity: 30, priceHalfDay: 800, equipment: ['投屏', '视频会议'], enabled: true },
  ],
  meetingSlots: [
    { id: 's1', roomId: 'small', date: '2026-09-10', slotKey: '14:00', label: '14:00', status: 'booked' as const },
    { id: 's2', roomId: 'small', date: '2026-09-10', slotKey: '14:30', label: '14:30', status: 'available' as const },
    { id: 'l1', roomId: 'large', date: '2026-09-10', slotKey: '14:00', label: '14:00', status: 'available' as const },
    { id: 'l2', roomId: 'large', date: '2026-09-10', slotKey: '14:30', label: '14:30', status: 'available' as const },
  ],
};

function harness(overrides: Record<string, unknown> = {}) {
  const registry = new ParkServiceActionDraftRegistry();
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  const submitTicket = vi.fn(async (_input: ParkServiceTicketSubmitInput) => ({
    id: 'ticket-1', applicationNumber: 'SQ-2026-001', status: '待接单',
    recipients: [{ id: 'staff-1', name: '园区客服' }], recipientCount: 1,
  }));
  const submitSurvey = vi.fn(async () => ({ id: 'survey-1', submittedAt: '2026-09-02T00:00:00Z' }));
  return {
    registry,
    messages,
    submitTicket,
    submitSurvey,
    common: {
      sessionId: 'session-1', accountId: 'account-1', enabled: true, registry,
      loadDefaults: async () => defaults,
      loadMeetingResources: async () => resources,
      listPublications: async () => [],
      submitTicket,
      submitSurvey,
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      now: () => Date.parse('2026-09-02T10:00:00+08:00'),
      ...overrides,
    },
  };
}

describe('园区申请表对话桥', () => {
  it('装修申请使用企业默认身份，只追问装修区域和开工日期', async () => {
    const { common, registry, messages } = harness();
    expect(await handleParkServiceActionConversation({ ...common, text: '我要提交装修申请' })).toBe(true);
    const draft = registry.get('session-1', 'account-1', Date.parse('2026-09-02T10:00:00+08:00'));
    expect(draft?.kind).toBe('ticket');
    if (draft?.kind !== 'ticket') throw new Error('expected ticket draft');
    expect(draft.fields).toMatchObject(defaults);
    expect(messages.at(-1)?.text).toContain('装修区域');
    expect(messages.at(-1)?.text).toContain('计划开工日期');
    expect(messages.at(-1)?.text).not.toContain('请补充公司名称');
  });

  it('停车申请提取中文选项和数量，展示费用后确认提交', async () => {
    const { common, messages, submitTicket } = harness();
    await handleParkServiceActionConversation({ ...common, text: '申请地下固定停车位，数量2个' });
    expect(messages.at(-1)?.text).toContain('260 元/月');
    expect(messages.at(-1)?.text).toContain('确认提交');
    await handleParkServiceActionConversation({ ...common, text: '确认提交' });
    expect(submitTicket).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'parking', idempotencyKey: expect.stringMatching(/^park:/),
      formData: expect.objectContaining({ applicationType: 'underground-fixed', quantity: '2' }),
    }));
    expect(messages.at(-1)?.text).toContain('SQ-2026-001');
  });

  it('电卡申请计算金额且不会在确认前调用服务器', async () => {
    const { common, messages, submitTicket } = harness();
    await handleParkServiceActionConversation({ ...common, text: '办理电卡充电100度' });
    expect(messages.at(-1)?.text).toContain('120.00 元');
    expect(submitTicket).not.toHaveBeenCalled();
    await handleParkServiceActionConversation({ ...common, text: '确认提交' });
    expect(submitTicket).toHaveBeenCalledTimes(1);
  });

  it('车辆数量大于零时逐辆追问车牌，完整后才允许确认', async () => {
    const { common, messages, submitTicket } = harness();
    await handleParkServiceActionConversation({
      ...common,
      text: '登记访客，来访日期：2026-09-10，来访时间：15:30，拜访企业及事由：到序动科技开会，车辆数量：2',
    });
    expect(messages.at(-1)?.text).toContain('第1辆车牌号');
    expect(messages.at(-1)?.text).toContain('第2辆车牌号');
    await handleParkServiceActionConversation({ ...common, text: '车牌号：京A12345、京B67890' });
    expect(messages.at(-1)?.text).toContain('确认提交');
    await handleParkServiceActionConversation({ ...common, text: '确认提交' });
    expect(submitTicket).toHaveBeenCalledWith(expect.objectContaining({
      formData: expect.objectContaining({ vehiclePlate1: '京A12345', vehiclePlate2: '京B67890' }),
    }));
  });

  it('会议室按人数与连续时段选择可用房间，避开冲突房间', async () => {
    const { common, messages, submitTicket } = harness();
    await handleParkServiceActionConversation({
      ...common,
      text: '预约会议室，参会人数：6，日期：2026-09-10，时间：14:00-15:00，会议内容：项目评审',
    });
    expect(messages.at(-1)?.text).toContain('路演厅');
    expect(messages.at(-1)?.text).not.toContain('第一会议室，2026-09-10');
    await handleParkServiceActionConversation({ ...common, text: '确认提交' });
    expect(submitTicket).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'meeting-room',
      formData: expect.objectContaining({
        roomId: 'large', roomName: '路演厅', date: '2026-09-10', startTime: '14:00', endTime: '15:00',
      }),
    }));
  });

  it('会议室没有连续可用时段时不生成可确认草稿', async () => {
    const blocked = {
      ...resources,
      meetingSlots: resources.meetingSlots.map((slot) => ({ ...slot, status: 'booked' as const })),
    };
    const { common, messages, submitTicket } = harness({ loadMeetingResources: async () => blocked });
    await handleParkServiceActionConversation({
      ...common,
      text: '预约会议室，6人，2026-09-10 14:00-15:00，会议内容：项目评审',
    });
    expect(messages.at(-1)?.text).toContain('没有连续可用');
    expect(messages.at(-1)?.text).not.toContain('确认提交');
    expect(submitTicket).not.toHaveBeenCalled();
  });

  it('满意度调查只选择未提交问卷并在不可修改的提交前确认', async () => {
    const listPublications = vi.fn(async () => [
      { id: 'old', kind: 'satisfaction' as const, title: '旧问卷', body: '旧', createdAt: '2026-08-01T00:00:00Z', readAt: null, submittedAt: '2026-08-02T00:00:00Z', responseData: {} },
      { id: 'survey-1', kind: 'satisfaction' as const, title: '三季度调查', body: '请评价服务', createdAt: '2026-09-01T00:00:00Z', readAt: null, submittedAt: null, responseData: null },
    ]);
    const { common, messages, submitSurvey } = harness({ listPublications });
    await handleParkServiceActionConversation({ ...common, text: '填写满意度调查，5分，重点关注：网络，改进建议：提升响应速度' });
    expect(messages.at(-1)?.text).toContain('三季度调查');
    expect(messages.at(-1)?.text).toContain('提交后不能修改');
    expect(submitSurvey).not.toHaveBeenCalled();
    await handleParkServiceActionConversation({ ...common, text: '确认提交' });
    expect(submitSurvey).toHaveBeenCalledWith('survey-1', expect.objectContaining({
      score: '5', focus: '网络', feedback: '提升响应速度', company: '序动科技',
    }));
  });

  it('草稿绑定账号与会话，支持取消且不拦截普通聊天', async () => {
    const { common, registry, messages, submitTicket } = harness();
    expect(await handleParkServiceActionConversation({ ...common, text: '申请停车位' })).toBe(true);
    expect(registry.get('session-1', 'account-2')).toBeNull();
    expect(await handleParkServiceActionConversation({ ...common, text: '取消' })).toBe(true);
    expect(messages.at(-1)?.text).toContain('不会提交');
    expect(registry.get('session-1', 'account-1')).toBeNull();
    expect(await handleParkServiceActionConversation({ ...common, text: '给我讲个笑话' })).toBe(false);
    expect(submitTicket).not.toHaveBeenCalled();
  });

  it('向统一草稿中心暴露园区申请的缺失字段和确认状态', async () => {
    const { common, registry } = harness();
    await handleParkServiceActionConversation({ ...common, text: '申请停车位' });
    expect(registry.summary('session-1', 'account-1', 1_000)).toMatchObject({
      source: 'park-service', title: '停车办理申请', phase: 'collecting',
      missingFields: ['申请内容', '申请数量'],
    });

    await handleParkServiceActionConversation({ ...common, text: '申请内容：地下固定停车位，申请数量：1' });
    expect(registry.summary('session-1', 'account-1', 1_000)).toMatchObject({
      phase: 'awaiting_confirmation', missingFields: [], confirmationText: '确认提交',
    });
    expect(registry.beginSubmission('session-1', 'account-1')).toBe(true);
    const submitting = registry.summary('session-1', 'account-1', 1_000);
    expect(submitting?.phase).toBe('submitting');
    expect(submitting?.confirmationText).toBeUndefined();
    const id = registry.get('session-1', 'account-1', 1_000)!.id;
    expect(registry.discard(id, 'session-1', 'account-1', 1_000)).toBe(false);
    registry.finishSubmission('session-1', 'account-1');
  });

  it('拒绝使用过期草稿卡片确认另一份园区申请', async () => {
    const { common, registry, submitTicket, messages } = harness();
    await handleParkServiceActionConversation({
      ...common,
      text: '申请停车位，申请内容：地下固定停车位，申请数量：1',
    });
    const currentId = registry.get('session-1', 'account-1', 1_000)!.id;
    await handleParkServiceActionConversation({
      ...common, text: '确认提交', expectedDraftId: `${currentId}:stale`,
    });
    expect(submitTicket).not.toHaveBeenCalled();
    expect(registry.get('session-1', 'account-1', 1_000)?.id).toBe(currentId);
    expect(messages.at(-1)?.text).toContain('已变化或过期');
  });
});
