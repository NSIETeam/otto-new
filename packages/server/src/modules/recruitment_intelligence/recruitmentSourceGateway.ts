/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash, randomUUID } from 'node:crypto';
import type { RecruitmentCandidateMaterial } from './recruitmentSourceMaterial.js';

export const RECRUITMENT_REQUIRED_SOURCE_CAPABILITIES = [
  'search_candidates',
  'get_candidate',
] as const;

export type RecruitmentSourceCapability =
  | (typeof RECRUITMENT_REQUIRED_SOURCE_CAPABILITIES)[number]
  | 'sync_candidates'
  | 'draft_outreach'
  | 'send_outreach'
  | 'publish_job'
  | 'schedule_interview';

export interface RecruitmentCandidateEvidenceInput {
  field: string;
  value: string;
  observedAt?: string;
}

export interface RecruitmentCandidateHit {
  sourceRecordId: string;
  displayName: string;
  headline?: string;
  location?: string;
  profileUrl?: string;
  /** Only privacy-safe `sha256:<64 lowercase hex>` values are accepted. */
  identityKeys?: string[];
  evidence?: RecruitmentCandidateEvidenceInput[];
}

export interface RecruitmentSourceSearchResult {
  candidates: RecruitmentCandidateHit[];
  nextCursor?: string;
  /** Reviewed adapter-owned explanation of the actual query scope, not upstream text. */
  notice?: string;
}

/** Only reviewed adapter-authored messages may cross the gateway; never wrap raw upstream errors. */
export class RecruitmentSourceUserError extends Error {}

export interface RecruitmentSourceSearchInput {
  organizationId: string;
  actorAccountId: string;
  requisitionId: string;
  query: string;
  cursor?: string;
  limit: number;
}

export interface RecruitmentSourceAdapter {
  id: string;
  label: string;
  capabilities: readonly RecruitmentSourceCapability[];
  getCandidate?(input: {
    organizationId: string;
    actorAccountId: string;
    requisitionId: string;
    sourceRecordId: string;
  }, context: { signal: AbortSignal }): Promise<RecruitmentCandidateMaterial>;
  search(
    input: RecruitmentSourceSearchInput,
    context: { signal: AbortSignal },
  ): Promise<RecruitmentSourceSearchResult>;
}

export interface RecruitmentSourceAuthorization {
  allowed: boolean;
  reason?: string;
}

export interface RecruitmentGatewaySearchRequest {
  organizationId: string;
  actorAccountId: string;
  requisitionId: string;
  query: string;
  sourceIds?: string[];
  cursors?: Record<string, string>;
  limitPerSource?: number;
  signal?: AbortSignal;
}

export type RecruitmentSourceSearchStatus =
  | 'ok'
  | 'unauthorized'
  | 'unsupported'
  | 'timeout'
  | 'error';

export interface RecruitmentSourceStatus {
  sourceId: string;
  label: string;
  status: RecruitmentSourceSearchStatus;
  count: number;
  durationMs: number;
  nextCursor?: string;
  message?: string;
}

export interface RecruitmentCandidateSourceReference {
  sourceId: string;
  sourceLabel: string;
  sourceRecordId: string;
  profileUrl?: string;
}

export interface RecruitmentCandidateFieldEvidence {
  value: string;
  sourceId: string;
  sourceRecordId: string;
  observedAt?: string;
}

export interface RecruitmentCandidateView {
  canonicalId: string;
  displayName: string;
  headline?: string;
  location?: string;
  identityKeys: string[];
  sourceCount: number;
  sources: RecruitmentCandidateSourceReference[];
  fieldEvidence: Record<string, RecruitmentCandidateFieldEvidence[]>;
}

export interface RecruitmentGatewaySearchResult {
  runId: string;
  candidates: RecruitmentCandidateView[];
  sources: RecruitmentSourceStatus[];
}

export interface RecruitmentSearchRunRecord extends RecruitmentGatewaySearchResult {
  organizationId: string;
  actorAccountId: string;
  requisitionId: string;
  query: string;
  createdAt: string;
}

export interface RecruitmentGatewayPersistence {
  saveSearchRun(run: RecruitmentSearchRunRecord): Promise<void>;
  getCursor(
    organizationId: string,
    sourceId: string,
  ): Promise<{ cursor: string } | null>;
  setCursor(cursor: {
    organizationId: string;
    sourceId: string;
    cursor: string;
    updatedAt: string;
  }): Promise<void>;
}

