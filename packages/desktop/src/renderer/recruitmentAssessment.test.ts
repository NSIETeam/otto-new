/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { captureRecruitmentAssessmentContext, evidenceSupportLabel } from '../main/recruitmentAssessment.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from '../main/recruitmentSemantic.js';
import { assessCandidateComparison, buildCandidateComparisonReport, createEvidenceReview, evidenceReviewBinding } from './recruitmentAssessment.js';
import { analyzeCandidateResume } from './recruitmentAnalysis.js';
import type { CandidateWorkspace } from './recruitmentWorkspaceStore.js';

const job = { jobTitle: '前端工程师', jobDescription: '负责 React 企业应用和交付' };
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
async function candidate(id = 'a'): Promise<CandidateWorkspace> {
  const analysis = analyzeCandidateResume({ resumeText: '项目经历：独立完成 React 企业应用上线和自动化测试', candidateId: id, jobDescription: job.jobDescription });
  return {
    id, fileName: `${id}.txt`, analysis, sources: [], consentAt: '2026-09-08T00:00:00Z', retentionDays: 30,
    expiresAt: '2026-10-08T00:00:00Z', transcriptText: '', transcriptReport: null, transcriptWarning: '', decision: null,
    semanticMaterials: 'resume', jobTitleSnapshot: job.jobTitle, jobDescriptionSnapshot: job.jobDescription,
    semanticEvaluation: {
      summary: '自述支持交付经验', overallScore: 81, matchLevel: 'good', evidenceCoverage: 20,
      dimensions: [], hardRequirements: [], strengths: [], risks: [], missingInformation: [], interviewQuestions: [],
      evidenceGraph: [{ criterion: '交付经验', status: 'verified', assessment: '简历自述', evidence: [{ source: 'resume', line: 1, quote: 'React' }], gaps: [], nextQuestion: '' }],
      analysisVersion: RECRUITMENT_SEMANTIC_ANALYSIS_VERSION, modelProvider: 'provider', inputTokens: 1, outputTokens: 1, createdAt: '2026-09-08T00:00:00Z',
      assessmentContext: await captureRecruitmentAssessmentContext({ ...job, candidateId: id, redactedResume: analysis.redactedResume }, 'model-a'),
    },
  };
}

describe('recruitment evidence semantics and comparison gate', () => {
  it('labels material support without claiming human verification, including old statuses', () => {
    expect(evidenceSupportLabel('verified')).toBe('材料支持');
    expect(evidenceSupportLabel('partially_verified')).toBe('部分材料支持');
    expect(evidenceSupportLabel('untested')).toBe('仍待核实');
  });
  it('compares current, equivalent analyses without sorting or changing scores', async () => {
    const a = await candidate('a'); const b = await candidate('b');
    const result = await assessCandidateComparison([b, a], job);
    expect(result.comparable).toBe(true);
    expect(result.rows.map((row) => row.candidate.id)).toEqual(['b', 'a']);
    expect(buildCandidateComparisonReport(result)).toContain('| 81 |');
    expect(buildCandidateComparisonReport(result)).toContain('引用维度覆盖');
  });
  it.each(['legacy', 'job', 'material', 'model', 'rules', 'memory', 'scope', 'partial', 'expired'] as const)('withholds numerical comparisons for incompatible %s', async (change) => {
    const a = await candidate('a'); const b = await candidate('b');
    const context = b.semanticEvaluation!.assessmentContext!;
    if (change === 'legacy') delete b.semanticEvaluation!.assessmentContext;
    if (change === 'job') b.jobDescriptionSnapshot = '不同岗位';
    if (change === 'material') b.transcriptText = '面试新增回答';
    if (change === 'model') context.modelId = 'model-b';
    if (change === 'rules') b.semanticEvaluation!.analysisVersion = 'old-rules';
    if (change === 'memory') context.enterpriseFingerprint = 'a'.repeat(64);
    if (change === 'scope') {
      b.transcriptText = '面试新增回答'; b.semanticMaterials = 'resume_interview';
      b.semanticEvaluation!.assessmentContext = await captureRecruitmentAssessmentContext({ ...job, candidateId: b.id, redactedResume: b.analysis.redactedResume, interviewTranscript: b.transcriptText }, 'model-a');
    }
    if (change === 'partial') b.sourceMaterial = { material: { completeness: 'partial' } } as CandidateWorkspace['sourceMaterial'];
    if (change === 'expired') b.expiresAt = '2020-01-01T00:00:00Z';
    const result = await assessCandidateComparison([a, b], job);
    expect(result.comparable).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(buildCandidateComparisonReport(result)).not.toContain('| 81 |');
    expect(buildCandidateComparisonReport(result)).toContain('暂不比较分数');
  });
  it('distinguishes interview-only input from a real resume even when a placeholder is supplied', async () => {
    const context = await captureRecruitmentAssessmentContext({ ...job, candidateId: 'a', redactedResume: '用于提示模型的占位说明', resumeProvided: false, interviewTranscript: '候选人的面试回答' }, 'm');
    expect(context.materialScope).toEqual(['interview']);
  });
  it('requires explicit human review and binds it to current materials, job and analysis', async () => {
    const a = await candidate(); const binding = await evidenceReviewBinding(a, job);
    expect(() => createEvidenceReview({ binding, criterion: '交付经验', reviewerId: 'hr-1', outcome: 'supported', rationale: '', confirmed: true })).toThrow();
    expect(() => createEvidenceReview({ binding, criterion: '交付经验', reviewerId: 'hr-1', outcome: 'supported', rationale: '电话核实了项目职责', confirmed: false })).toThrow();
    const review = createEvidenceReview({ binding, criterion: '交付经验', reviewerId: 'hr-1', outcome: 'supported', rationale: '电话核实了项目职责', confirmed: true });
    expect(review.actorType).toBe('human');
    expect(review.binding).toBe(binding);
    expect(await evidenceReviewBinding(a, { ...job, jobDescription: '另一岗位' })).not.toBe(binding);
    a.transcriptText = '新材料'; expect(await evidenceReviewBinding(a, job)).not.toBe(binding);
    a.transcriptText = ''; a.semanticEvaluation!.summary = '新分析';
    expect(await evidenceReviewBinding(a, job)).not.toBe(binding);
    a.semanticEvaluation!.summary = '自述支持交付经验';
    a.sourceMaterial = { contentHash: 'b'.repeat(64), material: { completeness: 'full_text' } } as CandidateWorkspace['sourceMaterial'];
    expect(await evidenceReviewBinding(a, job)).not.toBe(binding);
  });
  it('does not invalidate human reviews solely because an identical analysis was reused', async () => {
    const a = await candidate();
    a.semanticEvaluation!.execution = { runId: 'run', disposition: 'executed', requestedAt: '2026-09-08T00:00:00Z', inputFingerprint: 'a'.repeat(64), inputTokens: 5, outputTokens: 5 };
    const binding = await evidenceReviewBinding(a, job);
    a.semanticEvaluation!.execution.disposition = 'reused'; a.semanticEvaluation!.execution.requestId = 'new-request';
    expect(await evidenceReviewBinding(a, job)).toBe(binding);
  });
});
