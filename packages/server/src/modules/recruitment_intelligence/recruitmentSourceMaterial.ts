/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';
import { RecruitmentGatewayCancelledError, RecruitmentSourceUserError, type RecruitmentCandidateSourceReference } from './recruitmentSourceGateway.js';
import { RECRUITMENT_SEARCH_CACHE_TTL_MS, type RecruitmentSourceStore } from './recruitmentSourceStore.js';
import type { RecruitmentSourceRegistration } from './recruitmentSourceRuntime.js';

/** Text extraction belongs to the reviewed adapter, never an arbitrary URL supplied by the renderer. */
export interface RecruitmentCandidateMaterial {
  sourceRecordId: string;
  fileName?: string;
  text: string;
  completeness: 'full_text' | 'partial' | 'unavailable';
  reason?: string;
  /** Digest of downloaded bytes, not a claim that the original binary is stored. No signed URLs. */
  attachment?: { sha256: string; bytes: number; format: 'pdf' | 'txt'; pages?: number; extractorVersion: 'otto-resume-v1' };
}

export interface RecruitmentMaterialRequest {
  organizationId: string;
  actorAccountId: string;
  runId: string;
  requisitionId: string;
  canonicalId: string;
  sourceId: string;
  signal?: AbortSignal;
}

export interface RecruitmentMaterialResult {
  runId: string;
  requisitionId: string;
  canonicalId: string;
  source: RecruitmentCandidateSourceReference;
  acquisitionMode: 'authorized_api' | 'authorized_mcp';
  material: RecruitmentCandidateMaterial;
  contentHash: string;
  retrievedAt: string;
}

export interface RecruitmentMaterialAuditEvent {
  action: 'recruitment.material.read';
  organizationId: string;
  actorAccountId: string;
  runId: string;
  requisitionId: string;
  sourceId: string;
  contentHash: string;
  completeness: RecruitmentCandidateMaterial['completeness'];
  occurredAt: string;
}

export class RecruitmentMaterialError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function normalizeRecruitmentMaterial(raw: unknown, expectedRecordId: string): RecruitmentCandidateMaterial {
  const invalid = (): never => { throw new RecruitmentMaterialError(502, 'RECRUITMENT_MATERIAL_INVALID', '来源返回的材料不完整、过大或与候选人不匹配，请检查连接器'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (value.sourceRecordId !== expectedRecordId) return invalid();
  // The semantic engine accepts at most 80k characters without truncation.
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 80_000)) return invalid();
  const text = typeof value.text === 'string' ? value.text.replace(/\r\n?/gu, '\n').trim() : '';
  const completeness = !text || value.completeness === 'unavailable' ? 'unavailable'
    : value.completeness === 'full_text' ? 'full_text' : 'partial';
  const fileName = typeof value.fileName === 'string' ? value.fileName.split(/[\\/]/u).at(-1)?.slice(0, 200) : undefined;
  let attachment: RecruitmentCandidateMaterial['attachment'];
  if (value.attachment !== undefined) {
    if (!value.attachment || typeof value.attachment !== 'object' || Array.isArray(value.attachment)) return invalid();
    const entry = value.attachment as Record<string, unknown>;
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0 || (entry.bytes as number) > 8 * 1024 * 1024
      || !['pdf', 'txt'].includes(entry.format as string) || entry.extractorVersion !== 'otto-resume-v1'
      || (entry.format === 'pdf' && (!Number.isSafeInteger(entry.pages) || (entry.pages as number) < 1 || (entry.pages as number) > 40))
      || (entry.format === 'txt' && entry.pages !== undefined)) return invalid();
    attachment = { sha256: entry.sha256, bytes: entry.bytes as number, format: entry.format as 'pdf' | 'txt', ...(entry.pages !== undefined ? { pages: entry.pages as number } : {}), extractorVersion: 'otto-resume-v1' };
  }
  return {
    sourceRecordId: expectedRecordId, text: completeness === 'unavailable' ? '' : text, completeness,
    ...(fileName ? { fileName } : {}),
    ...(attachment ? { attachment } : {}),
    ...(completeness === 'unavailable' ? { reason: '来源没有提供可分析正文，请手动补充简历。' }
      : completeness === 'partial' ? { reason: attachment?.format === 'pdf' ? 'PDF 含图片、缺少可提取文字或存在文本识别不确定性，未进行完整分析，请补充纯文本简历。' : '来源仅提供部分资料，不能据此宣称已完成简历全文分析。' } : {}),
  };
}

