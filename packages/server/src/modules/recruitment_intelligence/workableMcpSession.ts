/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import { createWorkableRecruitmentAdapter, type WorkableRecruitmentScope, type WorkableRecruitmentSession, type WorkableTool } from './workableRecruitmentAdapter.js';
import type { RecruitmentSourceRegistration } from './recruitmentSourceRuntime.js';
import { createRecruitmentResumeReader } from './recruitmentResumeReader.js';
import { readWorkableJson as readJson } from './workableHttp.js';

export interface WorkableOAuthGrant extends WorkableRecruitmentScope {
  account: string;
  jobShortcode: string;
  /** Must change when account/job authorization is edited, not on ordinary token refresh. */
  bindingRevision: string;
  accessToken: string;
  expiresAt: string;
}

const ENDPOINT = 'https://mcp.workable.com/mcp';
const MAX_BYTES = 2_000_000;
const failure = (message: string): never => { throw new Error(`Workable ${message}`); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : failure('协议响应无效');

/**
 * Narrow client for Workable's documented stateless JSON profile, NOT a generic MCP client.
 * OAuth consent/refresh and encrypted credential storage belong to the injected broker.
 * No dynamic URL, global credential fallback, SSE, model sampling, writes or automatic retries.
 */
export function createWorkableMcpSessionFactory(options: {
  resolveGrant(scope: WorkableRecruitmentScope, signal: AbortSignal): Promise<WorkableOAuthGrant | null>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): (scope: WorkableRecruitmentScope, signal: AbortSignal) => Promise<WorkableRecruitmentSession> {
  return async (scope, callerSignal) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal, AbortSignal.timeout(60_000)]);
    let closed = false;
    let binding: string | undefined;
    const load = async (): Promise<WorkableOAuthGrant> => {
      if (closed) return failure('会话已关闭');
      signal.throwIfAborted();
      let grant: WorkableOAuthGrant | null;
      try { grant = await options.resolveGrant({ ...scope }, signal); }
      catch { return failure('无法确认当前企业授权'); }
      signal.throwIfAborted();
      if (!grant || grant.organizationId !== scope.organizationId || grant.actorAccountId !== scope.actorAccountId || grant.requisitionId !== scope.requisitionId
        || ![grant.account, grant.jobShortcode, grant.bindingRevision].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value))
        || typeof grant.accessToken !== 'string' || !/^[\x21-\x7E]{1,8192}$/u.test(grant.accessToken)
        || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= (options.now ?? Date.now)()) return failure('企业授权缺失、过期或范围不匹配');
      const current = JSON.stringify([grant.account, grant.jobShortcode, grant.bindingRevision]);
      if (binding !== undefined && binding !== current) return failure('授权绑定已变化，请重新检索');
      binding = current;
      return grant;
    };
    const initial = await load();
    // Keep binding metadata only. Tokens are freshly resolved for each HTTP request.
    const account = initial.account;
    const jobShortcode = initial.jobShortcode;
    const bindingRevision = initial.bindingRevision;
    let protocolVersion: string | undefined;
    const rpc = async (method: string, params?: Record<string, unknown>, notification = false): Promise<Record<string, unknown>> => {
      const grant = await load();
      const requestId = randomUUID();
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(ENDPOINT, {
          method: 'POST', redirect: 'error', credentials: 'omit', signal,
          headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream', ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, ...(params ? { params } : {}) }),
        });
      } catch { return failure('网络请求失败或已取消，请重新检查连接'); }
      try {
        await load();
        if (!response.ok) return failure(response.status === 401 || response.status === 403 ? '授权被拒绝，请重新授权'
          : response.status === 429 ? '请求受限，请稍后重试' : '服务器请求失败');
        if (response.redirected || (response.url && response.url !== ENDPOINT) || response.headers.has('mcp-session-id')) return failure('服务端不再符合已验收的无状态协议');
        if (notification) {
          if (response.status !== 202) return failure('初始化通知未被确认');
          return {};
        }
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure('仅支持已验收的 JSON 响应');
        if (Number(response.headers.get('content-length')) > MAX_BYTES) return failure('协议响应过大');
        const body = await readJson(response);
        await load();
        if (body.jsonrpc !== '2.0' || body.id !== requestId || Object.hasOwn(body, 'error') || !Object.hasOwn(body, 'result')) return failure('协议调用失败或响应不匹配');
        return object(body.result);
      } finally { try { await response.body?.cancel(); } catch { /* Already consumed/locked body. */ } }
    };
    let initialized: Promise<void> | undefined;
    const initialize = (): Promise<void> => initialized ??= (async () => {
      const result = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'otto-recruitment-readonly', version: '1.0.0' } });
      if (result.protocolVersion !== '2025-06-18' && result.protocolVersion !== '2025-03-26') failure('协议版本尚未验收');
      if (!Object.hasOwn(object(result.capabilities), 'tools')) failure('服务器未声明工具能力');
      protocolVersion = result.protocolVersion as string;
      await rpc('notifications/initialized', undefined, true);
    })();
    return {
      account, jobShortcode, bindingRevision,
      assertAuthorized: async () => { await load(); },
      async listTools() {
        await load();
        await initialize();
        const tools: WorkableTool[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          const result = await rpc('tools/list', cursor ? { cursor } : {});
          if (!Array.isArray(result.tools)) return failure('工具契约无效');
          for (const item of result.tools) {
            const raw = object(item);
            const schema = object(raw.inputSchema);
            if (typeof raw.name !== 'string' || schema.type !== 'object' || (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === 'string')))) return failure('工具契约无效');
            tools.push({ name: raw.name, inputSchema: { type: 'object', properties: object(schema.properties ?? {}), required: (schema.required ?? []) as string[] } });
          }
          if (tools.length > 500) return failure('工具契约超过数量上限');
          if (result.nextCursor !== undefined && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 2_000)) return failure('工具分页无效');
          cursor = result.nextCursor as string | undefined;
          if (cursor) {
            if (seen.has(cursor) || seen.size >= 10) return failure('工具分页未推进或超限');
            seen.add(cursor);
          }
        } while (cursor);
        return tools;
      },
      async callTool(name, args) {
        if (!['get_accounts', 'get_candidates', 'get_candidate'].includes(name)) return failure('此连接仅允许已审核的只读工具');
        if ((name === 'get_accounts' && Object.keys(args).length > 0)
          || (name !== 'get_accounts' && args.account !== account)
          || (name === 'get_candidates' && (args.shortcode ?? args.job_shortcode) !== jobShortcode)) return failure('工具参数与账号或岗位绑定不匹配');
        await load();
        await initialize();
        return rpc('tools/call', { name, arguments: args });
      },
      async close() { closed = true; controller.abort(); },
    };
  };
}

/** Server composition entry point. Mock tests alone must never set realAccountVerified. */
export function createWorkableRecruitmentRegistration(options: Parameters<typeof createWorkableMcpSessionFactory>[0] & {
  approval?: { realAccountVerified: boolean; authorizationReference: string };
  resume?: { approvedOrigins: readonly string[] };
}): RecruitmentSourceRegistration {
  const reference = options.approval?.authorizationReference.trim();
  return {
    adapter: createWorkableRecruitmentAdapter({ openSession: createWorkableMcpSessionFactory(options), ...(options.resume ? { resumeReader: createRecruitmentResumeReader(options.resume) } : {}) }),
    accessMode: 'authorized_mcp',
    productionEnabled: options.approval?.realAccountVerified === true && Boolean(reference),
    ...(reference ? { authorizationReference: reference } : {}),
  };
}
