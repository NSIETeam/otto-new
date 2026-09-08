import { expect, it } from 'vitest';
import { captureRecruitmentAnalysisGuard } from './recruitmentAnalysisGuard.js';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import { analyzeCandidateResume } from './recruitmentAnalysis.js';

it('accepts an archive acknowledgement but rejects changed candidates, jobs and workspace replacement', () => {
  const store = new RecruitmentWorkspaceStore(); store.setJobTitle('前端'); store.setJobDescription('React');
  store.setCandidates([{ id: 'a', fileName: 'a.txt', sources: [], consentAt: new Date().toISOString(), retentionDays: 30, expiresAt: new Date(Date.now() + 86400000).toISOString(), analysis: analyzeCandidateResume({ candidateId: 'a', resumeText: 'React开发', jobDescription: 'React' }), transcriptText: '', transcriptReport: null, transcriptWarning: '', decision: null }]);
  const guard = captureRecruitmentAnalysisGuard(store, 'a'); store.setCandidates(structuredClone(store.getSnapshot().candidates)); store.setSharedJob({ id: 'job', revision: 1, savedFingerprint: '' });
  expect(() => guard.assertCurrent()).not.toThrow();
  store.setCandidates((items) => items.map((item) => ({ ...item, workSampleText: '同事补充的材料' })));
  expect(() => guard.assertCurrent()).toThrow('材料已变化');
  const next = captureRecruitmentAnalysisGuard(store, 'a'); store.setJobDescription('Rust'); expect(next.isCurrent()).toBe(false);
  const local = captureRecruitmentAnalysisGuard(store); store.resetWorkspace(); expect(() => local.assertCurrent()).toThrow('材料已变化');
});
