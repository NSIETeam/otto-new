/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { RecruitmentArchivedCandidate, RecruitmentJobResponse, RecruitmentSharedJob } from 'otto-server';
import type { RecruitmentWorkspaceState } from './recruitmentWorkspaceStore.js';
import { parseRecruitmentCandidateDocument, validRecruitmentInbox, validRecruitmentIntake, validRecruitmentBackground, validRecruitmentAutoArchive } from './recruitmentArchiveValidation.js';

type Contents = Pick<RecruitmentWorkspaceState, 'jobTitle' | 'jobDescription' | 'candidates' | 'audits'>;
export function archiveCandidates(state: Contents): RecruitmentArchivedCandidate[] {
  return state.candidates.map((candidate) => ({ id: candidate.id, expiresAt: candidate.expiresAt,
    document: JSON.stringify({ ...candidate, archiveVersion: 1, archiveAudits: state.audits.filter((audit) => audit.candidateId === candidate.id) }) }));
}
export function recruitmentArchiveFingerprint(state: Contents): string {
  // Unscoped/local audit events are not uploaded. Selection and consent are also local state.
  return JSON.stringify([state.jobTitle, state.jobDescription, archiveCandidates(state).sort((a, b) => a.id.localeCompare(b.id))]);
}
export function archiveContents(job: RecruitmentSharedJob, includeExpired = false): Contents {
  const ids = new Set<string>();
  const parsed = job.candidates.map((item) => {
    const data = parseRecruitmentCandidateDocument(item.document);
    if (item.id !== data.candidate.id || item.expiresAt !== data.candidate.expiresAt || ids.has(item.id)) throw new Error('候选人档案格式与岗位索引不一致');
    ids.add(item.id); return data;
  }).filter((data) => includeExpired || Date.parse(data.candidate.expiresAt) > Date.now());
  return { jobTitle: job.title, jobDescription: job.description, candidates: parsed.map((item) => item.candidate), audits: parsed.flatMap((item) => item.audits) };
}
export function assertArchiveJob(result: RecruitmentJobResponse, id: string): asserts result is Extract<RecruitmentJobResponse, { kind: 'job' }> {
  if (result.kind !== 'job' || result.job?.id !== id || !Number.isSafeInteger(result.job.revision) || result.job.revision < 1
    || typeof result.job.title !== 'string' || typeof result.job.description !== 'string' || !Array.isArray(result.job.candidates) || result.job.candidates.length > 100
    || !Array.isArray(result.job.collaboratorAccountIds) || !result.job.collaboratorAccountIds.every((item) => typeof item === 'string')) throw new Error('服务器返回的岗位档案无效');
  if (result.sync) {
    const token = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
    if (!token(result.sync.scopeToken) || !token(result.sync.headerToken) || !result.sync.candidateTokens || typeof result.sync.candidateTokens !== 'object'
      || result.job.candidates.some((item) => !Object.hasOwn(result.sync!.candidateTokens, item.id) || !token(result.sync!.candidateTokens[item.id]))) throw new Error('服务器返回的候选人版本标识无效');
  }
  if (!validRecruitmentIntake(result.job.intake) || !validRecruitmentBackground(result.job.backgroundAnalysis) || !validRecruitmentAutoArchive(result.job.autoArchive) || !validRecruitmentInbox(result.job.incomingMaterials)
    || result.job.incomingMaterials?.some((item) => item.material.requisitionId !== id)) throw new Error('服务器返回的后台接收状态或待处理材料无效');
}
/** Three-way merge: a response must never overwrite work entered while it was in flight. */
export function mergeArchiveContents(submitted: Contents, local: Contents, remote: Contents): Contents {
  const mergeText = (before: string, mine: string, theirs: string): string => {
    if (mine !== before && theirs !== before && mine !== theirs) throw new Error('保存期间发生冲突，本地修改已保留；请核对服务器版本');
    return mine === before ? theirs : mine;
  };
  const docs = (contents: Contents) => new Map(archiveCandidates(contents).map((item) => [item.id, item.document]));
  const before = docs(submitted); const mine = docs(local); const theirs = docs(remote);
  const merged = [...new Set([...mine.keys(), ...theirs.keys()])].flatMap((id) => {
    const old = before.get(id); const left = mine.get(id); const right = theirs.get(id);
    if (left !== old && right !== old && left !== right) throw new Error(`候选人 ${id} 保存期间发生冲突，本地修改已保留；请核对双方材料`);
    const document = left === old ? right : left;
    if (!document) return [];
    // Keep unchanged object identity: source import and dialogue use it to reject stale model results.
    if (document === left) return [{ candidate: local.candidates.find((item) => item.id === id)!, audits: local.audits.filter((audit) => audit.candidateId === id) }];
    return [parseRecruitmentCandidateDocument(document)];
  });
  return { jobTitle: mergeText(submitted.jobTitle, local.jobTitle, remote.jobTitle), jobDescription: mergeText(submitted.jobDescription, local.jobDescription, remote.jobDescription),
    candidates: merged.map((item) => item.candidate), audits: [...merged.flatMap((item) => item.audits), ...local.audits.filter((audit) => !before.has(audit.candidateId) && !mine.has(audit.candidateId) && !theirs.has(audit.candidateId))] };
}
