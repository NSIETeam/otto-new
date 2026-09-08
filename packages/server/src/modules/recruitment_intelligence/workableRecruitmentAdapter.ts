/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { RecruitmentSourceUserError, type RecruitmentCandidateHit, type RecruitmentSourceAdapter } from './recruitmentSourceGateway.js';
import { normalizeRecruitmentMaterial } from './recruitmentSourceMaterial.js';
import type { RecruitmentResumeReader } from './recruitmentResumeReader.js';

export interface WorkableRecruitmentScope {
  organizationId: string;
  actorAccountId: string;
  requisitionId: string;
}

export interface WorkableTool {
  name: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

/** Created by a tenant-scoped OAuth broker, never from renderer-supplied tokens. */
export interface WorkableRecruitmentSession {
  account: string;
  jobShortcode: string;
  bindingRevision: string;
  listTools(): Promise<WorkableTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Re-read authorization and the account/job binding, including after network IO. */
  assertAuthorized(): Promise<void>;
  close(): Promise<void>;
}

class WorkableAdapterError extends RecruitmentSourceUserError {}
const fail = (message: string): never => { throw new WorkableAdapterError(message); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail('Workable 返回格式不受支持，请重新验收连接器');
const id = (value: unknown): string => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(text) ? text : fail('Workable 标识不受支持');
};
const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;

function unwrap(raw: unknown): unknown {
  if (JSON.stringify(raw)?.length > 2_000_000) fail('Workable 返回内容过大');
  if (typeof raw === 'string') {
    try { return unwrap(JSON.parse(raw)); } catch { return fail('Workable 返回格式不受支持'); }
  }
  if (Array.isArray(raw)) return raw;
  const value = object(raw);
  if (value.isError) fail('Workable 工具执行失败，请检查授权和工具契约');
  if (value.structuredContent !== undefined) return unwrap(value.structuredContent);
  if (value.content !== undefined) {
    if (!Array.isArray(value.content) || value.content.length !== 1) fail('Workable 返回格式不受支持');
    const content = object((value.content as unknown[])[0]);
    if (content.type !== 'text' || typeof content.text !== 'string') fail('Workable 返回格式不受支持');
    return unwrap(content.text);
  }
  return value;
}

function list(value: unknown, key: string): unknown[] {
  const items = Array.isArray(value) ? value : object(value)[key];
  if (!Array.isArray(items) || items.length > 500) return fail('Workable 列表格式不受支持');
  return items;
}

function descriptor(tools: WorkableTool[], name: string): WorkableTool {
  const matches = tools.filter((tool) => tool.name === name);
  if (matches.length !== 1 || matches[0].inputSchema?.type !== 'object') return fail('Workable 工具契约不完整或重复');
  const schema = matches[0].inputSchema;
  object(schema.properties);
  if (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === 'string')) return fail('Workable 工具契约不受支持');
  return matches[0];
}

