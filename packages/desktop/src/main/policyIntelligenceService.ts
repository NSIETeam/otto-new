/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Policy intelligence deliberately lives in the desktop product boundary. The
 * runtime kernel must not know about government sites or enterprise profiles.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type PolicyAssessmentStatus =
  | 'likely_eligible'
  | 'has_gaps'
  | 'unlikely'
  | 'unknown';

export interface PolicyEnterpriseProfile {
  organizationName?: string;
  registeredRegion?: string;
  industry?: string;
  establishedAt?: string;
  employeeCount?: number;
  annualRevenueCny?: number;
  rdExpenseCny?: number;
  qualifications?: string[];
  productsServices?: string[];
  capabilities?: string[];
  notes?: string;
}

export interface OfficialPolicyDocument {
  id: string;
  title: string;
  url: string;
  sourceName: string;
  issuer?: string;
  publishedAt?: string;
  deadline?: string;
  fetchedAt: string;
  contentHash: string;
  bodyText: string;
}

export interface PolicyConditionAssessment {
  label: string;
  result: 'met' | 'gap' | 'unknown';
  evidence: string;
}

export interface PolicyAssessment {
  policyId: string;
  status: PolicyAssessmentStatus;
  score: number;
  summary: string;
  conditions: PolicyConditionAssessment[];
  gaps: string[];
  missingFields: string[];
  resourceConnections: string[];
  assessedAt: string;
  profileFingerprint: string;
  policyContentHash: string;
  modelProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
  analysisError?: string;
}

export interface PolicyIntelligenceState {
  enabled: boolean;
  profile: PolicyEnterpriseProfile;
  policies: OfficialPolicyDocument[];
  assessments: PolicyAssessment[];
  syncStatus: 'idle' | 'syncing' | 'error';
  lastSyncAt?: string;
  lastSyncReason?: 'startup' | 'shutdown' | 'manual' | 'profile_update';
  lastError?: string;
}

interface PersistedPolicyIntelligenceData {
  version: 1;
  scopes: Record<string, PolicyIntelligenceState>;
}

export interface PolicyIntelligenceStore {
  load(): Promise<PersistedPolicyIntelligenceData>;
  save(value: PersistedPolicyIntelligenceData): Promise<void>;
}

export interface PolicySource {
  id: string;
  name: string;
  listUrl: string;
  allowedHosts: string[];
}

export interface PolicyAnalysisDraft {
  status: PolicyAssessmentStatus;
  score: number;
  summary: string;
  conditions: PolicyConditionAssessment[];
  gaps: string[];
  missingFields: string[];
  resourceConnections: string[];
  modelProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type PolicyAnalyze = (
  document: OfficialPolicyDocument,
  profile: PolicyEnterpriseProfile,
  signal?: AbortSignal,
) => Promise<PolicyAnalysisDraft>;

export const OFFICIAL_POLICY_SOURCES: readonly PolicySource[] = [
  {
    id: 'state-council-policy-library',
    name: '国务院政策文件库',
    listUrl: 'https://www.gov.cn/zhengce/zhengceku/',
    allowedHosts: ['www.gov.cn'],
  },
  {
    id: 'beijing-science-application-calendar',
    name: '北京市科委申报日历',
    listUrl: 'https://kw.beijing.gov.cn/zwgk/zwgksbrl/',
    allowedHosts: ['kw.beijing.gov.cn'],
  },
  {
    id: 'beijing-industry-service-notices',
    name: '北京市经济和信息化局办事通知',
    listUrl: 'https://jxj.beijing.gov.cn/bsfw/bstz/',
    allowedHosts: ['jxj.beijing.gov.cn'],
  },
] as const;

const EMPTY_STATE: PolicyIntelligenceState = {
  enabled: false,
  profile: {},
  policies: [],
  assessments: [],
  syncStatus: 'idle',
};
const POLICY_WORDS = /(?:申报|申报通知|项目征集|资金|补贴|补助|奖励|支持项目|资格认定|税收优惠)/u;
const MAX_LIST_BYTES = 1_500_000;
const MAX_DOCUMENT_BYTES = 2_500_000;
const MAX_DOCUMENT_TEXT = 30_000;
const MAX_DOCUMENTS_PER_SOURCE = 8;
const MAX_ANALYSES_PER_SYNC = 12;
const POLICY_REQUEST_TIMEOUT_MS = 8_000;

function cloneState(state: PolicyIntelligenceState): PolicyIntelligenceState {
  return structuredClone(state);
}

function emptyData(): PersistedPolicyIntelligenceData {
  return { version: 1, scopes: {} };
}

export class InMemoryPolicyIntelligenceStore implements PolicyIntelligenceStore {
  private data: PersistedPolicyIntelligenceData = emptyData();

