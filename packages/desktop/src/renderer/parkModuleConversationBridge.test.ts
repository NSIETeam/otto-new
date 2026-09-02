/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { handleParkQueryConversation } from './parkModuleConversationBridge.js';

function harness(overrides: Record<string, unknown> = {}) {
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  return {
    input: {
      text: '',
      enabled: true,
      postMessage: (role: 'user' | 'assistant', text: string) => messages.push({ role, text }),
      listPublications: vi.fn(async () => []),
      loadStatistics: vi.fn(async () => ({
        parkName: '宏创园区', organizationCount: 12, activeOrganizationCount: 10,
        totalServiceUses: 36, totalAmountCny: 8000, recurringMonthlyCny: 1200,
        vehicleVisits: 9, meetingRoomBookings: 4, services: [],
      })),
      loadStarMap: vi.fn(async () => ({
        parkName: '宏创园区', currentOrganizationId: 'org-a', nodes: [
          { organizationId: 'org-b', organizationName: '乙公司', capabilities: ['工业设计'], productsServices: ['设计服务'], cooperationNeeds: ['软件开发'], isPublic: true },
        ],
        edges: [{ sourceOrganizationId: 'org-a', targetOrganizationId: 'org-b', strength: 'promising', evidence: ['能力互补'], unverifiedQuestions: [] }],
      })),
      listMyApplications: vi.fn(async () => []),
      listStaffTasks: vi.fn(async () => []),
      ...overrides,
    },
    messages,
  };
}

describe('园区查询对话桥', () => {
  it('只读查询公告，不通过读取接口产生已读副作用', async () => {
    const listPublications = vi.fn(async () => [{
      id: 'a-1', kind: 'announcement' as const, title: '停电通知', body: '周五 18:00 后停电检修',
      createdAt: '2026-09-01T10:00:00.000Z', readAt: null, submittedAt: null,
    }]);
    const { input, messages } = harness({ listPublications });

    expect(await handleParkQueryConversation({ ...input, text: '园区有什么最新公告？' })).toBe(true);
    expect(listPublications).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.text).toContain('停电通知');
    expect(messages[1]?.text).toContain('未读');
  });

  it('返回有权限的园区统计摘要', async () => {
    const { input, messages } = harness();
    expect(await handleParkQueryConversation({ ...input, text: '查看园区服务统计' })).toBe(true);
    expect(messages.at(-1)?.text).toContain('12 家企业');
    expect(messages.at(-1)?.text).toContain('36 次');
    expect(messages.at(-1)?.text).toContain('8,000');
  });

  it('从企业星链图列出可解释的合作线索', async () => {
    const { input, messages } = harness();
    expect(await handleParkQueryConversation({ ...input, text: '帮我找园区企业合作线索' })).toBe(true);
    expect(messages.at(-1)?.text).toContain('乙公司');
    expect(messages.at(-1)?.text).toContain('能力互补');
  });

  it('区分我的申请和分配给我的园区待办', async () => {
    const ticket = {
      id: 'ticket-1', applicationNumber: 'SQ-2026-001', serviceId: 'parking',
      title: '停车办理', description: '申请一个车位', status: '待接单',
      createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
      recipients: [{ id: 'u-2', name: '园区客服' }], recipientCount: 1,
    };
    const listMyApplications = vi.fn(async () => [{ ...ticket, isCreator: true }]);
    const listStaffTasks = vi.fn(async () => [{ ...ticket, isRecipient: true, title: '网络开通申请' }]);
    const first = harness({ listMyApplications, listStaffTasks });
    expect(await handleParkQueryConversation({ ...first.input, text: '我的申请进度' })).toBe(true);
    expect(listMyApplications).toHaveBeenCalled();
    expect(listStaffTasks).not.toHaveBeenCalled();
    expect(first.messages.at(-1)?.text).toContain('SQ-2026-001');

    const second = harness({ listMyApplications, listStaffTasks });
    expect(await handleParkQueryConversation({ ...second.input, text: '查看园区待办' })).toBe(true);
    expect(listStaffTasks).toHaveBeenCalled();
    expect(second.messages.at(-1)?.text).toContain('网络开通申请');
  });

  it('不拦截功能介绍、否定句或普通聊天', async () => {
    for (const text of ['介绍一下园区公告功能', '我不想查看园区公告', '今天天气怎么样']) {
      const { input, messages } = harness();
      expect(await handleParkQueryConversation({ ...input, text })).toBe(false);
      expect(messages).toHaveLength(0);
    }
  });

  it('查询失败时给出真实错误但仍消费已识别的查询', async () => {
    const { input, messages } = harness({
      listPublications: vi.fn(async () => { throw new Error('登录已失效'); }),
    });
    expect(await handleParkQueryConversation({ ...input, text: '查看园区公告' })).toBe(true);
    expect(messages.at(-1)?.text).toContain('登录已失效');
  });
});