/** Only explicitly reviewed field aliases are supported; unknown required fields fail closed. */
function argumentsFor(tool: WorkableTool, fields: Array<{ aliases: string[]; value: string | number; optional?: boolean }>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const keys = field.aliases.filter((key) => Object.hasOwn(tool.inputSchema.properties, key));
    if (keys.length === 0 && field.optional) continue;
    if (keys.length !== 1) fail('Workable 工具契约字段缺失或存在歧义');
    const key = keys[0];
    const schema = object(tool.inputSchema.properties[key]);
    let value: string | number = field.value;
    if (schema.type === 'integer' || schema.type === 'number') {
      if (typeof value === 'string' && !/^\d+$/u.test(value)) fail('Workable 工具契约要求数字标识');
      value = Number(value);
      if (!Number.isSafeInteger(value) || value < 0) fail('Workable 工具契约数字超出范围');
    } else if (schema.type === 'string') value = String(value);
    else fail('Workable 工具契约类型不受支持');
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail('Workable 工具契约枚举不受支持');
    if (typeof value === 'number' && ((typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) fail('Workable 工具契约数值超出范围');
    args[key] = value;
  }
  if (tool.inputSchema.required.some((key) => !Object.hasOwn(args, key))) fail('Workable 工具契约含未适配的必填字段');
  return args;
}

function encode(key: string, value: string): string {
  return `wk1:${Buffer.from(JSON.stringify([key, value])).toString('base64url')}`;
}

/** A technical preflight only: validates schemas and reads accounts, never candidate data. */
export async function probeWorkableConnection(session: WorkableRecruitmentSession, signal: AbortSignal): Promise<void> {
  const check = async (): Promise<void> => { signal.throwIfAborted(); await session.assertAuthorized(); signal.throwIfAborted(); };
  try {
    await check();
    const tools = await session.listTools();
    await check();
    if (!Array.isArray(tools) || tools.length > 500) fail('Workable 工具契约不受支持');
    const args = argumentsFor(descriptor(tools, 'get_accounts'), []);
    argumentsFor(descriptor(tools, 'get_candidates'), [
      { aliases: ['account'], value: session.account }, { aliases: ['shortcode', 'job_shortcode'], value: session.jobShortcode }, { aliases: ['limit'], value: 1 },
    ]);
    argumentsFor(descriptor(tools, 'get_candidate'), [
      { aliases: ['account'], value: session.account }, { aliases: ['id', 'candidate_id'], value: '1' },
    ]);
    const accounts = list(unwrap(await session.callTool('get_accounts', args)), 'accounts');
    await check();
    if (!accounts.some((account) => object(account).subdomain === session.account)) fail('Workable 当前授权不包含所选账号');
  } finally { try { await session.close(); } catch { /* Do not mask a failed check. */ } }
}
function decode(encoded: string, key: string): string {
  if (!/^wk1:[A-Za-z0-9_-]{1,450}$/u.test(encoded)) return fail('Workable 记录绑定无效，请重新检索');
  try {
    const data: unknown = JSON.parse(Buffer.from(encoded.slice(4), 'base64url').toString('utf8'));
    if (!Array.isArray(data) || data.length !== 2 || data[0] !== key) return fail('Workable 账号或岗位绑定已变化，请重新检索');
    return id(data[1]);
  } catch { return fail('Workable 记录绑定无效，请重新检索'); }
}

function nextPage(value: unknown, session: WorkableRecruitmentSession): string | undefined {
  const paging = object(value).paging;
  if (paging === undefined || paging === null) return undefined;
  const next = object(paging).next;
  if (next === undefined || next === null || next === '') return undefined;
  if (typeof next !== 'string' || next.length > 2_000) return fail('Workable 分页格式不受支持');
  let url: URL;
  try { url = new URL(next); } catch { return fail('Workable 分页格式不受支持'); }
  // Extract a cursor only. Never request an upstream-supplied URL or forward credentials to it.
  if (url.origin !== `https://${session.account}.workable.com` || url.username || url.password || url.hash
    || !/^\/spi\/v[23]\/jobs\/[A-Za-z0-9_-]+\/candidates$/u.test(url.pathname)
    || url.pathname.split('/')[4] !== session.jobShortcode
    || url.searchParams.getAll('since_id').length !== 1
    || [...url.searchParams.keys()].some((key) => !['since_id', 'limit'].includes(key))) return fail('Workable 分页范围不受支持');
  return id(url.searchParams.get('since_id'));
}

/** Read-only, bound-job adapter. It does NOT implement Workable advanced/semantic search. */
export function createWorkableRecruitmentAdapter(options: {
  openSession(scope: WorkableRecruitmentScope, signal: AbortSignal): Promise<WorkableRecruitmentSession>;
  resumeReader?: RecruitmentResumeReader;
}): RecruitmentSourceAdapter {
  async function withSession<T>(scope: WorkableRecruitmentScope, signal: AbortSignal, work: (session: WorkableRecruitmentSession, tools: WorkableTool[], key: string, call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<T>): Promise<T> {
    let session: WorkableRecruitmentSession | undefined;
    const check = async (): Promise<void> => {
      signal.throwIfAborted();
      try { await session!.assertAuthorized(); } catch { fail('Workable 授权失效或岗位绑定已变化，请重新授权'); }
      signal.throwIfAborted();
    };
    try {
      signal.throwIfAborted();
      session = await options.openSession(scope, signal);
      id(session.account); id(session.jobShortcode); id(session.bindingRevision);
      const key = createHash('sha256').update(JSON.stringify([scope.organizationId, scope.actorAccountId, scope.requisitionId, session.account, session.jobShortcode, session.bindingRevision])).digest('hex');
      await check();
      const tools = await session.listTools();
      if (!Array.isArray(tools) || tools.length > 500) fail('Workable 工具契约不受支持');
      for (const name of ['get_accounts', 'get_candidates', 'get_candidate']) descriptor(tools, name);
      const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        if (!['get_accounts', 'get_candidates', 'get_candidate'].includes(name)) fail('Workable 此阶段仅允许读取候选人');
        await check();
        const result = await session!.callTool(name, args);
        await check();
        return unwrap(result);
      };
      const result = await work(session, tools, key, call);
      await check();
      return result;
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof RecruitmentSourceUserError) throw error;
      return fail('Workable 连接未就绪，请检查企业授权、岗位绑定与工具契约');
    } finally { try { await session?.close(); } catch { /* Cleanup must not expose tokens or mask an authorization failure. */ } }
  }
  const chooseAccount = async (session: WorkableRecruitmentSession, tools: WorkableTool[], call: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<void> => {
    const accounts = list(await call('get_accounts', argumentsFor(descriptor(tools, 'get_accounts'), [])), 'accounts');
    if (!accounts.some((account) => object(account).subdomain === session.account)) fail('Workable 当前授权不包含所选账号');
  };
  return {
    id: 'workable', label: 'Workable 企业人才库', capabilities: ['search_candidates', 'get_candidate'],
    async search(input, { signal }) {
      const scope = { organizationId: input.organizationId, actorAccountId: input.actorAccountId, requisitionId: input.requisitionId };
      return withSession(scope, signal, async (session, tools, key, call) => {
        const cursor = input.cursor ? decode(input.cursor, key) : undefined;
        const tool = descriptor(tools, 'get_candidates');
        const limit = Math.max(1, Math.min(input.limit, 200));
        if (!Number.isSafeInteger(limit)) fail('Workable 检索数量无效');
        const args = argumentsFor(tool, [
          { aliases: ['account'], value: session.account },
          { aliases: ['shortcode', 'job_shortcode'], value: session.jobShortcode },
          { aliases: ['limit'], value: limit },
          ...(cursor ? [{ aliases: ['since_id'], value: cursor }] : []),
        ]);
        await chooseAccount(session, tools, call);
        const raw = await call('get_candidates', args);
        const rows = list(raw, 'candidates');
        if (rows.length > limit) fail('Workable 返回数量超出约定，未截断或跳过候选人');
        const candidates = rows.map((row): RecruitmentCandidateHit => {
          const candidate = object(row);
          const displayName = text(candidate.name, 200);
          if (!displayName) return fail('Workable 候选人缺少姓名');
          return { sourceRecordId: encode(key, id(candidate.id)), displayName,
            headline: text(candidate.headline, 500), location: text(candidate.location, 200),
            // No email, phone, signed resume URL or arbitrary profile URL is returned in list metadata.
          };
        });
        const next = nextPage(raw, session);
        if (next) argumentsFor(tool, [
          { aliases: ['account'], value: session.account }, { aliases: ['shortcode', 'job_shortcode'], value: session.jobShortcode },
          { aliases: ['limit'], value: limit }, { aliases: ['since_id'], value: next },
        ]);
        if (next && next === cursor) fail('Workable 分页未推进，请重新检索');
        return { candidates, ...(next ? { nextCursor: encode(key, next) } : {}),
          notice: `仅读取 Workable 已绑定岗位 ${session.jobShortcode} 下的候选人，仅展示当前批次；未按自由文本筛选，不是全站人才搜索。需继续获取材料并分析岗位匹配度。` };
      });
    },
    async getCandidate(input, { signal }) {
      const scope = { organizationId: input.organizationId, actorAccountId: input.actorAccountId, requisitionId: input.requisitionId };
      return withSession(scope, signal, async (session, tools, key, call) => {
        const candidateId = decode(input.sourceRecordId, key);
        await chooseAccount(session, tools, call);
        const raw = object(await call('get_candidate', argumentsFor(descriptor(tools, 'get_candidate'), [
          { aliases: ['account'], value: session.account }, { aliases: ['id', 'candidate_id'], value: candidateId },
        ])));
        const candidate = object(raw.candidate ?? raw);
        if (id(candidate.id) !== candidateId) fail('Workable 返回候选人与检索记录不匹配');
        if (candidate.job !== undefined && candidate.job !== null && object(candidate.job).shortcode !== session.jobShortcode) fail('Workable 候选人已不属于绑定岗位，请重新检索');
        if (options.resumeReader && candidate.resume_url) {
          if (typeof candidate.resume_url !== 'string') fail('Workable 简历链接格式无效，请重新获取');
          await session.assertAuthorized();
          return normalizeRecruitmentMaterial(await options.resumeReader({ url: candidate.resume_url as string, sourceRecordId: input.sourceRecordId, signal, assertAuthorized: () => session.assertAuthorized() }), input.sourceRecordId);
        }
        const parts = [['姓名', candidate.name], ['职业概述', candidate.headline], ['个人摘要', candidate.summary]]
          .flatMap(([label, value]) => { const part = text(value, 25_000); return part ? [`${label}：${part}`] : []; });
        // get_candidate is a structured profile, not proof that the resume file was retrieved.
        // Without a configured reviewed reader (or without a resume URL), remain explicitly partial.
        return normalizeRecruitmentMaterial({ sourceRecordId: input.sourceRecordId, text: parts.join('\n\n'), completeness: 'partial' }, input.sourceRecordId);
      });
    },
  };
}