  async load(): Promise<PersistedPolicyIntelligenceData> {
    return structuredClone(this.data);
  }

  async save(value: PersistedPolicyIntelligenceData): Promise<void> {
    this.data = structuredClone(value);
  }
}

export class FilePolicyIntelligenceStore implements PolicyIntelligenceStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedPolicyIntelligenceData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedPolicyIntelligenceData>;
      if (parsed.version !== 1 || !parsed.scopes || typeof parsed.scopes !== 'object') return emptyData();
      return parsed as PersistedPolicyIntelligenceData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyData();
      throw error;
    }
  }

  async save(value: PersistedPolicyIntelligenceData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function stripHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/[\t\r ]+/gu, ' ')
    .replace(/\n\s+/gu, '\n')
    .replace(/\s*\n\s*/gu, '\n')
    .trim();
}

function isAllowedOfficialUrl(url: URL, allowedHosts: readonly string[]): boolean {
  return url.protocol === 'https:' && allowedHosts.includes(url.hostname.toLowerCase())
    && !url.username && !url.password && !url.port;
}

export function extractOfficialPolicyLinks(
  html: string,
  baseUrl: string,
  allowedHosts: readonly string[],
): Array<{ url: string; title: string }> {
  const seen = new Set<string>();
  const result: Array<{ url: string; title: string }> = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(anchor)) {
    const title = stripHtml(match[2] ?? '').replace(/\s+/gu, ' ').trim();
    if (!title || !POLICY_WORDS.test(title)) continue;
    let url: URL;
    try { url = new URL(decodeHtml(match[1] ?? ''), baseUrl); } catch { continue; }
    url.hash = '';
    if (!isAllowedOfficialUrl(url, allowedHosts) || seen.has(url.href)) continue;
    seen.add(url.href);
    result.push({ url: url.href, title: title.slice(0, 240) });
  }
  return result;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function profileFingerprint(profile: PolicyEnterpriseProfile): string {
  const normalized = Object.fromEntries(Object.entries(profile)
    .filter(([, value]) => value !== undefined && value !== '' && value !== null)
    .sort(([left], [right]) => left.localeCompare(right)));
  return hashText(JSON.stringify(normalized));
}

function firstDate(text: string, prefix?: RegExp): string | undefined {
  const source = prefix ? text.match(prefix)?.[0] ?? '' : text;
  const match = source.match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?/u);
  if (!match) return undefined;
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
}

function lastDate(text: string): string | undefined {
  const matches = [...text.matchAll(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?/gu)];
  const match = matches.at(-1);
  if (!match) return undefined;
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
}

function parseDocument(
  html: string,
  candidate: { url: string; title: string },
  source: PolicySource,
  now: () => Date,
): OfficialPolicyDocument {
  const text = stripHtml(html).slice(0, MAX_DOCUMENT_TEXT);
  const heading = stripHtml(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu)?.[1] ?? '').trim();
  const title = (heading || candidate.title).slice(0, 240);
  const canonical = `${title}\n${text}`;
  const publishedContext = text.match(/(?:发布日期|发布时间|成文日期|日期)[：:\s]*20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}日?/u)?.[0];
  const deadlineContext = text.match(/(?:截止|申报期|受理时间)[^。；\n]{0,220}/u)?.[0];
  const issuer = text.match(/(?:制发单位|发布机构|来源)[：:\s]*([^\n。；]{2,100})/u)?.[1]?.trim();
  return {
    id: hashText(candidate.url).slice(0, 24),
    title,
    url: candidate.url,
    sourceName: source.name,
    ...(issuer ? { issuer } : {}),
    publishedAt: firstDate(publishedContext ?? ''),
    deadline: lastDate(deadlineContext ?? ''),
    fetchedAt: now().toISOString(),
    contentHash: hashText(canonical),
    bodyText: text,
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`官方政策源返回 HTTP ${response.status}`);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw new Error('官方政策源返回了不支持的内容类型');
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('官方政策页面超过大小限制');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('官方政策页面超过大小限制');
  return new TextDecoder('utf-8').decode(bytes);
}

async function fetchOfficialText(
  fetchImpl: typeof fetch,
  url: URL,
  maxBytes: number,
  parentSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('官方政策源请求超时')), POLICY_REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await readBoundedResponse(await fetchImpl(url, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'text/html, text/plain;q=0.8', 'User-Agent': 'Otto-Policy-Intelligence/1.0' },
    }), maxBytes);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

function missingCoreProfile(profile: PolicyEnterpriseProfile): string[] {
  const missing: string[] = [];
  if (!profile.registeredRegion?.trim()) missing.push('registeredRegion');
  if (!profile.industry?.trim()) missing.push('industry');
  return missing;
}

