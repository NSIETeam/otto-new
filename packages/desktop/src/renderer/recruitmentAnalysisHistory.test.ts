/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { RecruitmentWorkspaceStore, type CandidateWorkspace } from './recruitmentWorkspaceStore.js';
import { analyzeCandidateResume } from './recruitmentAnalysis.js';
import { assertRecruitmentHistoryCapacity, describeRecruitmentAnalysisChange, recruitmentUsageSummary } from './recruitmentAnalysisHistory.js';
import { parseRecruitmentCandidateDocument } from './recruitmentArchiveValidation.js';
import type { RecruitmentSemanticEvaluation } from '../main/recruitmentSemantic.js';

const evaluation = (runId: string): RecruitmentSemanticEvaluation => ({
  summary: '简历自述支持', overallScore: 60, matchLevel: 'partial', evidenceCoverage: 20,
  dimensions: [], hardRequirements: [], strengths: [], risks: [], missingInformation: [], interviewQuestions: [],
  analysisVersion: 'test', modelProvider: 'test', inputTokens: 10, outputTokens: 5, createdAt: '2026-09-08T00:00:00Z',
  execution: { runId, disposition: 'executed', requestedAt: '2026-09-08T00:00:00Z', inputFingerprint: 'a'.repeat(64), inputTokens: 10, outputTokens: 5 },
});
function candidate(): CandidateWorkspace {
  return { id: 'a', fileName: '简历.txt', sources: [], consentAt: '2026-09-08T00:00:00Z', retentionDays: 30, expiresAt: '2026-10-08T00:00:00Z',
    analysis: analyzeCandidateResume({ candidateId: 'a', resumeText: '负责 React 项目研发和交付', jobDescription: '前端研发' }),
    jobTitleSnapshot: '前端', jobDescriptionSnapshot: '前端研发', semanticEvaluation: evaluation('run-1'),
    transcriptText: '', transcriptReport: null, transcriptWarning: '', decision: null };
}

describe('unified recruitment analysis history', () => {
  it('stops at the history limit without silently deleting prior results', () => {
    const store = new RecruitmentWorkspaceStore(); store.setCandidates([candidate()]);
    for (let i = 2; i <= 20; i++) store.setCandidates((items) => items.map((item) => ({ ...item, semanticEvaluation: evaluation(`run-${i}`) })));
    const previous = store.getSnapshot().candidates[0]!;
    expect(() => assertRecruitmentHistoryCapacity(previous)).toThrow('未发起');
    expect(() => store.setCandidates([{ ...previous, semanticEvaluation: evaluation('run-21') }])).toThrow('未覆盖');
    expect(store.getSnapshot().candidates[0]).toBe(previous);
    expect(previous.analysisHistory).toHaveLength(20);
  });
  it('preserves results and original snapshots through pending/failure and all candidate updates', () => {
    const store = new RecruitmentWorkspaceStore(); store.setCandidates([candidate()]);
    const initial = store.activeCandidate() ?? store.getSnapshot().candidates[0]!;
    store.setCandidates([{ ...initial, semanticEvaluation: null, transcriptText: '新增面试回答' }]);
    expect(store.getSnapshot().candidates[0]!.analysisHistory?.[0].transcriptText).toBe('');
    store.setCandidates((items) => items.map((item) => ({ ...item, semanticEvaluation: evaluation('run-2') })));
    const updated = store.getSnapshot().candidates[0]!;
    expect(updated.analysisHistory).toHaveLength(2);
    expect(updated.analysisHistory?.[0].transcriptText).toBe('新增面试回答');
    expect(parseRecruitmentCandidateDocument(JSON.stringify(updated)).candidate.analysisHistory).toHaveLength(2);
    store.setCandidates([updated]); expect(store.getSnapshot().candidates[0]).toBe(updated);
    store.setCandidates([]); expect(store.getSnapshot().candidates).toEqual([]);
  });
  it('records reused requests without duplicating versions or charging the same run twice', () => {
    const store = new RecruitmentWorkspaceStore(); store.setCandidates([candidate()]);
    store.setCandidates((items) => items.map((item) => ({ ...item, semanticEvaluation: { ...item.semanticEvaluation!, execution: {
      ...item.semanticEvaluation!.execution!, disposition: 'reused', requestedAt: '2026-09-08T00:01:00Z',
    } } })));
    const current = store.getSnapshot().candidates[0]!;
    expect(current.analysisHistory).toHaveLength(1);
    expect(current.analysisHistory?.[0].reuseCount).toBe(1);
    expect(recruitmentUsageSummary([current, { ...current, id: 'b' }])).toMatchObject({ runs: 1, inputTokens: 10, outputTokens: 5, unknownRuns: 0 });
  });
  it('keeps unknown and legacy usage unknown, and explains version changes without claiming improved accuracy', () => {
    const old = evaluation('old'); delete old.execution;
    const next = evaluation('new'); next.execution!.inputTokens = null; next.analysisVersion = 'new-rules';
    const store = new RecruitmentWorkspaceStore(); store.setCandidates([{ ...candidate(), semanticEvaluation: old }]);
    store.setCandidates((items) => items.map((item) => ({ ...item, semanticEvaluation: next })));
    expect(recruitmentUsageSummary(store.getSnapshot().candidates)).toMatchObject({ unknownRuns: 2, outputTokens: 5 });
    expect(describeRecruitmentAnalysisChange(old, next)).toContain('分析规则已更新');
    expect(describeRecruitmentAnalysisChange(old, next).join('')).not.toContain('更准确');
    const malformed = structuredClone(store.getSnapshot().candidates[0]!); malformed.analysisHistory![0]!.evaluation.execution!.inputTokens = -1;
    expect(() => parseRecruitmentCandidateDocument(JSON.stringify(malformed))).toThrow('格式');
  });
});
