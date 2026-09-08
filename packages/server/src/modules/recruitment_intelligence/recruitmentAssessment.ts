/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
// Browser-safe shared contract: no Node, model runtime, or privileged imports.
import type { RecruitmentAssessmentContext, RecruitmentEvidenceStatus, RecruitmentSemanticAnalysisInput } from './recruitmentSemantic.js';

export const RECRUITMENT_COVERAGE_NOTICE = '引用维度覆盖 = 有原文引用的分析维度数 / 全部分析维度数；不代表岗位条件已核实比例，也不证明能力属实。';
export const RECRUITMENT_SUPPORT_NOTICE = '简历自述、面试回答和实战材料提供的是支持线索，不等于能力已经核实；人工核实需单独记录，存在矛盾时仍须复核。';
export const evidenceSourceLabel = (source?: 'resume' | 'interview' | 'work_sample'): string => (
  source === 'interview' ? '面试回答支持' : source === 'work_sample' ? '实战材料支持' : '简历自述支持'
);
export function evidenceSupportLabel(status: RecruitmentEvidenceStatus): string {
  return { verified: '材料支持', partially_verified: '部分材料支持', contradicted: '存在矛盾', untested: '仍待核实', unclear: '材料不清楚' }[status];
}
export function normalizeAssessmentText(value: string | undefined): string {
  return (value ?? '').replace(/\r\n?/gu, '\n').trim();
}
export async function recruitmentFingerprint(value: unknown): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function captureRecruitmentAssessmentContext(
  input: RecruitmentSemanticAnalysisInput,
  modelId: string,
): Promise<RecruitmentAssessmentContext> {
  const resume = input.resumeProvided === false ? '' : normalizeAssessmentText(input.redactedResume);
  const interview = normalizeAssessmentText(input.interviewTranscript);
  const workSample = normalizeAssessmentText(input.workSampleArtifact);
  const materialScope: RecruitmentAssessmentContext['materialScope'] = [
    ...(resume ? ['resume' as const] : []), ...(interview ? ['interview' as const] : []), ...(workSample ? ['work_sample' as const] : []),
  ];
  const [jobFingerprint, materialFingerprint, enterpriseFingerprint] = await Promise.all([
    recruitmentFingerprint([normalizeAssessmentText(input.jobTitle), normalizeAssessmentText(input.jobDescription)]),
    recruitmentFingerprint([resume, interview, workSample]),
    recruitmentFingerprint(normalizeAssessmentText(input.enterpriseContext)),
  ]);
  return { schemaVersion: 1, jobFingerprint, materialFingerprint, enterpriseFingerprint, materialScope, modelId };
}