export function createRecruitmentMaterialReader(options: {
  store: RecruitmentSourceStore;
  registrations: ReadonlyMap<string, RecruitmentSourceRegistration>;
  authorize(input: { organizationId: string; actorAccountId: string; sourceId: string; requisitionId?: string }): Promise<{ allowed: boolean }>;
  audit?(event: RecruitmentMaterialAuditEvent): Promise<void>;
  timeoutMs?: number;
  now?: () => Date;
}) {
  return async (request: RecruitmentMaterialRequest): Promise<RecruitmentMaterialResult> => {
    const cancelled = (): void => { if (request.signal?.aborted) throw new RecruitmentGatewayCancelledError(); };
    cancelled();
    const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
    if (![request.organizationId, request.actorAccountId, request.runId, request.requisitionId, request.sourceId, request.canonicalId].every((value) => typeof value === 'string' && id.test(value))) {
      throw new RecruitmentMaterialError(400, 'RECRUITMENT_MATERIAL_REQUEST_INVALID', '候选人材料请求不正确');
    }
    const run = await options.store.getSearchRun(request.organizationId, request.runId);
    const candidate = run?.candidates.find((item) => item.canonicalId === request.canonicalId);
    const source = candidate?.sources.find((item) => item.sourceId === request.sourceId);
    if (!run || run.actorAccountId !== request.actorAccountId || run.requisitionId !== request.requisitionId || !source) {
      throw new RecruitmentMaterialError(404, 'RECRUITMENT_MATERIAL_NOT_FOUND', '候选人不在当前账号与岗位的检索记录中，请重新检索');
    }
    const now = options.now ?? (() => new Date());
    if (!Number.isFinite(Date.parse(run.createdAt)) || now().getTime() - Date.parse(run.createdAt) >= RECRUITMENT_SEARCH_CACHE_TTL_MS) {
      throw new RecruitmentMaterialError(409, 'RECRUITMENT_SEARCH_EXPIRED', '检索记录已过期，请重新检索后获取材料');
    }
    const registration = options.registrations.get(source.sourceId);
    const verify = async (): Promise<void> => {
      let allowed = false;
      try { allowed = (await options.authorize(request)).allowed; } catch { /* Fail closed. */ }
      if (!allowed) throw new RecruitmentMaterialError(403, 'RECRUITMENT_SOURCE_UNAUTHORIZED', '该来源授权已失效或当前账号无权读取');
      const current = await options.store.getSearchRun(request.organizationId, request.runId);
      if (!current || current.actorAccountId !== request.actorAccountId || current.requisitionId !== request.requisitionId
        || now().getTime() - Date.parse(run.createdAt) >= RECRUITMENT_SEARCH_CACHE_TTL_MS) {
        throw new RecruitmentMaterialError(409, 'RECRUITMENT_SEARCH_EXPIRED', '检索记录已过期或被清理，请重新检索后获取材料');
      }
      cancelled();
    };
    await verify();
    const getCandidate = registration?.adapter.getCandidate;
    if (!registration || !getCandidate) {
      throw new RecruitmentMaterialError(409, 'RECRUITMENT_MATERIAL_UNSUPPORTED', '该连接器尚未实现材料读取，请手动导入简历');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = (): void => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { controller.abort(); reject(new RecruitmentGatewayCancelledError()); };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new RecruitmentMaterialError(504, 'RECRUITMENT_MATERIAL_TIMEOUT', '候选人材料读取超时，请稍后重试'));
      }, Math.max(100, Math.min(options.timeoutMs ?? 15_000, 60_000)));
    });
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() => {
          cancelled();
          return getCandidate.call(registration.adapter, {
            organizationId: request.organizationId, actorAccountId: request.actorAccountId,
            requisitionId: request.requisitionId, sourceRecordId: source.sourceRecordId,
          }, { signal: controller.signal });
        }), interrupted,
      ]);
      await verify();
      const material = normalizeRecruitmentMaterial(raw, source.sourceRecordId);
      const contentHash = createHash('sha256').update(JSON.stringify([material.completeness, material.text])).digest('hex');
      const retrievedAt = now().toISOString();
      await options.audit?.({
        action: 'recruitment.material.read', organizationId: request.organizationId,
        actorAccountId: request.actorAccountId, runId: run.runId, requisitionId: run.requisitionId,
        sourceId: source.sourceId, contentHash, completeness: material.completeness, occurredAt: retrievedAt,
      });
      await verify();
      return {
        runId: run.runId, requisitionId: run.requisitionId, canonicalId: candidate!.canonicalId,
        source: { ...source }, material, contentHash, retrievedAt,
        acquisitionMode: registration.accessMode === 'authorized_mcp' ? 'authorized_mcp' : 'authorized_api',
      };
    } catch (error) {
      if (error instanceof RecruitmentMaterialError || error instanceof RecruitmentGatewayCancelledError) throw error;
      if (error instanceof RecruitmentSourceUserError) throw new RecruitmentMaterialError(502, 'RECRUITMENT_MATERIAL_FAILED', error.message);
      throw new RecruitmentMaterialError(502, 'RECRUITMENT_MATERIAL_FAILED', '候选人材料读取失败，请检查来源连接后重试');
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  };
}
