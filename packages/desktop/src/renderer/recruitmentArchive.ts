/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { RecruitmentJobAction, RecruitmentJobResponse } from 'otto-server';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import { parseRecruitmentCandidateDocument } from './recruitmentArchiveValidation.js';
import { archiveCandidates, archiveContents, assertArchiveJob, mergeArchiveContents, recruitmentArchiveFingerprint } from './recruitmentArchiveMerge.js';
export { recruitmentArchiveFingerprint } from './recruitmentArchiveMerge.js';
export { parseRecruitmentCandidateDocument } from './recruitmentArchiveValidation.js';
export type RecruitmentArchiveCall = (action: RecruitmentJobAction) => Promise<RecruitmentJobResponse>;

function active(signal?: AbortSignal): void { if (signal?.aborted) throw new Error('招聘档案操作已取消'); }
/** Preserve unsaved local edits when a metadata/inbox action returns a full remote job. */
export async function updateRecruitmentIntake(store: RecruitmentWorkspaceStore, call: RecruitmentArchiveCall, action: Extract<RecruitmentJobAction, { kind: 'configure_intake' | 'dismiss_intake' | 'configure_background_analysis' | 'configure_auto_archive' | 'reset_intake_analysis' | 'analyze_intake_once' | 'get' }>, signal?: AbortSignal): Promise<void> {
  active(signal); const initial = store.getSnapshot(); const binding = initial.sharedJob;
  if (!binding?.base || action.jobId !== binding.id) throw new Error('请先保存或加载当前共享岗位');
  const result = await call(action); active(signal); assertArchiveJob(result, binding.id);
  if (store.getSnapshot().sharedJob !== binding) throw new Error('岗位已更新，请刷新状态后重试；本地修改未覆盖');
  if (result.sync?.scopeToken !== binding.sync?.scopeToken) throw new Error('岗位共享范围已变化，请重新加载并确认');
  const remote = archiveContents(result.job);
  const merged = mergeArchiveContents(archiveContents(binding.base, true), store.getSnapshot(), remote);
  store.applyArchiveUpdate({ ...merged, sharedJob: { ...binding, revision: result.job.revision, base: result.job, sync: result.sync, canManage: result.canManage, savedFingerprint: recruitmentArchiveFingerprint(remote) } });
}
export async function saveRecruitmentArchive(store: RecruitmentWorkspaceStore, call: RecruitmentArchiveCall, confirmed: boolean, signal?: AbortSignal): Promise<RecruitmentJobResponse> {
  active(signal);
  if (!confirmed) throw new Error('请确认有权将材料保存到企业服务器，并向本岗位授权同事共享');
  store.purgeExpired();
  const initial = store.getSnapshot();
  if (!initial.jobTitle.trim()) throw new Error('请先填写岗位名称');
  const archived = archiveCandidates(initial);
  archived.forEach((item) => parseRecruitmentCandidateDocument(item.document));
  // Keep the ID even after an ambiguous network failure; retry must not create a duplicate job.
  if (!initial.sharedJob) store.setSharedJob({ id: `job:${crypto.randomUUID()}`, revision: 0, savedFingerprint: '' });
  const binding = store.getSnapshot().sharedJob!;
  let action: RecruitmentJobAction = { kind: 'save', jobId: binding.id, expectedRevision: binding.revision, title: initial.jobTitle, description: initial.jobDescription, candidates: archived, sharingConfirmed: true };
  if (binding.sync && binding.base) {
    const base = archiveContents(binding.base, true);
    const old = new Map(archiveCandidates(base).map((item) => [item.id, item.document]));
    const desired = new Map(archived.map((item) => [item.id, item]));
    action = { kind: 'patch', jobId: binding.id, sharingConfirmed: true, scopeToken: binding.sync.scopeToken, headerToken: binding.sync.headerToken,
      ...(initial.jobTitle !== base.jobTitle || initial.jobDescription !== base.jobDescription ? { metadata: { title: initial.jobTitle, description: initial.jobDescription } } : {}),
      changes: [...new Set([...old.keys(), ...desired.keys()])].filter((id) => old.get(id) !== desired.get(id)?.document).map((id) => ({ id, candidate: desired.get(id) ?? null, expectedToken: Object.hasOwn(binding.sync!.candidateTokens, id) ? binding.sync!.candidateTokens[id]! : null })) };
  }
  const result = await call(action);
  active(signal);
  assertArchiveJob(result, binding.id);
  const job = result.job;
  if (store.getSnapshot().sharedJob !== binding) throw new Error('当前岗位已变化，保存结果未应用到本地');
  const remote = archiveContents(job);
  const merged = mergeArchiveContents(initial, store.getSnapshot(), remote);
  store.applyArchiveUpdate({ ...merged, sharedJob: { id: job.id, revision: job.revision, base: job, sync: result.sync, canManage: result.canManage, savedFingerprint: recruitmentArchiveFingerprint(remote) } });
  return result;
}
export async function loadRecruitmentArchive(store: RecruitmentWorkspaceStore, call: RecruitmentArchiveCall, id: string, signal?: AbortSignal): Promise<RecruitmentJobResponse> {
  active(signal);
  const before = store.getSnapshot();
  const result = await call({ kind: 'get', jobId: id });
  active(signal);
  assertArchiveJob(result, id);
  const job = result.job; const contents = archiveContents(job);
  if (store.getSnapshot() !== before) throw new Error('工作台在加载期间已变化，请保留修改后再加载');
  store.restoreSharedJob(job.id, job.revision, job.title, job.description, contents.candidates, contents.audits);
  store.setSharedJob({ id: job.id, revision: job.revision, base: job, sync: result.sync, canManage: result.canManage, savedFingerprint: recruitmentArchiveFingerprint(contents) });
  return result;
}

/** Read-only polling only starts from a clean workspace; edits during the request are three-way merged. */
export async function refreshRecruitmentArchive(store: RecruitmentWorkspaceStore, call: RecruitmentArchiveCall, signal?: AbortSignal): Promise<void> {
  active(signal);
  const initial = store.getSnapshot(); const binding = initial.sharedJob;
  if (!binding?.sync || !binding.base || recruitmentArchiveFingerprint(initial) !== binding.savedFingerprint) return;
  const result = await call({ kind: 'get', jobId: binding.id, knownRevision: binding.revision }); active(signal);
  if (result.kind === 'unchanged') {
    if (result.jobId !== binding.id || result.revision !== binding.revision) throw new Error('服务器返回的岗位版本不一致');
    return;
  }
  assertArchiveJob(result, binding.id);
  if (store.getSnapshot().sharedJob !== binding) return;
  if (result.sync?.scopeToken !== binding.sync.scopeToken) throw new Error('共享范围已变化，自动保存已暂停；请保留本地修改，重新加载并确认共享范围');
  if (result.job.revision === binding.revision) return;
  const remote = archiveContents(result.job); const merged = mergeArchiveContents(initial, store.getSnapshot(), remote);
  store.applyArchiveUpdate({ ...merged, sharedJob: { id: result.job.id, revision: result.job.revision, base: result.job, sync: result.sync, canManage: result.canManage, savedFingerprint: recruitmentArchiveFingerprint(remote) } });
}
