/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PolicyAction } from './contracts.js';
import type { EnterprisePolicyService } from './policyService.js';
import { PolicyOperationError } from './policyErrors.js';
export async function handlePolicyRoute(input: {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  accountId?: string;
  service: () => EnterprisePolicyService;
  readBody(
    req: IncomingMessage,
    limit?: number,
  ): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}): Promise<boolean> {
  if (
    input.path !== '/enterprise/policy-intelligence' &&
    !input.path.startsWith('/enterprise/policy-intelligence/')
  )
    return false;
  if (!input.accountId) {
    input.sendJSON(input.res, 401, { error: '请先登录企业账号' });
    return true;
  }
  try {
    if (
      input.path === '/enterprise/policy-intelligence' &&
      input.method === 'GET'
    )
      input.sendJSON(input.res, 200, {
        state: await input.service().state(input.accountId),
      });
    else if (
      input.path === '/enterprise/policy-intelligence/actions' &&
      input.method === 'POST'
    ) {
      const body = await input.readBody(input.req, 32000);
      if (JSON.stringify(body).length > 32000)
        throw new PolicyOperationError('政策请求过大');
      input.sendJSON(input.res, 200, {
        state: await input
          .service()
          .act(input.accountId, body as unknown as PolicyAction),
      });
    } else input.sendJSON(input.res, 404, { error: '政策接口不存在' });
  } catch (error) {
    const message =
      error instanceof PolicyOperationError
        ? error.message
        : error instanceof Error &&
            ['AbortError', 'TimeoutError'].includes(error.name)
          ? '政策分析已取消或超时，请稍后重试'
          : '政策服务暂时不可用，请检查服务端模型配置或稍后重试';
    input.sendJSON(
      input.res,
      !(error instanceof PolicyOperationError)
        ? 503
        : /管理员|无权|账号不可用/u.test(message)
          ? 403
          : /已更新|正在更新/u.test(message)
            ? 409
            : 400,
      { error: message.slice(0, 300) },
    );
  }
  return true;
}
