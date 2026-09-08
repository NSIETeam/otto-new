/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { createParkCarpoolService } from './parkCarpoolService.js';

export interface ParkCarpoolHttpDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: { id: string } | null;
  service: ReturnType<typeof createParkCarpoolService>;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : '';
  if (/账号不可用|未启用园区服务|尚未绑定园区|无权/u.test(message)) return 403;
  if (/其他操作更新|已更新|正在处理/u.test(message)) return 409;
  if (/地图服务/u.test(message)) return 503;
  return 400;
}

export async function handleParkCarpoolHttp(
  input: ParkCarpoolHttpDeps,
): Promise<boolean> {
  if (!input.path.startsWith('/enterprise/park-carpool')) return false;
  if (!input.memberAccount) {
    input.sendJSON(input.res, 401, { error: '请先登录企业账号' });
    return true;
  }
  const accountId = input.memberAccount.id;
  try {
    if (
      (input.path === '/enterprise/park-carpool' ||
        input.path === '/enterprise/park-carpool/matches') &&
      input.method === 'GET'
    ) {
      input.sendJSON(input.res, 200, {
        state: input.path.endsWith('/matches')
          ? await input.service.refreshMatches(accountId, {
              cursor: input.url.searchParams.get('cursor') ?? undefined,
              filter: input.url.searchParams.get('filter') ?? undefined,
            })
          : await input.service.getState(accountId, {
              cursor: input.url.searchParams.get('cursor') ?? undefined,
              filter: input.url.searchParams.get('filter') ?? undefined,
            }),
      });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/transport' &&
      input.method === 'POST'
    ) {
      const { proof, ...command } = await input.readBody(input.req);
      input.sendJSON(input.res, 200, {
        result: await input.service.executeSignedTransport(
          accountId,
          command as never,
          proof as never,
        ),
      });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/workflow' &&
      input.method === 'GET'
    ) {
      input.sendJSON(input.res, 200, {
        workflow: await input.service.getWorkflow(accountId),
      });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/workflow' &&
      input.method === 'POST'
    ) {
      const body = await input.readBody(input.req);
      input.sendJSON(input.res, 200, {
        workflow: await input.service.executeWorkflow(accountId, body as never),
      });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/data' &&
      input.method === 'DELETE'
    ) {
      input.sendJSON(input.res, 200, {
        deleted: await input.service.deleteData(accountId),
      });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/route-preview' &&
      input.method === 'POST'
    ) {
      const body = await input.readBody(input.req);
      input.sendJSON(input.res, 200, {
        preview: await input.service.routePreview(
          accountId,
          String(body.intentId ?? ''),
          typeof body.groupId === 'string' ? body.groupId : undefined,
        ),
      });
      return true;
    }
    if (
      [
        '/enterprise/park-carpool/reverse',
        '/enterprise/park-carpool/map',
      ].includes(input.path) &&
      input.method === 'POST'
    ) {
      const body = await input.readBody(input.req);
      if (input.path.endsWith('/reverse'))
        input.sendJSON(input.res, 200, {
          place: await input.service.reversePlace(
            accountId,
            body.coordinate as never,
            body.system === 'gps' ? 'gps' : 'autonavi',
          ),
        });
      else
        input.sendJSON(input.res, 200, {
          image: await input.service.staticMap(
            accountId,
            body.coordinate as never,
            Number(body.zoom),
          ),
        });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/places' &&
      input.method === 'GET'
    ) {
      const query = input.url.searchParams.get('q') ?? '';
      const city = input.url.searchParams.get('city') ?? undefined;
      input.sendJSON(input.res, 200, {
        places: await input.service.searchPlaces(accountId, query, city),
      });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/intents' &&
      input.method === 'PUT'
    ) {
      const body = await input.readBody(input.req);
      const intent = await input.service.publishIntent(
        accountId,
        body as never,
      );
      input.sendJSON(input.res, 200, { intent });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/intents/confirm' &&
      input.method === 'POST'
    ) {
      const body = await input.readBody(input.req);
      input.sendJSON(input.res, 200, {
        intent: await input.service.confirmIntent(
          accountId,
          typeof body.intentId === 'string' ? body.intentId : '',
        ),
      });
      return true;
    }
    if (
      input.path === '/enterprise/park-carpool/intents/stop' &&
      input.method === 'POST'
    ) {
      const body = await input.readBody(input.req);
      const intent = await input.service.stopIntent(
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
