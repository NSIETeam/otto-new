/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import { readWorkableJson, workableObject as object } from './workableHttp.js';
import type { WorkableVerifiedTarget } from './workableConnectionStore.js';

const RESOURCE = 'https://mcp.workable.com/mcp';
const ISSUER = 'https://mcp.workable.com';
const AUTHORIZE = 'https://workable.com/oauth/authorize';
const TOKEN = 'https://workable.com/oauth/token';
const REGISTER = `${ISSUER}/oauth/register`;
const SCOPES = ['r_account', 'r_jobs', 'r_candidates'];
const fail = (message: string): never => { throw new Error(`Workable ${message}`); };
const id = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value) ? value : fail('目录标识无效');
export function validateWorkableRedirect(value: string): void {
  let url: URL; try { url = new URL(value); } catch { return fail('回调地址无效'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || url.pathname !== '/otto-workable-callback'
    || url.search || url.hash || url.username || url.password || url.href !== value) fail('仅允许本机临时回调地址');
}
export interface WorkableOAuthPrepared { clientId: string; authorizationUrl: string }
export interface WorkableOAuthClient {
  prepare(input: { redirectUri: string; state: string; verifier: string }, check: () => Promise<void>): Promise<WorkableOAuthPrepared>;
  complete(input: { clientId: string; redirectUri: string; verifier: string; code: string }, check: () => Promise<void>): Promise<{ accessToken: string; expiresAt: string; targets: WorkableVerifiedTarget[] }>;
}

/** Fixed official endpoints. Narrow public-client PKCE profile; never downgrade auth or scopes. */
export function createWorkableOAuthClient(options: { fetch?: typeof fetch; now?: () => number } = {}): WorkableOAuthClient {
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? globalThis.fetch;
  function requester(check: () => Promise<void>) {
    const signal = AbortSignal.timeout(90_000);
    return async (url: string, init: RequestInit = {}, notification = false): Promise<Record<string, unknown>> => {
      await check(); signal.throwIfAborted();
      let response: Response;
      try { response = await fetcher(url, { ...init, redirect: 'error', credentials: 'omit', signal }); }
      catch { return fail('网络请求失败或超时，请重新授权'); }
      try {
        await check();
        if (!response.ok || response.redirected || (response.url && response.url !== url)) fail(response.status === 429 ? '请求受限，请稍后重试' : '官方接口拒绝请求，请检查授权或重新验收');
        if (response.headers.has('mcp-session-id')) fail('协议已变化，暂不接受有状态会话');
        if (notification) { if (response.status !== 202) fail('初始化未确认'); return {}; }
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('响应类型无效');
        const result = await readWorkableJson(response, url === RESOURCE ? 2_000_000 : 65_536);
        await check(); signal.throwIfAborted(); return result;
      } finally { try { await response.body?.cancel(); } catch { /* Reader already consumed body. */ } }
    };
  }
  return {
    async prepare(input, check) {
      validateWorkableRedirect(input.redirectUri);
      if (![input.state, input.verifier].every((value) => /^[A-Za-z0-9_-]{43,128}$/u.test(value))) fail('授权随机值无效');
      const request = requester(check);
      const resource = await request(`${ISSUER}/.well-known/oauth-protected-resource`);
      if (resource.resource !== RESOURCE || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(ISSUER)) fail('资源元数据不匹配');
      const metadata = await request(`${ISSUER}/.well-known/oauth-authorization-server`);
      if (metadata.issuer !== ISSUER || metadata.authorization_endpoint !== AUTHORIZE || metadata.token_endpoint !== TOKEN || metadata.registration_endpoint !== REGISTER
        || !Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes('code')
        || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')
        || !Array.isArray(metadata.scopes_supported) || !SCOPES.every((scope) => (metadata.scopes_supported as unknown[]).includes(scope))) fail('授权元数据变化或不支持安全 PKCE');
      const client = await request(REGISTER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Otto Recruitment Readonly', redirect_uris: [input.redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: SCOPES.join(' ') }) });
      if (typeof client.client_id !== 'string' || !/^[\x21-\x7E]{1,500}$/u.test(client.client_id) || client.token_endpoint_auth_method !== 'none'
        || !Array.isArray(client.redirect_uris) || client.redirect_uris.length !== 1 || client.redirect_uris[0] !== input.redirectUri
        || client.client_secret !== undefined) fail('动态注册未接受已审核的无密钥客户端，请重新验收');
      if (client.scope !== undefined && (typeof client.scope !== 'string' || client.scope.split(/ +/u).length !== SCOPES.length || !SCOPES.every((scope) => (client.scope as string).split(/ +/u).includes(scope)))) fail('动态注册返回了非预期权限');
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({ client_id: client.client_id as string, redirect_uri: input.redirectUri, response_type: 'code', scope: SCOPES.join(' '), state: input.state, code_challenge: createHash('sha256').update(input.verifier).digest('base64url'), code_challenge_method: 'S256', resource: RESOURCE }).toString();
      return { clientId: client.client_id as string, authorizationUrl: url.href };
    },
    async complete(input, check) {
      validateWorkableRedirect(input.redirectUri);
      if (typeof input.code !== 'string' || !/^[\x21-\x7E]{1,2048}$/u.test(input.code)) fail('授权码无效');
      const request = requester(check);
      const exchangeStartedAt = now();
      const token = await request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, client_id: input.clientId, redirect_uri: input.redirectUri, code_verifier: input.verifier, resource: RESOURCE }).toString() });
      const returnedScopes = typeof token.scope === 'string' ? token.scope.split(/ +/u) : SCOPES;
      if (typeof token.access_token !== 'string' || !/^[\x21-\x7E]{1,8192}$/u.test(token.access_token) || String(token.token_type).toLowerCase() !== 'bearer'
        || typeof token.expires_in !== 'number' || !Number.isSafeInteger(token.expires_in) || token.expires_in < 1 || token.expires_in > 31_536_000
        || returnedScopes.length !== SCOPES.length || !SCOPES.every((scope) => returnedScopes.includes(scope))) fail('令牌有效期或只读权限不符合要求');
      const expiresAt = new Date(exchangeStartedAt + (token.expires_in as number) * 1000).toISOString();
      let version: string | undefined = undefined;
      const rpc = async (method: string, params?: Record<string, unknown>, notification = false) => {
        if (Date.parse(expiresAt) <= now()) fail('目录读取期间授权已过期');
        const rpcId = randomUUID();
        const response = await request(RESOURCE, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(version ? { 'MCP-Protocol-Version': version } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: rpcId }), method, ...(params ? { params } : {}) }) }, notification);
        if (notification) return {};
        if (response.jsonrpc !== '2.0' || response.id !== rpcId || Object.hasOwn(response, 'error')) fail('目录协议响应不匹配');
        return object(response.result);
      };
      const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'otto-recruitment-authorization', version: '1.0.0' } });
      if (!['2025-06-18', '2025-03-26'].includes(String(initialized.protocolVersion)) || !Object.hasOwn(object(initialized.capabilities), 'tools')) fail('目录协议尚未验收');
      version = String(initialized.protocolVersion);
      await rpc('notifications/initialized', undefined, true);
      const tools: Array<Record<string, unknown>> = []; const cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const page = await rpc('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(page.tools)) fail('工具目录无效');
        tools.push(...(page.tools as unknown[]).map(object));
        if (tools.length > 500) fail('工具数量超限');
        cursor = page.nextCursor as string | undefined;
        if (cursor !== undefined) { if (typeof cursor !== 'string' || !cursor || cursor.length > 2000 || cursors.has(cursor) || cursors.size >= 10) fail('工具分页未推进'); cursors.add(cursor); }
      } while (cursor !== undefined);
      const call = async (name: 'get_accounts' | 'get_jobs', args: Record<string, unknown>) => {
        const descriptors = tools.filter((tool) => tool.name === name);
        if (descriptors.length !== 1) fail('缺少官方账号或岗位工具');
        const schema = object(descriptors[0].inputSchema); const properties = object(schema.properties ?? {});
        if (schema.type !== 'object' || !Array.isArray(schema.required ?? []) || !(schema.required as unknown[] ?? []).every((key) => typeof key === 'string' && Object.hasOwn(args, key))) fail('目录工具必填字段尚未适配');
        for (const [key, value] of Object.entries(args)) {
          const property = object(properties[key]);
          if (!(typeof value === 'number' ? ['number', 'integer'].includes(String(property.type)) : property.type === 'string')) fail('目录工具参数类型变化');
        }
        const raw = await rpc('tools/call', { name, arguments: args });
        if (raw.isError) fail('读取目录失败，请检查本人平台权限');
        if (raw.structuredContent !== undefined) return object(raw.structuredContent);
        if (!Array.isArray(raw.content) || raw.content.length !== 1) fail('目录返回格式尚未适配');
        const part = object((raw.content as unknown[])[0]);
        if (part.type !== 'text' || typeof part.text !== 'string') fail('目录返回格式尚未适配');
        try { const data: unknown = JSON.parse(part.text as string); return Array.isArray(data) ? { [name === 'get_accounts' ? 'accounts' : 'jobs']: data } : object(data); }
        catch { return fail('目录返回格式尚未适配'); }
      };
      const accounts = await call('get_accounts', {});
      if (!Array.isArray(accounts.accounts) || accounts.accounts.length > 10 || accounts.paging || accounts.next) fail('账号目录超限或包含未适配分页');
      const targets: WorkableVerifiedTarget[] = []; const seenAccounts = new Set<string>();
      for (const entry of accounts.accounts as unknown[]) {
        const account = id(object(entry).subdomain);
        if (seenAccounts.has(account)) fail('账号目录重复'); seenAccounts.add(account);
        const schema = object(tools.find((tool) => tool.name === 'get_jobs')!.inputSchema); const props = object(schema.properties ?? {});
        // Initial directory intentionally covers published jobs only. Never follow provider URLs.
        const args = { account, ...(props.state ? { state: 'published' } : {}), ...(props.limit ? { limit: 100 } : {}) };
        const jobs = await call('get_jobs', args);
        if (!Array.isArray(jobs.jobs) || jobs.jobs.length >= 100 || jobs.next || (jobs.paging && object(jobs.paging).next)) fail('岗位目录需要分页，请缩小平台范围后重新验收');
        for (const raw of jobs.jobs as unknown[]) {
          const job = object(raw); const shortcode = id(job.shortcode);
          if (typeof job.title !== 'string' || !job.title.trim() || job.title.length > 500 || (job.state !== undefined && job.state !== 'published')) fail('已发布岗位目录无效');
          if (targets.some((item) => item.account === account && item.shortcode === shortcode)) fail('岗位目录重复');
          targets.push({ account, shortcode, label: job.title as string });
          if (targets.length > 100) fail('可绑定岗位数量超过本轮上限');
        }
      }
      if (!targets.length) fail('本人账号下没有可读取的已发布岗位');
      await check();
      return { accessToken: token.access_token as string, expiresAt, targets };
    },
  };
}
