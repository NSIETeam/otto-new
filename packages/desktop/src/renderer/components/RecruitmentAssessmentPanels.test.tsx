/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useSyncExternalStore } from 'react';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecruitmentComparisonPanel } from './RecruitmentComparisonPanel.js';
import { RecruitmentEvidenceReviewPanel } from './RecruitmentEvidenceReviewPanel.js';
import { RecruitmentAnalysisHistoryPanel } from './RecruitmentAnalysisHistoryPanel.js';
import { RecruitmentWorkspaceStore, type CandidateWorkspace } from '../recruitmentWorkspaceStore.js';
import { captureRecruitmentAssessmentContext } from '../../main/recruitmentAssessment.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from '../../main/recruitmentSemantic.js';
import { analyzeCandidateResume } from '../recruitmentAnalysis.js';
import { parseRecruitmentCandidateDocument } from '../recruitmentArchiveValidation.js';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
const job = { jobTitle: '前端', jobDescription: '负责 React 工程交付' };
async function candidate(id: string): Promise<CandidateWorkspace> {
  const analysis = analyzeCandidateResume({ candidateId: id, resumeText: '项目经历：独立完成 React 企业应用上线和自动化测试', jobDescription: job.jobDescription });
  return { id, fileName: `${id}.txt`, analysis, sources: [], consentAt: '2026-09-08T00:00:00Z', retentionDays: 30, expiresAt: '2026-10-08T00:00:00Z', transcriptText: '', transcriptReport: null, transcriptWarning: '', decision: null,
    jobTitleSnapshot: job.jobTitle, jobDescriptionSnapshot: job.jobDescription, semanticMaterials: 'resume',
    semanticEvaluation: { summary: '简历自述有交付经验', overallScore: 81, matchLevel: 'good', evidenceCoverage: 20, dimensions: [], hardRequirements: [], strengths: [], risks: [], missingInformation: [], interviewQuestions: [],
      evidenceGraph: [{ criterion: '工程交付', status: 'verified', assessment: '自述支持', evidence: [{ source: 'resume', line: 1, quote: '独立完成' }], gaps: [], nextQuestion: '' }],
      modelProvider: 'provider', analysisVersion: RECRUITMENT_SEMANTIC_ANALYSIS_VERSION, createdAt: '2026-09-08T00:00:00Z', inputTokens: 1, outputTokens: 1,
      assessmentContext: await captureRecruitmentAssessmentContext({ ...job, candidateId: id, redactedResume: analysis.redactedResume }, 'model-a') },
  };
}
function ReviewHarness({ store }: { store: RecruitmentWorkspaceStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const item = state.candidates[0];
  return item ? <RecruitmentEvidenceReviewPanel candidate={item} graph={item.semanticEvaluation?.evidenceGraph ?? []} reviewerId="hr-1" store={store} jobTitle={state.jobTitle} jobDescription={state.jobDescription} /> : null;
}

describe('recruitment comparison and human review UI', () => {
  it('shows analysis history only on demand, including unknown usage and original material', async () => {
    const store = new RecruitmentWorkspaceStore(); store.setCandidates([await candidate('a')]);
    const old = store.getSnapshot().candidates[0]!;
    store.setCandidates([{ ...old, transcriptText: '面试补充：独立维护自动化测试', semanticEvaluation: { ...old.semanticEvaluation!, summary: '面试回答支持交付经验', createdAt: '2026-09-08T00:01:00Z' } }]);
    const current = store.getSnapshot().candidates[0]!;
    render(<RecruitmentAnalysisHistoryPanel candidate={current} candidates={[current]} />);
    expect(screen.queryByText(/不计作免费/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看分析历史' }));
    expect(screen.getByText(/不计作免费/u)).toBeTruthy();
    expect(screen.getByText(/本版判断：面试回答支持交付经验/u)).toBeTruthy();
    expect(screen.getAllByText(/独立完成 React 企业应用上线和自动化测试/u).length).toBeGreaterThan(0);
    expect(screen.getByText(/实际费用以厂商账单为准/u)).toBeTruthy();
  });
  it('hides legacy scores in the UI and exported report', async () => {
    const a = await candidate('a'); const b = await candidate('b'); delete b.semanticEvaluation!.assessmentContext;
    const onExport = vi.fn();
    render(<RecruitmentComparisonPanel candidates={[a, b]} {...job} exporting={false} onExport={onExport} />);
    await screen.findByText('暂不比较分数');
    expect(screen.queryByText('81')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    expect(onExport.mock.calls[0][0]).toContain('缺少分析口径');
    expect(onExport.mock.calls[0][0]).not.toContain('| 81 |');
  });
  it('allows selecting an equivalent subset and immediately blocks stale exports after a job edit', async () => {
    const a = await candidate('a'); const b = await candidate('b'); const c = await candidate('c');
    c.semanticEvaluation!.assessmentContext!.modelId = 'other-model';
    const candidates = [a, b, c]; const onExport = vi.fn();
    const view = render(<RecruitmentComparisonPanel candidates={candidates} {...job} exporting={false} onExport={onExport} />);
    await screen.findByText('暂不比较分数');
    fireEvent.click(screen.getByLabelText('c.txt'));
    await waitFor(() => expect(screen.getAllByText('81')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '导出' })); expect(onExport.mock.calls[0][0]).toContain('| 81 |');
    view.rerender(<RecruitmentComparisonPanel candidates={candidates} {...job} jobDescription="新的要求" exporting={false} onExport={onExport} />);
    expect((screen.getByRole('button', { name: '导出' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('81')).toBeNull();
    await screen.findByText('暂不比较分数');
  });
  it('does not manufacture human verification; explicit records round trip and become stale on material changes', async () => {
    const store = new RecruitmentWorkspaceStore('org:hr'); store.setJobTitle(job.jobTitle); store.setJobDescription(job.jobDescription); store.setCandidates([await candidate('a')]);
    render(<ReviewHarness store={store} />);
    expect(screen.getByText('尚无人工逐项核实记录。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存逐项核实记录' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('人工核实结果'), { target: { value: 'supported' } });
    fireEvent.change(screen.getByLabelText('核实方式和依据'), { target: { value: '通过现场实战核实测试实现' } });
    // Wait for fingerprinting before making a fresh explicit confirmation.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    fireEvent.click(screen.getByLabelText('我已人工核实该条件，并对填写的依据负责'));
    await waitFor(() => expect((screen.getByRole('button', { name: '保存逐项核实记录' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '保存逐项核实记录' }));
    await screen.findByText('工程交付：人工核实记录 · 核实后支持');
    const item = store.getSnapshot().candidates[0];
    expect(parseRecruitmentCandidateDocument(JSON.stringify(item)).candidate.evidenceReviews).toHaveLength(1);
    expect(item.semanticEvaluation?.evidenceGraph?.[0].status).toBe('verified'); // human record does not alter model status
    act(() => store.setCandidates([{ ...item, transcriptText: '新增面试回答' }]));
    await screen.findByText('工程交付：旧核实记录，待重新复核');
    fireEvent.click(screen.getByRole('button', { name: '撤销我的核实记录' }));
    expect(store.getSnapshot().candidates[0].evidenceReviews).toEqual([]);
    expect(store.getSnapshot().audits.map((event) => event.action)).toEqual(['evidence-human-review', 'evidence-review-withdrawn']);
  });
  it('cannot save a review into a workspace that has switched underneath the panel', async () => {
    const item = await candidate('a'); const store = new RecruitmentWorkspaceStore('org:hr');
    store.setJobTitle(job.jobTitle); store.setJobDescription(job.jobDescription); store.setCandidates([item]);
    render(<RecruitmentEvidenceReviewPanel candidate={item} graph={item.semanticEvaluation!.evidenceGraph!} reviewerId="hr-1" store={store} {...job} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    fireEvent.change(screen.getByLabelText('核实方式和依据'), { target: { value: '通过现场实战核实测试实现' } });
    fireEvent.click(screen.getByLabelText('我已人工核实该条件，并对填写的依据负责'));
    store.setJobTitle('另一岗位');
    fireEvent.click(screen.getByRole('button', { name: '保存逐项核实记录' }));
    expect(store.getSnapshot().candidates[0].evidenceReviews).toBeUndefined();
    expect(screen.getByRole('alert').textContent).toContain('材料或岗位已变化');
  });
});
