import { carpoolTestConfig } from './parkCarpoolTestSupport.js';
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { ParkCarpoolIntent } from './parkCarpoolDomain.js';
import { createParkCarpoolService } from './parkCarpoolService.js';

const route = {
  provider: 'test-map',
  distanceMeters: 10_000,
  durationSeconds: 1_500,
  polyline: [
    { longitude: 116.23, latitude: 40.22 },
    { longitude: 116.28, latitude: 40.19 },
    { longitude: 116.31, latitude: 40.17 },
  ],
};

function createHarness() {
  const intents = new Map<string, ParkCarpoolIntent>();
  const store = {
    getPrincipal: vi.fn(async (accountId: string) =>
      accountId === 'missing'
        ? null
        : {
            accountId,
            organizationId: accountId === 'peer' ? 'org-b' : 'org-a',
            organizationName: accountId === 'peer' ? '乙企业' : '甲企业',
            displayName: accountId === 'peer' ? '李某' : '张某',
            parkId: 'park-a',
            active: true,
            parkServiceEnabled: true,
          },
    ),
    getIntent: vi.fn(
      async (accountId: string, travelDate?: string) =>
        [...intents.values()].find(
          (item) =>
            item.accountId === accountId &&
            (!travelDate || item.travelDate === travelDate),
        ) ?? null,
    ),
    listActiveIntents: vi.fn(async (parkId: string, travelDate: string) =>
      [...intents.values()].filter(
        (item) =>
          item.parkId === parkId &&
          item.travelDate === travelDate &&
          item.status === 'active',
      ),
    ),
    saveIntent: vi.fn(async (intent: ParkCarpoolIntent) => {
      intents.set(`${intent.accountId}:${intent.travelDate}`, intent);
      return intent;
    }),
    stopIntent: vi.fn(
      async (accountId: string, intentId: string, stoppedAt: string) => {
        const current = [...intents.values()].find(
          (item) => item.id === intentId,
        );
        if (!current || current.accountId !== accountId) return null;
        const stopped = {
          ...current,
          status: 'paused' as const,
          updatedAt: stoppedAt,
        };
        intents.set(`${current.accountId}:${current.travelDate}`, stopped);
        return stopped;
      },
    ),
  };
  const provider = {
    configured: true,
    searchPlaces: vi.fn(async () => []),
    planDrivingRoute: vi.fn(async () => route),
  };
  const service = createParkCarpoolService({ config: carpoolTestConfig,
    store,
    mapProvider: provider,
    createId: () => 'intent-new',
    now: () => new Date('2026-09-02T09:00:00.000Z'),
  });
  return { service, store, provider, intents };
}

const publishInput = {
  travelDate: '2026-09-02',
  origin: {
    label: '北控宏创科技园南门',
    coordinate: { longitude: 116.23, latitude: 40.22 },
  },
  destination: {
    label: '回龙观地铁站',
    coordinate: { longitude: 116.31, latitude: 40.17 },
  },
  departureTime: '2026-09-02T18:30:00+08:00',
  flexibleMinutes: 30,
  travelOptions: ['rider', 'shared_taxi'] as const,
};

