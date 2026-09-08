/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { RecruitmentSemanticEvaluation } from '../main/recruitmentSemantic.js';
import type { CandidateWorkspace } from './recruitmentWorkspaceStore.js';

export interface RecruitmentAnalysisRevision {
  evaluation: RecruitmentSemanticEvaluation;
  jobTitle: string;
  jobDescription: string;
  resumeText: string;
  transcriptText: string;
  workSampleText: string;
  fileName: string;
  reuseCount: number;
  lastRequest: string;
}
const identity = (e: RecruitmentSemanticEvaluation): string => e.execution?.runId ?? JSON.stringify(e);
const request = (e: RecruitmentSemanticEvaluation): string => e.execution?.requestId ?? e.execution?.requestedAt ?? e.createdAt;

export function assertRecruitmentHistoryCapacity(candidate?: CandidateWorkspace): void {
  if ((candidate?.analysisHistory?.length ?? 0) >= 20) throw new Error('已保留 20 个分析版本，请先导出并整理候选人档案；本次未发起新的分析');
}

/** All card/chat/source writes pass here. Never mutate the prior snapshot or drop history silently. */
export function retainRecruitmentAnalysisHistory(previous: CandidateWorkspace | undefined, next: CandidateWorkspace): CandidateWorkspace {
  if (previous === next) return next;
  let history = next.analysisHistory ?? previous?.analysisHistory ?? [];
  const initial = history;
  const add = (candidate: CandidateWorkspace, countReuse: boolean): void => {
    const evaluation = candidate.semanticEvaluation;
    if (!evaluation) return;
    const existing = history.find((entry) => identity(entry.evaluation) === identity(evaluation));
    if (existing) {
      if (countReuse && evaluation.execution?.disposition === 'reused' && existing.lastRequest !== request(evaluation)) {
        history = history.map((entry) => entry === existing ? { ...entry, reuseCount: entry.reuseCount + 1, lastRequest: request(evaluation) } : entry);
      }
      return;
    }
    if (history.length >= 20) throw new Error('分析历史已达 20 个版本，未覆盖旧档案；请先导出并整理历史材料');
    history = [{ evaluation: structuredClone(evaluation), jobTitle: candidate.jobTitleSnapshot ?? '', jobDescription: candidate.jobDescriptionSnapshot ?? '',
      resumeText: candidate.semanticMaterials === 'interview' ? '' : candidate.analysis.redactedResume,
      transcriptText: candidate.transcriptText, workSampleText: candidate.workSampleText ?? '', fileName: candidate.fileName,
      reuseCount: evaluation.execution?.disposition === 'reused' ? 1 : 0, lastRequest: request(evaluation) }, ...history];
  };
  if (previous) add(previous, false); // Migrate a legacy result before a pending/failed replacement clears it.
  add(next, true);
  return history !== initial || (history.length && next.analysisHistory !== history) ? { ...next, analysisHistory: history } : next;
}

export function describeRecruitmentAnalysisChange(previous: RecruitmentSemanticEvaluation | undefined, next: RecruitmentSemanticEvaluation): string[] {
  if (!previous) return ['首次保存的分析结果'];
  const reasons: string[] = [];
  const a = previous.assessmentContext; const b = next.assessmentContext;
  if (!a || !b) reasons.push('旧结果缺少完整口径记录，无法核对全部输入变化');
  else {
    if (a.jobFingerprint !== b.jobFingerprint) reasons.push('岗位标准已变化');
    if (a.materialFingerprint !== b.materialFingerprint) reasons.push('简历、面试或实战材料已变化');
    if (a.enterpriseFingerprint !== b.enterpriseFingerprint) reasons.push('采用的企业标准已变化');
    if (a.modelId !== b.modelId) reasons.push('分析模型已更换');
  }
  if (previous.analysisVersion !== next.analysisVersion) reasons.push('分析规则已更新');
  if (previous.modelProvider !== next.modelProvider) reasons.push('模型服务商已更换');
  if (!reasons.length) reasons.push('未识别到材料与口径变化；可能因缓存到期、应用重启或模型配置变化重新执行');
  return reasons;
}

/** Local observation, not a billing ledger. Only provider-reported counts are added, once per physical run. */
export function recruitmentUsageSummary(candidates: CandidateWorkspace[]) {
  const runs = new Map<string, RecruitmentSemanticEvaluation>();
  for (const candidate of candidates) {
    const evaluations = [...(candidate.analysisHistory ?? []).map((entry) => entry.evaluation), ...(candidate.semanticEvaluation ? [candidate.semanticEvaluation] : [])];
    for (const e of evaluations) runs.set(e.execution?.runId ?? `${candidate.id}:${identity(e)}`, e);
  }
  let inputTokens = 0; let outputTokens = 0; let unknownRuns = 0;
  for (const evaluation of runs.values()) {
    const usage = evaluation.execution;
    if (!usage || usage.inputTokens === null || usage.outputTokens === null) unknownRuns += 1;
    inputTokens += usage?.inputTokens ?? 0; outputTokens += usage?.outputTokens ?? 0;
  }
  return { runs: runs.size, inputTokens, outputTokens, unknownRuns };
}
