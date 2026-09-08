import { describe, expect, it, vi } from 'vitest';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import { analyzeCandidateResume } from './recruitmentAnalysis.js';
import { saveRecruitmentArchive, loadRecruitmentArchive, parseRecruitmentCandidateDocument } from './recruitmentArchive.js';
import type { CandidateWorkspace } from './recruitmentWorkspaceStore.js';
import type { RecruitmentJobResponse } from 'otto-server';

const candidate = (): CandidateWorkspace => ({ id: 'c1', fileName: 'resume.txt', sources: [], consentAt: new Date().toISOString(), retentionDays: 30, expiresAt: new Date(Date.now() + 29 * 86_400_000).toISOString(), analysis: analyzeCandidateResume({ candidateId: 'c1', resumeText: '拥有 React 开发经验并完成交付', jobDescription: 'React' }), transcriptText: '', transcriptReport: null, transcriptWarning: '', decision: null });
function fixture() {
  const store = new RecruitmentWorkspaceStore('org:hr');
  store.setJobTitle('前端'); store.setJobDescription('React'); store.setCandidates([candidate()]);
  return store;
}
describe('recruitment archive desktop boundary', () => {
  it('round trips human annotations and rejects forged or malformed annotation structure', () => {
    const review = { binding: 'a'.repeat(64), criterion: '交付能力', reviewerId: 'hr-1', actorType: 'human', outcome: 'supported', rationale: '现场核实测试过程', createdAt: new Date().toISOString() };
    const item = { ...candidate(), evidenceReviews: [review] };
    expect(parseRecruitmentCandidateDocument(JSON.stringify(item)).candidate.evidenceReviews).toEqual([review]);
    for (const changed of [{ actorType: 'model' }, { binding: 'bad' }, { outcome: 'verified' }, { rationale: null }]) {
      expect(() => parseRecruitmentCandidateDocument(JSON.stringify({ ...item, evidenceReviews: [{ ...review, ...changed }] }))).toThrow('档案格式');
    }
  });
  it('requires separate enterprise sharing confirmation before sending any material', async () => {
    const call = vi.fn();
    await expect(saveRecruitmentArchive(fixture(), call, false)).rejects.toThrow('确认');
    expect(call).not.toHaveBeenCalled();
  });
  it('saves current candidates and analysis without another model call, retaining revision for later saves', async () => {
    const store = fixture();
    const call = vi.fn(async (action) => ({ kind: 'job', canManage: true, job: { id: action.jobId, title: action.title, description: action.description, candidates: action.candidates, revision: 1, updatedAt: new Date().toISOString(), updatedBy: 'hr', collaboratorAccountIds: [] } }) as RecruitmentJobResponse);
    await saveRecruitmentArchive(store, call, true);
    expect(store.getSnapshot().sharedJob?.revision).toBe(1);
    expect(JSON.parse(call.mock.calls[0]![0].candidates[0].document).analysis.redactedResume).toContain('React');
  });
  it('does not overwrite edits made while loading another job', async () => {
    const store = fixture();
    const before = store.getSnapshot();
    const call = vi.fn(async () => { store.setJobDescription('用户刚修改'); return { kind: 'job', canManage: true, job: { id: 'j1', revision: 1, title: '另一岗位', description: '', candidates: [], updatedBy: 'hr', updatedAt: new Date().toISOString(), collaboratorAccountIds: [] } } as RecruitmentJobResponse; });
    await expect(loadRecruitmentArchive(store, call, 'j1')).rejects.toThrow('已变化');
    expect(store.getSnapshot().candidates).toBe(before.candidates);
  });
  it('loads atomically, resets consent and clears old source-search context', async () => {
    const store = fixture();
    const item = candidate();
    const call = vi.fn(async () => ({ kind: 'job', canManage: false, job: { id: 'j1', revision: 3, title: '后端', description: 'Node', candidates: [{ id: item.id, expiresAt: item.expiresAt, document: JSON.stringify(item) }], updatedBy: 'admin', updatedAt: new Date().toISOString(), collaboratorAccountIds: ['hr'] } }) as RecruitmentJobResponse);
    await loadRecruitmentArchive(store, call, 'j1');
    expect(store.getSnapshot()).toMatchObject({ jobTitle: '后端', consentConfirmed: false, sourceSearch: null, sharedJob: { id: 'j1', revision: 3 } });
    expect(store.getSnapshot().candidates[0]).toEqual(item);
  });
  it('rejects malformed nested analysis and incomplete schema rather than crashing the workbench', () => {
    expect(() => parseRecruitmentCandidateDocument(JSON.stringify({ ...candidate(), analysis: { skills: null } }))).toThrow('档案格式');
    expect(() => parseRecruitmentCandidateDocument(JSON.stringify({ ...candidate(), semanticEvaluation: { summary: 'fake' } }))).toThrow('档案格式');
    expect(parseRecruitmentCandidateDocument(JSON.stringify(candidate())).candidate.fileName).toBe('resume.txt');
  });
  it('does not apply results after cancellation', async () => {
    const store = fixture();
    const controller = new AbortController();
    const call = vi.fn(async () => { controller.abort(); return { kind: 'job' } as RecruitmentJobResponse; });
    await expect(loadRecruitmentArchive(store, call, 'j1', controller.signal)).rejects.toThrow('取消');
    expect(store.getSnapshot().sharedJob).toBeNull();
  });
});
