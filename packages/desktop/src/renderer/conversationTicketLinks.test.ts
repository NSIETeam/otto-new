/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { ConversationTicketLinkRegistry } from './conversationTicketLinks.js';

const created = {
  id: 'ticket-1', applicationNumber: 'BX-001', title: '物业报修 · 顶灯不亮',
  status: '待接单', responseType: null, responseText: null, creatorUpdateAt: null,
  updatedAt: '2026-09-02T08:00:00.000Z',
};

describe('工单与原会话关联', () => {
  it('只在状态或回复变化后向原会话生成一次待回传消息', () => {
    const registry = new ConversationTicketLinkRegistry();
    registry.track(created, 'session-original', 1_000);
    expect(registry.observe([created], 2_000)).toBe(0);

    const updated = {
      ...created, status: '维修中', responseText: '维修人员已出发',
      creatorUpdateAt: '2026-09-02T08:10:00.000Z', updatedAt: '2026-09-02T08:10:00.000Z',
    };
    expect(registry.observe([updated], 3_000)).toBe(1);
    expect(registry.pendingForSession('session-other')).toHaveLength(0);
    expect(registry.pendingForSession('session-original')[0]?.message).toContain('维修人员已出发');
    expect(registry.pending()[0]).toMatchObject({ sessionId: 'session-original', notificationSent: false });
    expect(registry.markNotified('ticket-1', 'session-original')).toBe(true);
    expect(registry.pending()[0]?.notificationSent).toBe(true);
    expect(registry.markDelivered('ticket-1', 'session-other')).toBe(false);
    expect(registry.markDelivered('ticket-1', 'session-original')).toBe(true);
    expect(registry.pendingForSession('session-original')).toHaveLength(0);
    expect(registry.observe([updated], 4_000)).toBe(0);
  });

  it('加密快照恢复后仍保持会话隔离并丢弃过期关联', () => {
    const source = new ConversationTicketLinkRegistry();
    source.track(created, 'session-original', 1_000);
    const target = new ConversationTicketLinkRegistry();
    expect(target.restore(source.snapshot(2_000), 2_000)).toBe(1);
    expect(target.restore([{ ...source.snapshot(2_000)[0], expiresAt: 2_000 }], 2_000)).toBe(0);
  });
});