function assessmentFromDraft(
  document: OfficialPolicyDocument,
  profileHash: string,
  draft: PolicyAnalysisDraft,
  now: () => Date,
): PolicyAssessment {
  return {
    policyId: document.id,
    status: draft.status,
    score: Math.max(0, Math.min(100, Math.round(draft.score))),
    summary: draft.summary.slice(0, 1_000),
    conditions: draft.conditions.slice(0, 30),
    gaps: draft.gaps.slice(0, 30),
    missingFields: draft.missingFields.slice(0, 30),
    resourceConnections: draft.resourceConnections.slice(0, 20),
    assessedAt: now().toISOString(),
    profileFingerprint: profileHash,
    policyContentHash: document.contentHash,
    ...(draft.modelProvider ? { modelProvider: draft.modelProvider } : {}),
    ...(draft.inputTokens !== undefined ? { inputTokens: draft.inputTokens } : {}),
    ...(draft.outputTokens !== undefined ? { outputTokens: draft.outputTokens } : {}),
  };
}

export class PolicyIntelligenceService {
  private readonly inFlight = new Map<string, Promise<PolicyIntelligenceState>>();

  constructor(private readonly options: {
    store: PolicyIntelligenceStore;
    analyze: PolicyAnalyze;
    fetchImpl?: typeof fetch;
    sources?: readonly PolicySource[];
    now?: () => Date;
  }) {}

  private get fetchImpl(): typeof fetch { return this.options.fetchImpl ?? fetch; }
  private get sources(): readonly PolicySource[] { return this.options.sources ?? OFFICIAL_POLICY_SOURCES; }
  private get now(): () => Date { return this.options.now ?? (() => new Date()); }

  async getState(scopeId: string): Promise<PolicyIntelligenceState> {
    const data = await this.options.store.load();
    return cloneState(data.scopes[scopeId] ?? EMPTY_STATE);
  }

  async configure(input: {
    scopeId: string;
    enabled: boolean;
    profile?: PolicyEnterpriseProfile;
  }): Promise<PolicyIntelligenceState> {
    if (!input.scopeId.trim()) throw new Error('政策智能服务作用域不能为空');
    const data = await this.options.store.load();
    const previous = data.scopes[input.scopeId] ?? cloneState(EMPTY_STATE);
    const next: PolicyIntelligenceState = {
      ...previous,
      enabled: input.enabled,
      profile: { ...previous.profile, ...(input.profile ?? {}) },
      syncStatus: previous.syncStatus === 'syncing' ? 'idle' : previous.syncStatus,
    };
    data.scopes[input.scopeId] = next;
    await this.options.store.save(data);
    return cloneState(next);
  }

  async updateProfile(scopeId: string, patch: PolicyEnterpriseProfile): Promise<PolicyIntelligenceState> {
    const current = await this.getState(scopeId);
    return this.configure({ scopeId, enabled: current.enabled, profile: patch });
  }

  async sync(
    scopeId: string,
    reason: 'startup' | 'shutdown' | 'manual' | 'profile_update',
    signal?: AbortSignal,
  ): Promise<PolicyIntelligenceState> {
    const current = this.inFlight.get(scopeId);
    if (current) return current;
    const operation = this.performSync(scopeId, reason, signal).finally(() => this.inFlight.delete(scopeId));
    this.inFlight.set(scopeId, operation);
    return operation;
  }