describe('createParkCarpoolService', () => {
  it('upserts one daily intent and plans the route on the server', async () => {
    const { service, provider, intents } = createHarness();
    const first = await service.publishIntent('self', publishInput);
    const second = await service.publishIntent('self', {
      ...publishInput,
      flexibleMinutes: 15,
    });

    expect(first.id).toBe('intent-new');
    expect(second.id).toBe(first.id);
    expect(second.flexibleMinutes).toBe(15);
    expect(intents).toHaveLength(1);
    expect(provider.planDrivingRoute).toHaveBeenCalledTimes(2);
  });

  it('bounds a provider route before persistence and matching', async () => {
    const { service, provider } = createHarness();
    provider.planDrivingRoute.mockResolvedValueOnce({
      ...route,
      polyline: Array.from({ length: 2_000 }, (_, index) => ({
        longitude: 116.23 + index * 0.00001,
        latitude: 40.22 - index * 0.00001,
      })),
    });
    const saved = await service.publishIntent('self', publishInput);
    expect(saved.route.polyline.length).toBeLessThanOrEqual(128);
    expect(saved.route.polyline[0]).toEqual({
      longitude: 116.23,
      latitude: 40.22,
    });
    expect(saved.route.polyline.at(-1)).toEqual({
      longitude: 116.23 + 1_999 * 0.00001,
      latitude: 40.22 - 1_999 * 0.00001,
    });
  });

  it('preserves a short detour between sparse sampling indices', async () => {
    const { service, provider } = createHarness();
    const polyline = Array.from({ length: 2_000 }, (_, index) => ({
      longitude: 116.23 + index * 0.00001,
      latitude: index === 501 ? 40.23 : 40.22,
    }));
    provider.planDrivingRoute.mockResolvedValueOnce({ ...route, polyline });
    const saved = await service.publishIntent('self', publishInput);
    expect(saved.route.polyline).toContainEqual(polyline[501]);
    expect(saved.route.polyline).toContainEqual(polyline[500]);
    expect(saved.route.polyline).toContainEqual(polyline[502]);
  });

  it('preserves a collinear reversal including duplicate provider points', async () => {
    const { service, provider } = createHarness();
    const polyline = [0, 100, 100, 50, 200].map((meters) => ({
      longitude: 116 + meters / 85_180,
      latitude: 40,
    }));
    provider.planDrivingRoute.mockResolvedValueOnce({ ...route, polyline });
    const saved = await service.publishIntent('self', publishInput);
    expect(saved.route.polyline).toEqual([
      polyline[0],
      polyline[1],
      polyline[3],
      polyline[4],
    ]);
  });

  it('rejects malformed provider geometry without writing an intent', async () => {
    const { service, provider, store } = createHarness();
    provider.planDrivingRoute.mockResolvedValueOnce({
      ...route,
      polyline: [
        { longitude: Number.NaN, latitude: 40 },
        { longitude: 116, latitude: 40 },
      ],
    });
    await expect(service.publishIntent('self', publishInput)).rejects.toThrow(
      /路线/,
    );
    expect(store.saveIntent).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown, disabled, or unbound principal', async () => {
    const { service, store } = createHarness();
    await expect(service.getState('missing')).rejects.toThrow(/账号/u);
    store.getPrincipal.mockResolvedValueOnce({
      accountId: 'self',
      organizationId: 'org-a',
      organizationName: '甲企业',
      displayName: '张某',
      parkId: null,
      active: true,
      parkServiceEnabled: true,
    });
    await expect(service.getState('self')).rejects.toThrow(/绑定园区/u);
    store.getPrincipal.mockResolvedValueOnce({
      accountId: 'self',
      organizationId: 'org-a',
      organizationName: '甲企业',
      displayName: '张某',
      parkId: 'park-a',
      active: true,
      parkServiceEnabled: false,
    });
    await expect(service.getState('self')).rejects.toThrow(/未启用园区服务/u);
  });

  it('returns multiple privacy-safe matches and only lets the owner stop an intent', async () => {
    const { service, intents } = createHarness();
    const self = await service.publishIntent('self', publishInput);
    intents.set('peer:2026-09-02', {
      ...self,
      id: 'intent-peer',
      accountId: 'peer',
      organizationId: 'org-b',
      organizationName: '乙企业',
      displayName: '李某',
      travelOptions: ['driver'],
      destination: {
        label: '回龙观某小区 8 号楼 302 室',
        coordinate: { longitude: 116.3101, latitude: 40.1701 },
      },
    });

    const state = await service.getState('self');
    expect(state.matches).toHaveLength(1);
    expect(state.matches[0]).toMatchObject({
      intentId: 'intent-peer',
      displayName: '李某',
      organizationName: '乙企业',
    });
    expect(JSON.stringify(state.matches)).not.toContain('302');
    await expect(service.stopIntent('peer', self.id)).rejects.toThrow(/无权/u);
    expect((await service.stopIntent('self', self.id)).status).toBe('paused');
  });

  it('treats a stale active record as expired and never matches it', async () => {
    const { service, intents, store } = createHarness();
    intents.set('self:2026-09-02', {
      id: 'intent-expired',
      accountId: 'self',
      organizationId: 'org-a',
      organizationName: '甲企业',
      displayName: '张某',
      parkId: 'park-a',
      ...publishInput,
      route,
      status: 'active',
      lastConfirmedAt: '2026-09-02T07:30:00.000Z',
      expiresAt: '2026-09-02T08:59:59.000Z',
      createdAt: '2026-09-02T07:30:00.000Z',
      updatedAt: '2026-09-02T07:30:00.000Z',
    });

    const state = await service.getState('self');
    expect(state.currentIntent?.status).toBe('expired');
    expect(state.matches).toEqual([]);
    expect(store.listActiveIntents).not.toHaveBeenCalled();
  });

  it('fails closed when a stored active intent has an invalid expiry', async () => {
    const { service, intents, store } = createHarness();
    intents.set('self:2026-09-02', {
      id: 'intent-corrupt',
      accountId: 'self',
      organizationId: 'org-a',
      organizationName: '甲企业',
      displayName: '张某',
      parkId: 'park-a',
      ...publishInput,
      route,
      status: 'active',
      lastConfirmedAt: '2026-09-02T07:30:00.000Z',
      expiresAt: 'invalid',
      createdAt: '2026-09-02T07:30:00.000Z',
      updatedAt: '2026-09-02T07:30:00.000Z',
    });
    const state = await service.getState('self');
    expect(state.currentIntent?.status).toBe('expired');
    expect(state.matches).toEqual([]);
    expect(store.listActiveIntents).not.toHaveBeenCalled();
  });
});

