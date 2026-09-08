/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WorkableConnectionError, type WorkableConnectionAction, type WorkableConnectionService } from './workableConnections.js';

export async function handleWorkableConnectionRoute(input: {
  path: string; method: string; accountId: string; req: IncomingMessage; res: ServerResponse;
  service(): WorkableConnectionService;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
}): Promise<boolean> {
  if (input.path !== '/enterprise/recruitment/workable') return false;
  input.res.setHeader('Cache-Control', 'no-store');
  if (input.method !== 'POST') { input.sendJson(input.res, 405, { error: 'method not allowed' }); return true; }
  try {
    const body = await input.readBody(input.req, 8_192);
    const result = await input.service().act(input.accountId, body as WorkableConnectionAction);
    input.sendJson(input.res, 200, { contract: 'otto-workable-connection-v1', result });
  } catch (error) {
    input.sendJson(input.res, error instanceof WorkableConnectionError ? error.status : 500, {
      code: 'WORKABLE_CONNECTION_FAILED', error: error instanceof WorkableConnectionError ? error.message : 'Workable 授权操作失败，请刷新后重试',
    });
  }
  return true;
}
