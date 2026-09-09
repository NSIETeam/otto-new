/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const carpoolDb = vi.hoisted(() => ({
  executeSignedParkCarpoolTransport: vi.fn(),
  executeParkCarpoolTransport: vi.fn(),
  maintainParkCarpool: vi.fn(),
  deleteParkCarpoolData: vi.fn(),
  getParkCarpoolRoutePreview: vi.fn(),
  reverseParkCarpoolPlace: vi.fn(),
  getParkCarpoolStaticMap: vi.fn(),
  getParkCarpoolWorkflow: vi.fn(),
  executeParkCarpoolWorkflow: vi.fn(),

  getParkCarpoolState: vi.fn(),
  refreshParkCarpoolMatches: vi.fn(),
  searchParkCarpoolPlaces: vi.fn(),
  publishParkCarpoolIntent: vi.fn(),
  stopParkCarpoolIntent: vi.fn(),
  confirmParkCarpoolIntent: vi.fn(),
}));

vi.mock('./db.js', () => carpoolDb);

import { handleParkCarpoolRoute } from './parkCarpoolRoutes.js';

function request(input: {
  path: string;
  method?: string;
  member?: { id: string } | null;
  body?: Record<string, unknown>;
}) {
  const responses: Array<{ status: number; data: unknown }> = [];
  const url = new URL(`https://enterprise.example${input.path}`);
  return {
    responses,
    invoke: () => handleParkCarpoolRoute({
      path: url.pathname,
      method: input.method ?? 'GET',
      url,
      req: {} as IncomingMessage,
      res: {} as ServerResponse,
      memberAccount: (input.member === undefined ? { id: 'account-a' } : input.member) as never,
      readBody: vi.fn(async () => input.body ?? {}),
      sendJSON: (_res, status, data) => { responses.push({ status, data }); },
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('park carpool enterprise routes', () => {
  it('requires an authenticated enterprise account before any repository call', async () => {
    const harness = request({ path: '/enterprise/park-carpool', member: null });
    await expect(harness.invoke()).resolves.toBe(true);
    expect(harness.responses).toEqual([{ status: 401, data: { error: '请先登录企业账号' } }]);
    expect(carpoolDb.getParkCarpoolState).not.toHaveBeenCalled();
  });

  it('derives the owner from the session for state, publish and stop operations', async () => {
    carpoolDb.getParkCarpoolState.mockResolvedValueOnce({ capability: 'park_carpool_v1' });
    const state = request({ path: '/enterprise/park-carpool' });
    await state.invoke();
    expect(carpoolDb.getParkCarpoolState).toHaveBeenCalledWith('account-a', {cursor:undefined,filter:undefined});
    expect(state.responses[0]).toMatchObject({ status: 200 });

    carpoolDb.publishParkCarpoolIntent.mockResolvedValueOnce({ id: 'intent-a' });
    const publish = request({
      path: '/enterprise/park-carpool/intents', method: 'PUT',
      body: { accountId: 'attacker', parkId: 'other-park', travelDate: '2026-09-02' },
    });
    await publish.invoke();
    expect(carpoolDb.publishParkCarpoolIntent).toHaveBeenCalledWith(
      'account-a',
      expect.objectContaining({ accountId: 'attacker', parkId: 'other-park' }),
    );

    carpoolDb.stopParkCarpoolIntent.mockResolvedValueOnce({ id: 'intent-a', status: 'paused' });
    const stop = request({
      path: '/enterprise/park-carpool/intents/stop', method: 'POST',
      body: { intentId: 'intent-a', accountId: 'attacker' },
    });
    await stop.invoke();
    expect(carpoolDb.stopParkCarpoolIntent).toHaveBeenCalledWith('account-a', 'intent-a');
  });

  it('maps entitlement and map-provider failures without leaking exception details', async () => {
    carpoolDb.getParkCarpoolState.mockRejectedValueOnce(new Error('当前企业未启用园区服务'));
    const forbidden = request({ path: '/enterprise/park-carpool' });
    await forbidden.invoke();
    expect(forbidden.responses[0]).toEqual({ status: 403, data: { error: '当前企业未启用园区服务' } });

    carpoolDb.searchParkCarpoolPlaces.mockRejectedValueOnce(new Error('地图服务连接失败，请稍后重试'));
    const unavailable = request({ path: '/enterprise/park-carpool/places?q=园区' });
    await unavailable.invoke();
    expect(unavailable.responses[0]).toEqual({ status: 503, data: { error: '地图服务连接失败，请稍后重试' } });
  });
});

const endpoints = [
  ['', 'GET'], ['/matches', 'GET'], ['/places', 'GET'], ['/intents', 'PUT'],
  ['/intents/stop', 'POST'], ['/intents/confirm', 'POST'], ['/workflow', 'GET'],
  ['/workflow', 'POST'], ['/transport', 'POST'], ['/data', 'DELETE'],
  ['/route-preview', 'POST'], ['/reverse', 'POST'], ['/map', 'POST'],
] as const;
it.each(endpoints)('rejects anonymous %s %s before every business dependency', async (path, method) => {
  const h = request({path: `/enterprise/park-carpool${path}`, method, member: null});
  await h.invoke();
  expect(h.responses).toEqual([{status: 401, data: {error: '请先登录企业账号'}}]);
  for (const dependency of Object.values(carpoolDb)) expect(dependency).not.toHaveBeenCalled();
});
it.each([
  ['', 'GET', {}, 'getParkCarpoolState', ['account-a', {cursor: 'cursor-a', filter: 'shared_taxi'}]],
  ['/matches', 'GET', {}, 'refreshParkCarpoolMatches', ['account-a', {cursor: 'cursor-a', filter: 'shared_taxi'}]],
  ['/workflow', 'GET', {}, 'getParkCarpoolWorkflow', ['account-a']],
  ['/workflow', 'POST', {type: 'request', accountId: 'forged', parkId: 'forged'}, 'executeParkCarpoolWorkflow', ['account-a', {type: 'request', accountId: 'forged', parkId: 'forged'}]],
  ['/transport', 'POST', {type: 'state', proof: {signature: 'signed'}}, 'executeSignedParkCarpoolTransport', ['account-a', {type: 'state'}, {signature: 'signed'}]],
  ['/data', 'DELETE', {accountId: 'forged'}, 'deleteParkCarpoolData', ['account-a']],
  ['/route-preview', 'POST', {intentId: 'i', groupId: 'g'}, 'getParkCarpoolRoutePreview', ['account-a', 'i', 'g']],
  ['/reverse', 'POST', {coordinate: {longitude: 116, latitude: 40}, system: 'gps'}, 'reverseParkCarpoolPlace', ['account-a', {longitude: 116, latitude: 40}, 'gps']],
  ['/map', 'POST', {coordinate: {longitude: 116, latitude: 40}, zoom: 12}, 'getParkCarpoolStaticMap', ['account-a', {longitude: 116, latitude: 40}, 12]],
] as const)('dispatches %s %s with exact authenticated arguments', async (path, method, body, dependency, args) => {
  const h = request({path: `/enterprise/park-carpool${path}?cursor=cursor-a&filter=shared_taxi`, method, body});
  await h.invoke();
  expect(h.responses[0]?.status).toBe(200);
  expect(carpoolDb[dependency]).toHaveBeenCalledExactlyOnceWith(...args);
  for (const [name, fn] of Object.entries(carpoolDb)) if (name !== dependency) expect(fn).not.toHaveBeenCalled();
});
it('does not expose internal maintenance or unsigned transport', async () => {
  const h = request({path: '/enterprise/park-carpool/maintain', method: 'POST'});
  await h.invoke();
  expect(h.responses[0]?.status).toBe(404);
  for (const dependency of Object.values(carpoolDb)) expect(dependency).not.toHaveBeenCalled();
});
it.each(['INTERNAL_SECRET_database_path', '地图服务连接失败，请稍后重试 INTERNAL_SECRET'])('redacts unknown exceptions, including misleading business prefixes: %s', async (message) => {
  carpoolDb.getParkCarpoolState.mockRejectedValueOnce(new Error(message));
  const h = request({path: '/enterprise/park-carpool'});
  await h.invoke();
  expect(h.responses).toEqual([{status: 500, data: {error: '拼车助手请求失败，请稍后重试'}}]);
});