describe('publish race and date regressions', () => {
  it('rejects a departure outside the selected Shanghai date before planning', async () => {
    const { service, provider } = createHarness();
    await expect(
      service.publishIntent('self', {
        ...publishInput,
        departureTime: '2026-09-03T18:30:00+08:00',
      }),
    ).rejects.toThrow(/日期/);
    expect(provider.planDrivingRoute).not.toHaveBeenCalled();
  });
  it('revalidates identity after planning', async () => {
    const { service, store, provider } = createHarness();
    provider.planDrivingRoute.mockImplementationOnce(async () => {
      store.getPrincipal.mockResolvedValue(null);
      return route;
    });
    await expect(service.publishIntent('self', publishInput)).rejects.toThrow(
      /账号/,
    );
    expect(store.saveIntent).not.toHaveBeenCalled();
  });
  it('does not revive an intent stopped during planning', async () => {
    const { service, provider } = createHarness();
    const saved = await service.publishIntent('self', publishInput);
    provider.planDrivingRoute.mockImplementationOnce(async () => {
      await service.stopIntent('self', saved.id);
      return route;
    });
    await expect(service.publishIntent('self', publishInput)).rejects.toThrow(
      /变化|更新|停止/,
    );
    expect((await service.getState('self')).currentIntent?.status).toBe(
      'paused',
    );
  });
});

it('only an explicit confirmation renews freshness and cannot restart stopped intents', async () => {
  const { service, store, intents } = createHarness();
  const saved = await service.publishIntent('self', publishInput);
  intents.set('self:2026-09-02', {
    ...saved,
    lastConfirmedAt: '2026-09-02T07:00:00Z',
  });
  await service.refreshMatches('self');
  expect((await store.getIntent('self'))?.lastConfirmedAt).toBe(
    '2026-09-02T07:00:00Z',
  );
  expect((await service.confirmIntent('self', saved.id)).lastConfirmedAt).toBe(
    '2026-09-02T09:00:00.000Z',
  );
  await service.stopIntent('self', saved.id);
  await expect(service.confirmIntent('self', saved.id)).rejects.toThrow(
    /停止|有效/,
  );
});
