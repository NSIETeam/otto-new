/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import type { RecruitmentSourceAdapter } from './recruitmentSourceGateway.js';
import { normalizeRecruitmentMaterial } from './recruitmentSourceMaterial.js';
import type { WorkableRecruitmentScope } from './workableRecruitmentAdapter.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export function readWorkableAcceptanceApproval(env: NodeJS.ProcessEnv, scope: WorkableRecruitmentScope, now = Date.now()): { expiresAt: string; approvalFingerprint: string } | null {
  const raw = env.OTTO_WORKABLE_ACCEPTANCE_SCOPES;
  if (!raw || raw.length > 20_000) return null;
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > 20) return null;
    const id = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/u.test(value);
    const matches = entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && id(entry.organizationId) && id(entry.actorAccountId) && id(entry.jobId)
      && entry.organizationId === scope.organizationId && entry.actorAccountId === scope.actorAccountId && entry.jobId === scope.requisitionId
      && typeof entry.expiresAt === 'string' && Date.parse(entry.expiresAt) > now && Date.parse(entry.expiresAt) <= now + 7 * 86_400_000
      && typeof entry.approvalReference === 'string' && entry.approvalReference.trim().length > 0 && entry.approvalReference.length <= 200);
    if (matches.length !== 1) return null;
    const match = matches[0];
    return { expiresAt: match.expiresAt, approvalFingerprint: digest(JSON.stringify([scope, match.expiresAt, match.approvalReference])) };
  } catch { return null; }
}
export interface WorkableMaterialCheck {
  runId: string; checkedAt: string; status: 'full_text' | 'partial' | 'unavailable' | 'empty'; candidatesRead: 0 | 1;
  materialChars: number; materialFingerprint?: string; sourceFingerprint?: string;
  attachment?: { sha256: string; bytes: number; format: 'pdf' | 'txt' };
  modelInvoked: false; productionAccepted: false;
}
/** Explicit bounded read; never follows pagination, stores resume text or calls a model. */
export async function probeWorkableMaterial(input: {
  adapter: RecruitmentSourceAdapter; scope: WorkableRecruitmentScope; signal: AbortSignal;
  assertAuthorized(): Promise<void>; now?: () => number;
}): Promise<WorkableMaterialCheck> {
  const check = async () => { input.signal.throwIfAborted(); await input.assertAuthorized(); input.signal.throwIfAborted(); };
  try {
    await check();
    const result = await input.adapter.search({ ...input.scope, query: '授权测试岗位样本读取', limit: 1 }, { signal: input.signal });
    await check();
    if (!Array.isArray(result.candidates) || result.candidates.length > 1) throw new Error();
    const base = { runId: randomUUID(), checkedAt: new Date(input.now?.() ?? Date.now()).toISOString(), modelInvoked: false as const, productionAccepted: false as const };
    const candidate = result.candidates[0];
    if (!candidate) return { ...base, status: 'empty', candidatesRead: 0, materialChars: 0 };
    if (!input.adapter.getCandidate) throw new Error();
    const material = normalizeRecruitmentMaterial(await input.adapter.getCandidate({ ...input.scope, sourceRecordId: candidate.sourceRecordId }, { signal: input.signal }), candidate.sourceRecordId);
    await check();
    return { ...base, status: material.completeness, candidatesRead: 1, materialChars: material.text.length,
      materialFingerprint: digest(material.text), sourceFingerprint: digest(candidate.sourceRecordId),
      ...(material.attachment ? { attachment: { sha256: material.attachment.sha256, bytes: material.attachment.bytes, format: material.attachment.format } } : {}) };
  } catch { throw new Error('验收读取未完成：请核对本人授权、限定岗位、工具契约及附件来源；未开启生产或模型分析'); }
}
