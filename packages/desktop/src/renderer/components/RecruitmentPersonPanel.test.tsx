import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RecruitmentJobResponse } from 'otto-server';
import { RecruitmentPersonPanel } from './RecruitmentPersonPanel.js';
import { RecruitmentWorkspaceStore, type CandidateWorkspace } from '../recruitmentWorkspaceStore.js';
import { recruitmentArchiveFingerprint } from '../recruitmentArchive.js';
import { analyzeCandidateResume } from '../recruitmentAnalysis.js';

function fixture() {
  const store = new RecruitmentWorkspaceStore('org:hr');
  const candidate: CandidateWorkspace = { id: 'c1', fileName: 'resume.txt', sources: [], consentAt: new Date().toISOString(), retentionDays: 30, expiresAt: new Date(Date.now() + 29 * 86_400_000).toISOString(), analysis: analyzeCandidateResume({ candidateId: 'c1', resumeText: 'React 开发经验', jobDescription: 'React' }), transcriptText: '', transcriptReport: null, transcriptWarning: '', decision: null };
  store.restoreSharedJob('source', 2, '前端', 'React', [candidate], []);
  store.setSharedJob({ id: 'source', revision: 2, savedFingerprint: recruitmentArchiveFingerprint(store.getSnapshot()) });
  return store;
}
const target = { id: 'target', title: '全栈工程师', description: 'Node', revision: 3, collaboratorAccountIds: ['hr'], updatedAt: '', updatedBy: 'admin', candidates: [] };
describe('cross-job candidate controls', () => {
  it('requires explicit sharing confirmation, copies to the selected revision and keeps the current workspace', async () => {
    const store = fixture();
    const before = store.getSnapshot();
    const call = vi.fn(async ({ action }) => (action.kind === 'list' ? { kind: 'list', jobs: [target], nextCursor: null, canManage: false } : { kind: 'job', job: { ...target, revision: 4 }, canManage: false }) as RecruitmentJobResponse);
    Object.assign(window.otto, { enterpriseRecruitmentJobs: call });
    render(<RecruitmentPersonPanel store={store} scopeId="org:hr" disabled={false} />);
    fireEvent.click(screen.getByText('关联其他岗位与复用资料'));
    fireEvent.click(screen.getByRole('button', { name: '选择目标岗位' }));
    await waitFor(() => expect(screen.getByRole('option', { name: '全栈工程师 · v3' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('复用到哪个岗位'), { target: { value: 'target' } });
    expect((screen.getByRole('button', { name: '确认复用到目标岗位' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我确认有权向目标岗位/));
    fireEvent.click(screen.getByRole('button', { name: '确认复用到目标岗位' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith({ scopeId: 'org:hr', action: { kind: 'copy_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 2, targetJobId: 'target', targetRevision: 3, sharingConfirmed: true } }));
    await waitFor(() => expect(screen.getByText(/全栈工程师.*待分析/)).toBeTruthy());
    expect(store.getSnapshot()).toBe(before);
  });
  it('keeps stage changes local until save and blocks copying unsaved work', () => {
    const store = fixture();
    render(<RecruitmentPersonPanel store={store} scopeId="org:hr" disabled={false} />);
    fireEvent.change(screen.getByLabelText('此岗位进展'), { target: { value: 'interview' } });
    expect(store.activeCandidate()?.pipelineStage).toBe('interview');
    fireEvent.click(screen.getByText('关联其他岗位与复用资料'));
    expect(screen.getByText(/请先保存当前岗位/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '查找已有岗位记录' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('never displays results belonging to the previous candidate/workspace', async () => {
    const store = fixture();
    let finish!: (result: RecruitmentJobResponse) => void;
    const call = vi.fn(() => new Promise<RecruitmentJobResponse>((resolve) => { finish = resolve; }));
    Object.assign(window.otto, { enterpriseRecruitmentJobs: call });
    render(<RecruitmentPersonPanel store={store} scopeId="org:hr" disabled={false} />);
    fireEvent.click(screen.getByText('关联其他岗位与复用资料'));
    fireEvent.click(screen.getByRole('button', { name: '查找已有岗位记录' }));
    act(() => store.resetWorkspace());
    await act(async () => finish({ kind: 'related', matches: [{ jobId: 'secret', jobTitle: '旧候选人的岗位', jobRevision: 1, candidateId: 'old', fileName: '', stage: 'new', reason: 'linked' }], nextCursor: null }));
    expect(screen.queryByText('旧候选人的岗位')).toBeNull();
  });
});
