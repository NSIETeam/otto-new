/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import { RecruitmentJobError, recruitmentJobId, recruitmentJobText, validateRecruitmentCandidates, type RecruitmentArchivedCandidate, type RecruitmentSharedJob } from './recruitmentJobs.js';

export interface RecruitmentSyncMetadata { scopeToken: string; headerToken: string; candidateTokens: Record<string, string> }
export interface RecruitmentJobPatch {
  kind: 'patch'; jobId: string; sharingConfirmed: true; scopeToken: string; headerToken: string;
  metadata?: { title: string; description: string };
  changes: Array<{ id: string; expectedToken: string | null; candidate: RecruitmentArchivedCandidate | null }>;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function recruitmentSyncMetadata(job: RecruitmentSharedJob): RecruitmentSyncMetadata {
  return { scopeToken: hash([job.id, job.ownerAccountId ?? null, [...job.collaboratorAccountIds].sort()]),
    headerToken: hash([job.title, job.description]),
    candidateTokens: Object.fromEntries(job.candidates.map((item) => [item.id, hash([item.id, item.expiresAt, item.document, item.personId ?? null])])) };
}

/** Candidate-level optimistic merge over the existing encrypted job CAS store.
 * Other candidate writes can be retried; overlapping edits fail closed. No last-write-wins. */
export function mergeRecruitmentPatch(current: RecruitmentSharedJob, action: RecruitmentJobPatch, now: string, actorId: string): RecruitmentSharedJob {
  const sync = recruitmentSyncMetadata(current);
  if (action.sharingConfirmed !== true) throw new RecruitmentJobError(400, '请先确认企业共享范围');
  if (action.scopeToken !== sync.scopeToken) throw new RecruitmentJobError(409, '共享范围已变化，自动保存已暂停；请重新加载并确认共享范围');
  if (!Array.isArray(action.changes) || action.changes.length > 100) throw new RecruitmentJobError(400, '候选人修改列表无效');
  const title = action.metadata ? recruitmentJobText(action.metadata.title, 500, true) : current.title;
  const description = action.metadata ? recruitmentJobText(action.metadata.description, 30_000) : current.description;
  if (action.headerToken !== sync.headerToken && !(action.metadata && title === current.title && description === current.description)) throw new RecruitmentJobError(409, '岗位要求已被同事修改，本地修改已保留；请先核对岗位要求');
  const byId = new Map(current.candidates.map((item) => [item.id, item]));
  const ids = new Set<string>();
  let changed = title !== current.title || description !== current.description;
  for (const change of action.changes) {
    if (!change || typeof change !== 'object') throw new RecruitmentJobError(400, '候选人修改格式无效');
    const id = recruitmentJobId(change.id);
    if (ids.has(id) || (change.expectedToken !== null && (typeof change.expectedToken !== 'string' || !/^[a-f0-9]{64}$/u.test(change.expectedToken)))) throw new RecruitmentJobError(400, '候选人版本标识无效或重复');
    ids.add(id);
    const existing = byId.get(id);
    const desired = change.candidate === null ? null : validateRecruitmentCandidates([change.candidate], Date.parse(now))[0];
    if (change.candidate !== null && (!desired || desired.id !== id)) throw new RecruitmentJobError(400, '候选人已到期或身份关联不一致');
    // Exact retries are safe, including deletes. Never copy a client personId.
    if ((!desired && !existing) || (desired && existing && desired.document === existing.document && desired.expiresAt === existing.expiresAt)) continue;
    const token = Object.hasOwn(sync.candidateTokens, id) ? sync.candidateTokens[id] : null;
    if (change.expectedToken !== token) throw new RecruitmentJobError(409, `候选人 ${id} 已被其他同事更新，本地修改已保留；请先核对双方材料`);
    if (desired) byId.set(id, { ...desired, personId: existing?.personId ?? `person:${randomUUID()}` }); else byId.delete(id);
    changed = true;
  }
  if (!changed) return current;
  const candidates = [...byId.values()].filter((item) => Date.parse(item.expiresAt) > Date.parse(now));
  if (candidates.length > 100 || Buffer.byteLength(JSON.stringify([candidates, current.incomingMaterials ?? []]), 'utf8') > 5_900_000) throw new RecruitmentJobError(400, '岗位档案超过大小限制');
  return { ...current, title, description, candidates, revision: current.revision + 1, updatedAt: now, updatedBy: actorId };
}
