/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import * as db from './db.js';

export interface ParkCarpoolRouteDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView | null;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  if (/账号不可用|未启用园区服务|尚未绑定园区|无权/u.test(message)) return 403;
  if (/地图服务/u.test(message)) return 503;
  return 400;
}

export async function handleParkCarpoolRoute(input: ParkCarpoolRouteDeps): Promise<boolean> {
  if (!input.path.startsWith('/enterprise/park-carpool')) return false;
  if (!input.memberAccount) {
    input.sendJSON(input.res, 401, { error: '请先登录企业账号' });
    return true;
  }
  const accountId = input.memberAccount.id;
  try {
    if (
      (input.path === '/enterprise/park-carpool'
        || input.path === '/enterprise/park-carpool/matches')
      && input.method === 'GET'
    ) {
      input.sendJSON(input.res, 200, {
        state: input.path.endsWith('/matches')
          ? await db.refreshParkCarpoolMatches(accountId)
          : await db.getParkCarpoolState(accountId),
      });
      return true;
    }
    if (input.path === '/enterprise/park-carpool/places' && input.method === 'GET') {
      const query = input.url.searchParams.get('q') ?? '';
      const city = input.url.searchParams.get('city') ?? undefined;
      input.sendJSON(input.res, 200, {
        places: await db.searchParkCarpoolPlaces(accountId, query, city),
      });
      return true;
    }
    if (input.path === '/enterprise/park-carpool/intents' && input.method === 'PUT') {
      const body = await input.readBody(input.req);
      const intent = await db.publishParkCarpoolIntent(accountId, body as never);
      input.sendJSON(input.res, 200, { intent });
      return true;
    }
    if (input.path === '/enterprise/park-carpool/intents/stop' && input.method === 'POST') {
      const body = await input.readBody(input.req);
      const intent = await db.stopParkCarpoolIntent(
        accountId,
        typeof body.intentId === 'string' ? body.intentId : '',
      );
      input.sendJSON(input.res, 200, { intent });
      return true;
    }
    input.sendJSON(input.res, 404, { error: '拼车助手接口不存在' });
  } catch (error) {
    input.sendJSON(input.res, errorStatus(error), {
      error: error instanceof Error ? error.message : '拼车助手请求失败',
    });
  }
  return true;
}
