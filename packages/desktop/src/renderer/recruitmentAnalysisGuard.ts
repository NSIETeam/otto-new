/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import { assertRecruitmentHistoryCapacity } from './recruitmentAnalysisHistory.js';

/** Automatic archive refresh may change materials while a model request is running. */
export function captureRecruitmentAnalysisGuard(store: RecruitmentWorkspaceStore, candidateId?: string): { isCurrent(): boolean; assertCurrent(): void } {
  const initial = store.getSnapshot(); const epoch = store.getWorkspaceEpoch();
  const document = candidateId ? JSON.stringify(initial.candidates.find((item) => item.id === candidateId)) : undefined;
  const isCurrent = (): boolean => {
    const current = store.getSnapshot(); const candidate = candidateId ? current.candidates.find((item) => item.id === candidateId) : undefined;
    return epoch === store.getWorkspaceEpoch() && initial.jobTitle === current.jobTitle && initial.jobDescription === current.jobDescription
      && (!candidateId || Boolean(candidate && Date.parse(candidate.expiresAt) > Date.now() && JSON.stringify(candidate) === document));
  };
  return { isCurrent, assertCurrent: () => {
    if (!isCurrent()) throw new Error('岗位或候选人材料已变化，本次旧分析未覆盖新材料；请按最新内容重新分析');
    if (candidateId) assertRecruitmentHistoryCapacity(initial.candidates.find((item) => item.id === candidateId));
  } };
}
