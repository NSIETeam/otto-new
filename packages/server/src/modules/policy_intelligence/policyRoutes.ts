/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PolicyAction } from './contracts.js';
import type { EnterprisePolicyService } from './policyService.js';
import { PolicyOperationError } from './policyErrors.js';
import { createPolicyModelWithInvoker } from './policyModel.js';
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
    const executionPath = /^\/enterprise\/policy-intelligence\/executions(?:\/([a-f0-9-]{36})(?:\/(reply|cancel))?)?$/u.exec(input.path);
    if (executionPath) {
      const service = input.service();
      const accountId = input.accountId;
      const scope = await service.clientExecutionScope(accountId);
      const [, id, operation] = executionPath;
      if (!id && input.method === 'POST') {
        const body = await input.readBody(input.req, 32000);
        const action = body.action as PolicyAction | undefined;
        if (!action || !['sync', 'diagnose', 'answer'].includes(action.action) || typeof body.modelName !== 'string' || !body.modelName.trim() || body.modelName.length > 200) throw new PolicyOperationError('政策分析请求格式错误');
        const runId = service.clientExecutions.start(accountId, scope, invoke => service.actWithModel(accountId, action,
          createPolicyModelWithInvoker(body.modelName as string, async (instruction, data, signal) => {
            if (await service.clientExecutionScope(accountId) !== scope) throw new PolicyOperationError('企业账号已变化，本次分析已取消');
            return invoke(instruction, data, signal);
          }), scope));
        input.sendJSON(input.res, 200, { runId });
      } else if (id && input.method === 'GET' && !operation) {
        const view = await service.clientExecutions.poll(id, accountId, scope);
        if (await service.clientExecutionScope(accountId) !== scope) throw new PolicyOperationError('企业账号已变化');
        input.sendJSON(input.res, 200, view);
      } else if (id && input.method === 'POST' && operation === 'reply') {
        const body = await input.readBody(input.req, 550000);
        service.clientExecutions.reply(id, accountId, scope, body.requestId, body.result);
        input.sendJSON(input.res, 200, { accepted: true });
      } else if (id && input.method === 'POST' && operation === 'cancel') {
        service.clientExecutions.cancel(id, accountId, scope);
        input.sendJSON(input.res, 200, { cancelled: true });
      } else input.sendJSON(input.res, 404, { error: '政策接口不存在' });
    } else if (
      input.path === '/enterprise/policy-intelligence' &&
      input.method === 'GET'
    )
      input.sendJSON(input.res, 200, {
        state: await input.service().state(input.accountId),
      });
    else if (
      input.path === '/enterprise/policy-intelligence/inbox' &&
      input.method === 'GET'
    ) {
      input.sendJSON(input.res, 200, {
        inbox: await input.service().inbox(input.accountId),
      });
    } else if (
      input.path === '/enterprise/policy-intelligence/inbox/read' &&
      input.method === 'POST'
    ) {
      const body = await input.readBody(input.req, 16000);
      input.sendJSON(input.res, 200, {
        inbox: await input
          .service()
          .readNotifications(input.accountId, body.ids),
      });
    } else if (
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
          : '政策服务暂时不可用，请检查当前对话的模型设置或稍后重试';
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
