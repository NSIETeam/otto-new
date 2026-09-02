/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  EnterpriseParkCarpoolPublishInput,
  EnterpriseParkCarpoolState,
} from '../preload/index.js';
import {
  handleParkCarpoolConversation,
  ParkCarpoolConversationRegistry,
} from './parkCarpoolConversationBridge.js';

const EMPTY_STATE: EnterpriseParkCarpoolState = {
  capability: 'park_carpool_v1',
  mapConfigured: true,
  parkId: 'park-a',
  currentIntent: null,
  matches: [],
  generatedAt: '2026-09-02T09:00:00.000Z',
};

function harness(state = EMPTY_STATE) {
  const messages: string[] = [];
  const publish = vi.fn(async (input: EnterpriseParkCarpoolPublishInput) => ({
    id: 'intent-a', accountId: 'account-a', organizationId: 'org-a',
    organizationName: '甲企业', displayName: '张某', parkId: 'park-a',
    ...input,
    route: { provider: 'amap', distanceMeters: 12_000, durationSeconds: 1_800, polyline: [] },
    status: 'active' as const,
    lastConfirmedAt: '2026-09-02T09:00:00.000Z', expiresAt: '2026-09-02T11:00:00.000Z',
    createdAt: '2026-09-02T09:00:00.000Z', updatedAt: '2026-09-02T09:00:00.000Z',
  }));
  const api = {
    getState: vi.fn(async () => state),
    searchPlaces: vi.fn(async (query: string) => [{
      id: `poi-${query}`, label: query, address: '', district: '昌平区',
      coordinate: query.includes('南门')
        ? { longitude: 116.23, latitude: 40.22 }
        : { longitude: 116.31, latitude: 40.17 },
    }]),
    publish,
    stop: vi.fn(async () => ({ ...state.currentIntent!, status: 'paused' as const })),
  };
  return {
    registry: new ParkCarpoolConversationRegistry(),
    api,
    publish,
    messages,
    postMessage: (_role: 'user' | 'assistant', text: string) => messages.push(text),
  };
}

describe('handleParkCarpoolConversation', () => {
  it('collects one natural-language request, resolves places, and requires confirmation', async () => {
    const h = harness();
    const common = {
      scopeId: 'org-a:account-a', sessionId: 'session-a',
      registry: h.registry, ...h.api, postMessage: h.postMessage,
      now: () => new Date('2026-09-02T09:00:00.000Z'),
    };
    expect(await handleParkCarpoolConversation({
      ...common,
      text: '我要拼车，今天18:30从宏创园区南门到回龙观地铁站，想搭车或者一起叫车，前后30分钟都可以',
    })).toBe(true);
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.messages.at(-1)).toContain('回复“确认发布”');

    await handleParkCarpoolConversation({ ...common, text: '确认发布' });
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({
      origin: expect.objectContaining({ label: '宏创园区南门' }),
      destination: expect.objectContaining({ label: '回龙观地铁站' }),
      flexibleMinutes: 30,
      travelOptions: ['rider', 'shared_taxi'],
    }));
    expect(h.messages.at(-1)).toContain('已发布');
  });

  it('asks only for missing details and does not call the model', async () => {
    const h = harness();
    const handled = await handleParkCarpoolConversation({
      text: '我要拼车', scopeId: 'org-a:account-a', sessionId: 'session-a',
      registry: h.registry, ...h.api, postMessage: h.postMessage,
      now: () => new Date('2026-09-02T09:00:00.000Z'),
    });
    expect(handled).toBe(true);
    expect(h.messages.at(-1)).toContain('出发地');
    expect(h.messages.at(-1)).toContain('目的地');
    expect(h.messages.at(-1)).toContain('出发时间');
  });

  it('shows privacy-safe match results and confirms before stopping', async () => {
    const active = {
      ...EMPTY_STATE,
      currentIntent: {
        id: 'intent-a', accountId: 'account-a', organizationId: 'org-a',
        organizationName: '甲企业', displayName: '张某', parkId: 'park-a',
        travelDate: '2026-09-02',
        origin: { label: '宏创园区南门', coordinate: { longitude: 116.23, latitude: 40.22 } },
        destination: { label: '回龙观', coordinate: { longitude: 116.31, latitude: 40.17 } },
        departureTime: '2026-09-02T10:30:00.000Z', flexibleMinutes: 30,
        travelOptions: ['rider' as const],
        route: { provider: 'amap', distanceMeters: 12_000, durationSeconds: 1_800, polyline: [] },
        status: 'active' as const, lastConfirmedAt: '2026-09-02T09:00:00.000Z',
        expiresAt: '2026-09-02T11:00:00.000Z', createdAt: '2026-09-02T09:00:00.000Z',
        updatedAt: '2026-09-02T09:00:00.000Z',
      },
      matches: [{
        intentId: 'intent-b', displayName: '李某', organizationName: '乙企业',
        verifiedParkMember: true as const, departureTime: '2026-09-02T10:20:00.000Z',
        timeDifferenceMinutes: 10, overlapPercent: 88, commonDistanceMeters: 10_500,
        compatibleModes: ['current_rides_candidate_vehicle' as const],
        originArea: '宏创园区南门', destinationArea: '回龙观', freshness: 'just_updated' as const,
        explanation: '路线同向共同路段约 10.5 公里。',
      }],
    };
    const h = harness(active);
    const common = {
      scopeId: 'org-a:account-a', sessionId: 'session-a', registry: h.registry,
      ...h.api, postMessage: h.postMessage,
      now: () => new Date('2026-09-02T09:00:00.000Z'),
    };
    await handleParkCarpoolConversation({ ...common, text: '看看我的拼车匹配' });
    expect(h.messages.at(-1)).toContain('李某');
    expect(h.messages.at(-1)).toContain('约 88%');
    await handleParkCarpoolConversation({ ...common, text: '停止寻找拼车' });
    expect(h.api.stop).not.toHaveBeenCalled();
    await handleParkCarpoolConversation({ ...common, text: '确认停止' });
    expect(h.api.stop).toHaveBeenCalledWith('intent-a');
  });

  it('does not silently rewrite a future-day or past-time request into a valid publication', async () => {
    const h = harness();
    const common = {
      scopeId: 'org-a:account-a', sessionId: 'session-a', registry: h.registry,
      ...h.api, postMessage: h.postMessage,
      now: () => new Date('2026-09-02T09:00:00.000Z'),
    };
    await handleParkCarpoolConversation({
      ...common,
      text: '明天18:30从宏创园区南门到回龙观地铁站，想搭车',
    });
    expect(h.messages.at(-1)).toContain('只支持发布当天');
    expect(h.api.searchPlaces).not.toHaveBeenCalled();

    await handleParkCarpoolConversation({
      ...common,
      text: '今天10:00从宏创园区南门到回龙观地铁站，想搭车',
    });
    expect(h.messages.at(-1)).toContain('已经过去');
    expect(h.publish).not.toHaveBeenCalled();
  });
});
