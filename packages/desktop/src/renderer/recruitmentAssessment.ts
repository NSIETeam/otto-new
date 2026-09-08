/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { captureRecruitmentAssessmentContext, normalizeAssessmentText, recruitmentFingerprint, RECRUITMENT_COVERAGE_NOTICE } from '../main/recruitmentAssessment.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from '../main/recruitmentSemantic.js';
import type { CandidateWorkspace } from './recruitmentWorkspaceStore.js';

export interface RecruitmentComparisonJob { jobTitle: string; jobDescription: string }
export interface RecruitmentComparison {
  comparable: boolean;
  reasons: string[];
  rows: Array<{ candidate: CandidateWorkspace; reasons: string[]; scope: string }>;
}
export function candidateAssessmentInput(candidate: CandidateWorkspace, job: RecruitmentComparisonJob) {
  return { ...job, candidateId: candidate.id, redactedResume: candidate.analysis.redactedResume,
    resumeProvided: candidate.semanticMaterials !== 'interview', interviewTranscript: candidate.transcriptText,
    workSampleArtifact: candidate.workSampleText };
}
export async function assessCandidateComparison(candidates: CandidateWorkspace[], job: RecruitmentComparisonJob): Promise<RecruitmentComparison> {
  const rows = await Promise.all(candidates.map(async (candidate) => {
    const evaluation = candidate.semanticEvaluation; const context = evaluation?.assessmentContext;
    const reasons: string[] = [];
    if (!Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= Date.now()) reasons.push('候选人材料已到保存期限，不能继续比较');
    if (!evaluation) reasons.push('尚未完成模型分析');
    else if (!context || context.schemaVersion !== 1 || !context.modelId.trim()) reasons.push('缺少分析口径信息，请重新分析');
    if (evaluation && evaluation.analysisVersion !== RECRUITMENT_SEMANTIC_ANALYSIS_VERSION) reasons.push('分析规则版本已变化，请重新分析');
    if (candidate.sourceMaterial && candidate.sourceMaterial.material.completeness !== 'full_text') reasons.push('来源材料不完整，仅可初步判断');
    if (context) {
      const current = await captureRecruitmentAssessmentContext(candidateAssessmentInput(candidate, job), context.modelId);
      if (current.jobFingerprint !== context.jobFingerprint
        || normalizeAssessmentText(candidate.jobTitleSnapshot) !== normalizeAssessmentText(job.jobTitle)
        || normalizeAssessmentText(candidate.jobDescriptionSnapshot) !== normalizeAssessmentText(job.jobDescription)) reasons.push('岗位标准已变化，请按当前岗位重新分析');
      if (current.materialFingerprint !== context.materialFingerprint || JSON.stringify(current.materialScope) !== JSON.stringify(context.materialScope)) reasons.push('材料已变化，请重新分析');
    }
    const scope = context?.materialScope.map((source) => ({ resume: '简历', interview: '面试', work_sample: '实战材料' }[source])).join(' + ') || '材料范围未知';
    return { candidate, reasons, scope };
  }));
  const reasons = [...new Set(rows.flatMap((row) => row.reasons))];
  if (candidates.length < 2) reasons.push('请选择至少两位候选人');
  const contexts = candidates.flatMap((candidate) => candidate.semanticEvaluation?.assessmentContext ? [candidate.semanticEvaluation.assessmentContext] : []);
  if (new Set(contexts.map((context) => JSON.stringify(context.materialScope))).size > 1) reasons.push('材料范围不同：请补齐同类材料或只选择同范围候选人');
  if (new Set(contexts.map((context) => context.modelId)).size > 1
    || new Set(candidates.map((candidate) => candidate.semanticEvaluation?.modelProvider)).size > 1) reasons.push('分析模型不同：请使用同一模型重新分析');
  if (new Set(contexts.map((context) => context.enterpriseFingerprint)).size > 1) reasons.push('采用的企业标准不同：请统一企业上下文后重新分析');
  return { comparable: reasons.length === 0, reasons, rows };
}

const cell = (value: string | number): string => String(value).replace(/\|/gu, '／').replace(/[\r\n]/gu, ' ');
export function buildCandidateComparisonReport(result: RecruitmentComparison): string {
  return [
    '# 候选人全文语义对比报告', '',
    '> 同口径也不代表判断准确或材料质量相同。保持导入顺序，不自动排名、淘汰或录用。',
    `> ${RECRUITMENT_COVERAGE_NOTICE}`, '',
    ...(result.comparable ? ['本次岗位、材料类型、企业上下文、模型和规则版本检查一致。'] : ['暂不比较分数：', ...result.reasons.map((reason) => `- ${reason}`)]), '',
    '| 候选人 | 综合匹配度 | 引用维度覆盖 | 核心能力 | 交付结果 | 材料范围 | 检查结果 |',
    '|---|---:|---:|---:|---:|---|---|',
    ...result.rows.map(({ candidate, reasons, scope }) => {
      const evaluation = result.comparable ? candidate.semanticEvaluation : null;
      const dimensions = new Map(evaluation?.dimensions.map((dimension) => [dimension.id, dimension.score]));
      return `| ${[candidate.analysis.identity.name || candidate.fileName, evaluation?.overallScore ?? '—', evaluation ? `${evaluation.evidenceCoverage}%` : '—', dimensions.get('core_capability') ?? '—', dimensions.get('delivery_impact') ?? '—', scope, reasons.join('；') || (result.comparable ? '口径一致，仍须人工核实' : '本组暂不比较分数')].map(cell).join(' | ')} |`;
    }),
  ].join('\n');
}

/** A human-entered annotation, not a model conclusion or a server-signed attestation. */
export interface RecruitmentEvidenceReview {
  binding: string; criterion: string; reviewerId: string; actorType: 'human';
  outcome: 'supported' | 'contradicted' | 'inconclusive'; rationale: string; createdAt: string;
}
export function evidenceReviewBinding(candidate: CandidateWorkspace, job: RecruitmentComparisonJob): Promise<string> {
  const evaluation = candidate.semanticEvaluation ? { ...candidate.semanticEvaluation } : candidate.semanticEvaluation;
  if (evaluation) delete evaluation.execution; // Delivery/reuse metadata does not change the evidence being reviewed.
  return recruitmentFingerprint([candidateAssessmentInput(candidate, job), evaluation,
    candidate.sourceMaterial?.contentHash, candidate.sourceMaterial?.material.completeness, candidate.sourceMaterial?.material.attachment?.sha256]);
}
export function createEvidenceReview(input: Omit<RecruitmentEvidenceReview, 'actorType' | 'createdAt'> & { confirmed: boolean }): RecruitmentEvidenceReview {
  if (!input.confirmed || !input.reviewerId.trim() || !input.criterion.trim() || !/^[a-f0-9]{64}$/u.test(input.binding)
    || input.rationale.trim().length < 5 || input.rationale.length > 1000
    || !['supported', 'contradicted', 'inconclusive'].includes(input.outcome)) throw new Error('请人工核实后确认，并填写 5–1000 字的核实依据');
  return { binding: input.binding, criterion: input.criterion, reviewerId: input.reviewerId, actorType: 'human', outcome: input.outcome, rationale: input.rationale.trim(), createdAt: new Date().toISOString() };
}
