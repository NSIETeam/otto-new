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
        return new Response(
          JSON.stringify({
            status: '1',
            pois: [
              {
                id: 'poi-1',
                name: '回龙观地铁站',
                address: '同成街',
                adname: '昌平区',
                location: '116.320000,40.070000',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          status: '1',
          route: {
            paths: [
              {
                distance: '12000',
                duration: '1800',
                steps: [
                  { polyline: '116.230000,40.220000;116.280000,40.190000' },
                  { polyline: '116.280000,40.190000;116.320000,40.070000' },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      );
    });
    const provider = createAmapParkCarpoolProvider({
      key: 'server-secret-key',
      fetchImpl: fetchMock,
    });

    await expect(provider.searchPlaces('回龙观', '北京')).resolves.toEqual([
      {
        id: 'poi-1',
        label: '回龙观地铁站',
        address: '同成街',
        district: '昌平区',
        coordinate: { longitude: 116.32, latitude: 40.07 },
      },
    ]);
    await expect(
      provider.planDrivingRoute(
        { longitude: 116.23, latitude: 40.22 },
        { longitude: 116.32, latitude: 40.07 },
      ),
    ).resolves.toMatchObject({
      provider: 'amap',
      distanceMeters: 12000,
      durationSeconds: 1800,
      polyline: [
        { longitude: 116.23, latitude: 40.22 },
        { longitude: 116.28, latitude: 40.19 },
        { longitude: 116.32, latitude: 40.07 },
      ],
    });
    expect(
      fetchMock.mock.calls.every(([url]) =>
        String(url).includes('key=server-secret-key'),
      ),
    ).toBe(true);
  });

  it('is unavailable without a key and does not invent data on provider errors', async () => {
    const unavailable = createAmapParkCarpoolProvider({ key: '' });
    expect(unavailable.configured).toBe(false);
    await expect(unavailable.searchPlaces('回龙观')).rejects.toThrow(
      /尚未配置/u,
    );

    const failing = createAmapParkCarpoolProvider({
      key: 'secret',
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: '0',
              info: 'DAILY_QUERY_OVER_LIMIT',
              infocode: '10003',
            }),
            { status: 200 },
          ),
      ),
    });
    await expect(
      failing.planDrivingRoute(
        { longitude: 116.23, latitude: 40.22 },
        { longitude: 116.32, latitude: 40.07 },
      ),
    ).rejects.toThrow(/地图服务/u);
  });
});

it('converts clicked GPS only when requested, derives district-only public areas and proxies actual map bytes', async () => {
  const provider = createAmapParkCarpoolProvider({
    key: 'test-key',
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/convert'))
        return new Response(
          JSON.stringify({ status: '1', locations: '116.01,40.01' }),
        );
      if (url.pathname.endsWith('/regeo'))
        return new Response(
          JSON.stringify({
            status: '1',
            regeocode: {
              formatted_address: '测试小区十二号楼三单元二〇一室',
              addressComponent: {
                province: '测试省',
                city: '测试市',
                district: '测试区',
                adcode: '110101',
              },
            },
          }),
        );
      return new Response(Buffer.from('89504e470d0a1a0a', 'hex'), {
        headers: { 'content-type': 'image/png' },
      });
    },
  });
  const place = await provider.reverseGeocode!(
    { longitude: 116, latitude: 40 },
    'gps',
  );
  expect(place.coordinate).toEqual({ longitude: 116.01, latitude: 40.01 });
  expect(place.publicArea).toEqual({
    label: '测试省测试市测试区',
    code: '110101',
    precision: 'district',
  });
  expect(JSON.stringify(place.publicArea)).not.toContain('十二号楼');
  expect(
    await provider.staticMap!({ longitude: 116, latitude: 40 }, 14),
  ).toMatch(/^data:image\/png;base64,/);
});

it.each([null, [], 'bad'])('maps malformed provider envelopes to a controlled map failure: %j', async body => {
  const provider = createAmapParkCarpoolProvider({key:'test-only',fetchImpl:async()=>new Response(JSON.stringify(body))});
  await expect(provider.searchPlaces('公共站点','杭州')).rejects.toThrow(/地图服务/);
});
it('rejects invalid converted coordinates and hides network details for static maps', async () => {
  const provider=createAmapParkCarpoolProvider({key:'test-only',fetchImpl:async()=>new Response(JSON.stringify({status:'1',locations:'120,30,999'}))});
  await expect(provider.reverseGeocode!({longitude:120,latitude:30},'gps')).rejects.toThrow(/坐标转换失败/);
  const offline=createAmapParkCarpoolProvider({key:'test-only',fetchImpl:async()=>{throw new Error('INTERNAL_SECRET_endpoint');}});
  await expect(offline.staticMap!({longitude:120,latitude:30},12)).rejects.toThrow('地图服务连接失败，请稍后重试');
});
it.each([
  ['rate limit',()=>new Response('{}',{status:429})],
  ['bad JSON',()=>new Response('{')],
  ['no route',()=>new Response(JSON.stringify({status:'1',route:{paths:[]}}))],
] as const)('fails explicitly for %s without inventing a route',async (_name,response)=>{
 const provider=createAmapParkCarpoolProvider({key:'test-only',fetchImpl:async()=>response()});
 await expect(provider.planDrivingRoute({longitude:120,latitude:30},{longitude:120.1,latitude:30})).rejects.toThrow(/地图服务/);
});
it('uses an eight second abort deadline and returns a controlled timeout',async()=>{
 const provider=createAmapParkCarpoolProvider({key:'test-only',fetchImpl:async(_url,options)=>{
   expect(options?.signal).toBeInstanceOf(AbortSignal);
   throw new DOMException('timed out','TimeoutError');
 }});
 await expect(provider.searchPlaces('公共站点','杭州')).rejects.toThrow('地图服务连接失败，请稍后重试');
});
