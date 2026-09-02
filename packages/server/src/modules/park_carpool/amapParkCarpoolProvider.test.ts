/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { createAmapParkCarpoolProvider } from './amapParkCarpoolProvider.js';

describe('createAmapParkCarpoolProvider', () => {
  it('keeps the key on the server and normalizes place and route responses', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.includes('/place/text')) {
        return new Response(JSON.stringify({
          status: '1',
          pois: [{
            id: 'poi-1', name: '回龙观地铁站', address: '同成街',
            adname: '昌平区', location: '116.320000,40.070000',
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: '1',
        route: {
          paths: [{
            distance: '12000', duration: '1800',
            steps: [
              { polyline: '116.230000,40.220000;116.280000,40.190000' },
              { polyline: '116.280000,40.190000;116.320000,40.070000' },
            ],
          }],
        },
      }), { status: 200 });
    });
    const provider = createAmapParkCarpoolProvider({
      key: 'server-secret-key', fetchImpl: fetchMock,
    });

    await expect(provider.searchPlaces('回龙观', '北京')).resolves.toEqual([{
      id: 'poi-1', label: '回龙观地铁站', address: '同成街', district: '昌平区',
      coordinate: { longitude: 116.32, latitude: 40.07 },
    }]);
    await expect(provider.planDrivingRoute(
      { longitude: 116.23, latitude: 40.22 },
      { longitude: 116.32, latitude: 40.07 },
    )).resolves.toMatchObject({
      provider: 'amap', distanceMeters: 12000, durationSeconds: 1800,
      polyline: [
        { longitude: 116.23, latitude: 40.22 },
        { longitude: 116.28, latitude: 40.19 },
        { longitude: 116.32, latitude: 40.07 },
      ],
    });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('key=server-secret-key'))).toBe(true);
  });

  it('is unavailable without a key and does not invent data on provider errors', async () => {
    const unavailable = createAmapParkCarpoolProvider({ key: '' });
    expect(unavailable.configured).toBe(false);
    await expect(unavailable.searchPlaces('回龙观')).rejects.toThrow(/尚未配置/u);

    const failing = createAmapParkCarpoolProvider({
      key: 'secret',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003',
      }), { status: 200 })),
    });
    await expect(failing.planDrivingRoute(
      { longitude: 116.23, latitude: 40.22 },
      { longitude: 116.32, latitude: 40.07 },
    )).rejects.toThrow(/地图服务/u);
  });
});
