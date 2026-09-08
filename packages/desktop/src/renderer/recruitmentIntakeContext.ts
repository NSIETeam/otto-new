/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { RecruitmentSemanticAnalysisInput } from '../main/recruitmentSemantic.js';
import type { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';

/** Exact source/material association only; never infer ownership from a candidate's name. */
export function withRecruitmentIntakeContext(store: RecruitmentWorkspaceStore, input: RecruitmentSemanticAnalysisInput, itemId?: string): RecruitmentSemanticAnalysisInput {
  const state = store.getSnapshot(); const binding = state.sharedJob;
  const candidate = state.candidates.find((entry) => entry.id === input.candidateId);
  const source = candidate?.sourceMaterial;
  const item = binding?.base?.incomingMaterials?.find((entry) => itemId ? entry.id === itemId : Boolean(source
    && entry.material.source.sourceId === source.source.sourceId && entry.material.source.sourceRecordId === source.source.sourceRecordId
    && entry.material.contentHash === source.contentHash && entry.material.material.text === source.material.text));
  if (!item) { if (itemId) throw new Error('共享待处理材料已变化，请刷新后再分析'); return input; }
  // Background results have already been durably attempted. Explicit subsequent joint analysis is a separate user operation.
  if (item.analysis) return input;
  // Once the original result is actually retained, explicit later interview/work-sample
  // analysis is a new operation, not a second import of the same inbox entry.
  if (!itemId && item.manualAnalysis?.status === 'completed' && item.manualAnalysis.candidateId === input.candidateId
    && candidate?.semanticEvaluation?.coordination?.claimId === item.manualAnalysis.id) return input;
  if (!binding?.sync || !binding.base || Date.parse(item.expiresAt) <= Date.now()) throw new Error('共享岗位版本或认领能力尚未确认，请重新加载；本次未调用模型');
  return { ...input, sharedIntake: { scopeId: store.scopeKey, jobId: binding.id, itemId: item.id, scopeToken: binding.sync.scopeToken, headerToken: binding.sync.headerToken } };
}