  private async performSync(
    scopeId: string,
    reason: 'startup' | 'shutdown' | 'manual' | 'profile_update',
    signal?: AbortSignal,
  ): Promise<PolicyIntelligenceState> {
    const data = await this.options.store.load();
    const initial = data.scopes[scopeId] ?? cloneState(EMPTY_STATE);
    if (!initial.enabled) return cloneState(initial);
    initial.syncStatus = 'syncing';
    delete initial.lastError;
    data.scopes[scopeId] = initial;
    await this.options.store.save(data);
    try {
      const documents = new Map(initial.policies.map((document) => [document.url, document]));
      const sourceErrors: string[] = [];
      let successfulSources = 0;
      for (const source of this.sources) {
        try {
          if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
          const listUrl = new URL(source.listUrl);
          if (!isAllowedOfficialUrl(listUrl, source.allowedHosts)) throw new Error('未通过白名单校验');
          const listHtml = await fetchOfficialText(this.fetchImpl, listUrl, MAX_LIST_BYTES, signal);
          const candidates = extractOfficialPolicyLinks(listHtml, source.listUrl, source.allowedHosts)
            .slice(0, MAX_DOCUMENTS_PER_SOURCE);
          for (const candidate of candidates) {
            if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
            const detailUrl = new URL(candidate.url);
            if (!isAllowedOfficialUrl(detailUrl, source.allowedHosts)) continue;
            const html = await fetchOfficialText(this.fetchImpl, detailUrl, MAX_DOCUMENT_BYTES, signal);
            const document = parseDocument(html, candidate, source, this.now);
            const previous = documents.get(document.url);
            documents.set(document.url, previous?.contentHash === document.contentHash
              ? { ...previous, fetchedAt: document.fetchedAt }
              : document);
          }
          successfulSources += 1;
        } catch (error) {
          if (signal?.aborted) throw error;
          sourceErrors.push(`${source.name}：${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
        }
      }
      if (this.sources.length > 0 && successfulSources === 0) {
        throw new Error(sourceErrors.join('；') || '所有官方政策源均同步失败');
      }

      const policies = [...documents.values()]
        .sort((left, right) => (right.publishedAt ?? right.fetchedAt).localeCompare(left.publishedAt ?? left.fetchedAt))
        .slice(0, 120);
      const profileHash = profileFingerprint(initial.profile);
      const oldAssessments = new Map(initial.assessments.map((item) => [item.policyId, item]));
      const assessments: PolicyAssessment[] = [];
      const missing = missingCoreProfile(initial.profile);
      let analysisCount = 0;
      for (const document of policies) {
        const cached = oldAssessments.get(document.id);
        if (cached?.profileFingerprint === profileHash && cached.policyContentHash === document.contentHash) {
          assessments.push(cached);
          continue;
        }
        if (missing.length > 0) {
          assessments.push({
            policyId: document.id, status: 'unknown', score: 0,
            summary: '企业关键资料不足，尚不能判断是否符合申报条件。',
            conditions: [], gaps: [], missingFields: missing, resourceConnections: [],
            assessedAt: this.now().toISOString(), profileFingerprint: profileHash,
            policyContentHash: document.contentHash,
          });
          continue;
        }
        if (reason === 'shutdown') {
          assessments.push(cached ?? {
            policyId: document.id, status: 'unknown', score: 0,
            summary: '退出前已发现此政策，将在下次启动后完成模型分析。',
            conditions: [], gaps: [], missingFields: [], resourceConnections: [],
            assessedAt: this.now().toISOString(), profileFingerprint: `${profileHash}:shutdown-pending`,
            policyContentHash: document.contentHash,
          });
          continue;
        }
        if (analysisCount >= MAX_ANALYSES_PER_SYNC) {
          assessments.push({
            policyId: document.id, status: 'unknown', score: 0,
            summary: '本轮后台分析已达到限额，将在后续同步中继续评估，避免突发 Token 消耗。',
            conditions: [], gaps: [], missingFields: [], resourceConnections: [],
            assessedAt: this.now().toISOString(), profileFingerprint: `${profileHash}:analysis-pending`,
            policyContentHash: document.contentHash,
          });
          continue;
        }
        try {
          analysisCount += 1;
          assessments.push(assessmentFromDraft(
            document, profileHash, await this.options.analyze(document, initial.profile, signal), this.now,
          ));
        } catch (error) {
          assessments.push({
            policyId: document.id, status: 'unknown', score: 0,
            summary: '政策已更新，但模型分析暂时不可用，请稍后重试。',
            conditions: [], gaps: [], missingFields: [], resourceConnections: [],
            assessedAt: this.now().toISOString(), profileFingerprint: `${profileHash}:analysis-error`,
            policyContentHash: document.contentHash,
            analysisError: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          });
        }
      }
      initial.policies = policies;
      initial.assessments = assessments;
      initial.syncStatus = 'idle';
      if (sourceErrors.length > 0) initial.lastError = `部分官方政策源同步失败：${sourceErrors.join('；')}`.slice(0, 500);
      initial.lastSyncAt = this.now().toISOString();
      initial.lastSyncReason = reason;
      const latest = await this.options.store.load();
      latest.scopes[scopeId] = initial;
      await this.options.store.save(latest);
      return cloneState(initial);
    } catch (error) {
      initial.syncStatus = 'error';
      initial.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      const latest = await this.options.store.load();
      latest.scopes[scopeId] = initial;
      await this.options.store.save(latest);
      return cloneState(initial);
    }
  }

  async syncEnabledScopes(
    reason: 'startup' | 'shutdown',
    timeoutMs: number,
  ): Promise<void> {
    const data = await this.options.store.load();
    const scopes = Object.entries(data.scopes).filter(([, state]) => state.enabled).map(([scopeId]) => scopeId);
    if (!scopes.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      await Promise.allSettled(scopes.map((scopeId) => this.sync(scopeId, reason, controller.signal)));
    } finally {
      clearTimeout(timer);
    }
  }

  async syncEnabledScopesForShutdown(timeoutMs = 4_000): Promise<void> {
    await this.syncEnabledScopes('shutdown', timeoutMs);
  }
}