export interface RecruitmentSearchAuditEvent {
  organizationId: string;
  actorAccountId: string;
  action: 'recruitment.sources.searched';
  runId: string;
  requisitionId: string;
  sourceCounts: Record<string, number>;
  sourceStatuses: Record<string, RecruitmentSourceSearchStatus>;
  occurredAt: string;
}

export class RecruitmentGatewayCancelledError extends Error {
  constructor() {
    super('recruitment source search was cancelled');
    this.name = 'RecruitmentGatewayCancelledError';
  }
}

class RecruitmentSourceTimeoutError extends Error {}

interface NormalizedCandidate {
  sourceId: string;
  sourceLabel: string;
  sourceRecordId: string;
  displayName: string;
  headline?: string;
  location?: string;
  profileUrl?: string;
  identityKeys: string[];
  evidence: RecruitmentCandidateEvidenceInput[];
}

interface SourceRunResult {
  status: RecruitmentSourceStatus;
  candidates: NormalizedCandidate[];
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const IDENTITY_HASH = /^sha256:[a-f0-9]{64}$/u;

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function safeProfileUrl(value: unknown): string | undefined {
  const normalized = boundedText(value, 2_000);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeHit(
  adapter: RecruitmentSourceAdapter,
  hit: RecruitmentCandidateHit,
): NormalizedCandidate | null {
  const sourceRecordId = boundedText(hit.sourceRecordId, 500);
  const displayName = boundedText(hit.displayName, 200);
  if (!sourceRecordId || !displayName) return null;
  const evidence = (Array.isArray(hit.evidence) ? hit.evidence : [])
    .slice(0, 100)
    .flatMap((item) => {
      const field = boundedText(item?.field, 100);
      const value = boundedText(item?.value, 4_000);
      if (!field || !value) return [];
      const observedAt = boundedText(item.observedAt, 80);
      return [{ field, value, ...(observedAt ? { observedAt } : {}) }];
    });
  return {
    sourceId: adapter.id,
    sourceLabel: adapter.label,
    sourceRecordId,
    displayName,
    headline: boundedText(hit.headline, 500),
    location: boundedText(hit.location, 500),
    profileUrl: safeProfileUrl(hit.profileUrl),
    identityKeys: [
      ...new Set(
        (Array.isArray(hit.identityKeys) ? hit.identityKeys : []).filter(
          (key): key is string =>
            typeof key === 'string' && IDENTITY_HASH.test(key),
        ),
      ),
    ].sort(),
    evidence,
  };
}

function hasRequiredCapabilities(adapter: RecruitmentSourceAdapter): boolean {
  const capabilities = new Set(adapter.capabilities);
  return RECRUITMENT_REQUIRED_SOURCE_CAPABILITIES.every((capability) =>
    capabilities.has(capability),
  );
}

function linkAbortSignal(parent?: AbortSignal): {
  controller: AbortController;
  detach: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    controller,
    detach: () => parent?.removeEventListener('abort', abort),
  };
}

async function withSourceTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new RecruitmentSourceTimeoutError('来源响应超时');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function addEvidence(
  target: Record<string, RecruitmentCandidateFieldEvidence[]>,
  field: string,
  entry: RecruitmentCandidateFieldEvidence,
): void {
  const entries = (target[field] ??= []);
  if (
    !entries.some(
      (existing) =>
        existing.value === entry.value &&
        existing.sourceId === entry.sourceId &&
        existing.sourceRecordId === entry.sourceRecordId,
    )
  ) {
    entries.push(entry);
  }
}

function mergeCandidates(
  organizationId: string,
  candidates: NormalizedCandidate[],
): RecruitmentCandidateView[] {
  const parent = candidates.map((_candidate, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const identityOwner = new Map<string, number>();
  const sourceRecordOwner = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    const sourceRecordKey = `${candidate.sourceId}\0${candidate.sourceRecordId}`;
    const duplicateRecord = sourceRecordOwner.get(sourceRecordKey);
    if (duplicateRecord === undefined) sourceRecordOwner.set(sourceRecordKey, index);
    else union(duplicateRecord, index);
    for (const key of candidate.identityKeys) {
      const previous = identityOwner.get(key);
      if (previous === undefined) identityOwner.set(key, index);
      else union(previous, index);
    }
  });
  const groups = new Map<number, NormalizedCandidate[]>();
  candidates.forEach((candidate, index) => {
    const group = groups.get(find(index)) ?? [];
    group.push(candidate);
    groups.set(find(index), group);
  });
  return [...groups.values()].map((group) => {
    const identityKeys = [...new Set(group.flatMap((item) => item.identityKeys))].sort();
    const seed = identityKeys.length
      ? identityKeys.join('\0')
      : group.map((item) => `${item.sourceId}\0${item.sourceRecordId}`).join('\0');
    const canonicalId = createHash('sha256')
      .update(`${organizationId}\0${seed}`, 'utf8')
      .digest('hex');
    const fieldEvidence: Record<string, RecruitmentCandidateFieldEvidence[]> = {};
    for (const item of group) {
      const base = {
        sourceId: item.sourceId,
        sourceRecordId: item.sourceRecordId,
      };
      addEvidence(fieldEvidence, 'displayName', {
        ...base,
        value: item.displayName,
      });
      if (item.headline)
        addEvidence(fieldEvidence, 'headline', {
          ...base,
          value: item.headline,
        });
      if (item.location)
        addEvidence(fieldEvidence, 'location', {
          ...base,
          value: item.location,
        });
      for (const evidence of item.evidence) {
        addEvidence(fieldEvidence, evidence.field, {
          ...base,
          value: evidence.value,
          ...(evidence.observedAt ? { observedAt: evidence.observedAt } : {}),
        });
      }
    }
    return {
      canonicalId,
      displayName: group[0]!.displayName,
      headline: group.find((item) => item.headline)?.headline,
      location: group.find((item) => item.location)?.location,
      identityKeys,
      sourceCount: new Set(group.map((item) => item.sourceId)).size,
      sources: [...new Map(group.map((item) => [
        `${item.sourceId}\0${item.sourceRecordId}`,
        {
          sourceId: item.sourceId,
          sourceLabel: item.sourceLabel,
          sourceRecordId: item.sourceRecordId,
          ...(item.profileUrl ? { profileUrl: item.profileUrl } : {}),
        },
      ])).values()],
      fieldEvidence,
    };
  });
}

export function createRecruitmentSourceGateway(options: {
  adapters: readonly RecruitmentSourceAdapter[];
  authorizeSource(input: {
    organizationId: string;
    actorAccountId: string;
    sourceId: string;
    requisitionId?: string;
  }): Promise<RecruitmentSourceAuthorization>;
  audit?(event: RecruitmentSearchAuditEvent): Promise<void>;
  persistence?: RecruitmentGatewayPersistence;
  now?: () => Date;
  nowMs?: () => number;
  createId?: () => string;
  sourceTimeoutMs?: number;
}) {
  const seen = new Set<string>();
  const adapters = options.adapters.map((adapter) => {
    requiredIdentifier(adapter.id, 'source id');
    if (seen.has(adapter.id)) throw new Error('recruitment source id is duplicated');
    seen.add(adapter.id);
    return adapter;
  });
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const timeoutMs = Math.max(100, Math.min(options.sourceTimeoutMs ?? 15_000, 60_000));
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs ?? Date.now;
  const createId = options.createId ?? randomUUID;

  async function runSource(
    adapter: RecruitmentSourceAdapter,
    request: RecruitmentGatewaySearchRequest,
  ): Promise<SourceRunResult> {
    const startedAt = nowMs();
    const durationMs = (): number => Math.max(0, Math.round(nowMs() - startedAt));
    if (!hasRequiredCapabilities(adapter)) {
      return {
        status: {
          sourceId: adapter.id,
          label: adapter.label,
          status: 'unsupported',
          count: 0,
          durationMs: durationMs(),
          message: '来源缺少候选人搜索和详情读取能力',
        },
        candidates: [],
      };
    }
    let authorization: RecruitmentSourceAuthorization;
    try {
      authorization = await options.authorizeSource({
        organizationId: request.organizationId,
        actorAccountId: request.actorAccountId,
        sourceId: adapter.id,
        requisitionId: request.requisitionId,
      });
    } catch (_error) {
      return {
        status: {
          sourceId: adapter.id,
          label: adapter.label,
          status: 'error',
          count: 0,
          durationMs: durationMs(),
          message: '来源授权检查失败',
        },
        candidates: [],
      };
    }
    if (!authorization.allowed) {
      return {
        status: {
          sourceId: adapter.id,
          label: adapter.label,
          status: 'unauthorized',
          count: 0,
          durationMs: durationMs(),
          message: authorization.reason ?? '企业尚未授权该来源',
        },
        candidates: [],
      };
    }
    if (request.signal?.aborted) throw new RecruitmentGatewayCancelledError();
    const linked = linkAbortSignal(request.signal);
    try {
      const storedCursor = request.cursors?.[adapter.id] === undefined
        ? await options.persistence?.getCursor(request.organizationId, adapter.id)
        : null;
      const result = await withSourceTimeout(
        adapter.search(
          {
            organizationId: request.organizationId,
            actorAccountId: request.actorAccountId,
            requisitionId: request.requisitionId,
            query: request.query,
            cursor: request.cursors?.[adapter.id] ?? storedCursor?.cursor,
            limit: Math.max(1, Math.min(request.limitPerSource ?? 50, 200)),
          },
          { signal: linked.controller.signal },
        ),
        linked.controller,
        timeoutMs,
      );
      if (request.signal?.aborted) throw new RecruitmentGatewayCancelledError();
      const candidates = (Array.isArray(result.candidates) ? result.candidates : [])
        .slice(0, 200)
        .flatMap((hit) => {
          const normalized = normalizeHit(adapter, hit);
          return normalized ? [normalized] : [];
        });
      return {
        status: {
          sourceId: adapter.id,
          label: adapter.label,
          status: 'ok',
          count: candidates.length,
          durationMs: durationMs(),
          ...(boundedText(result.notice, 500) ? { message: result.notice!.trim() } : {}),
          ...(boundedText(result.nextCursor, 2_000)
            ? { nextCursor: result.nextCursor!.trim() }
            : {}),
        },
        candidates,
      };
    } catch (error) {
      if (request.signal?.aborted || error instanceof RecruitmentGatewayCancelledError)
        throw new RecruitmentGatewayCancelledError();
      const timedOut = error instanceof RecruitmentSourceTimeoutError;
      return {
        status: {
          sourceId: adapter.id,
          label: adapter.label,
          status: timedOut ? 'timeout' : 'error',
          count: 0,
          durationMs: durationMs(),
          message: timedOut ? '来源响应超时'
            : error instanceof RecruitmentSourceUserError ? boundedText(error.message, 500) ?? '来源检索失败' : '来源检索失败',
        },
        candidates: [],
      };
    } finally {
      linked.detach();
    }
  }

  return {
    async search(
      rawRequest: RecruitmentGatewaySearchRequest,
    ): Promise<RecruitmentGatewaySearchResult> {
      const request: RecruitmentGatewaySearchRequest = {
        ...rawRequest,
        organizationId: requiredIdentifier(rawRequest.organizationId, 'organization id'),
        actorAccountId: requiredIdentifier(rawRequest.actorAccountId, 'actor account id'),
        requisitionId: requiredIdentifier(rawRequest.requisitionId, 'requisition id'),
        query: rawRequest.query.trim(),
      };
      if (!request.query || request.query.length > 10_000)
        throw new Error('recruitment query is invalid');
      if (request.signal?.aborted) throw new RecruitmentGatewayCancelledError();
      const selectedIds = request.sourceIds?.length
        ? [...new Set(request.sourceIds)]
        : adapters.map((adapter) => adapter.id);
      const selected = selectedIds.map((sourceId) => {
        const adapter = adapterById.get(sourceId);
        if (!adapter) throw new Error(`recruitment source is unknown: ${sourceId}`);
        return adapter;
      });
      const runId = createId();
      const sourceResults = await Promise.all(
        selected.map((adapter) => runSource(adapter, request)),
      );
      if (request.signal?.aborted) throw new RecruitmentGatewayCancelledError();
      const candidates = mergeCandidates(
        request.organizationId,
        sourceResults.flatMap((result) => result.candidates),
      );
      const sourceCounts = Object.fromEntries(
        sourceResults.map((result) => [result.status.sourceId, result.status.count]),
      );
      const sourceStatuses = Object.fromEntries(
        sourceResults.map((result) => [result.status.sourceId, result.status.status]),
      );
      const createdAt = now().toISOString();
      await options.persistence?.saveSearchRun({
        runId,
        organizationId: request.organizationId,
        actorAccountId: request.actorAccountId,
        requisitionId: request.requisitionId,
        query: request.query,
        createdAt,
        candidates,
        sources: sourceResults.map((result) => result.status),
      });
      await Promise.all(
        sourceResults.flatMap((result) =>
          result.status.status === 'ok' && result.status.nextCursor
            ? [
                options.persistence?.setCursor({
                  organizationId: request.organizationId,
                  sourceId: result.status.sourceId,
                  cursor: result.status.nextCursor,
                  updatedAt: createdAt,
                }),
              ].filter((operation): operation is Promise<void> => Boolean(operation))
            : [],
        ),
      );
      await options.audit?.({
        organizationId: request.organizationId,
        actorAccountId: request.actorAccountId,
        action: 'recruitment.sources.searched',
        runId,
        requisitionId: request.requisitionId,
        sourceCounts,
        sourceStatuses,
        occurredAt: createdAt,
      });
      return {
        runId,
        candidates,
        sources: sourceResults.map((result) => result.status),
      };
    },
  };
}
