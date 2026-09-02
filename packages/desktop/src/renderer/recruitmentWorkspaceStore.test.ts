/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';

describe('招聘共享工作区', () => {
  it('让右侧工作台与对话读取同一份岗位和候选人状态', () => {
    const store = new RecruitmentWorkspaceStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setJobTitle('高级前端工程师');
    store.setJobDescription('五年前端经验，熟悉 React');
    store.setConsentConfirmed(true);

    expect(store.getSnapshot()).toMatchObject({
      jobTitle: '高级前端工程师',
      jobDescription: '五年前端经验，熟悉 React',
      consentConfirmed: true,
    });
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('按保存期限清除候选人并留下审计记录', () => {
    const store = new RecruitmentWorkspaceStore();
    store.setCandidates([{
      id: 'candidate-1', fileName: 'resume.pdf', consentAt: '2026-08-01T00:00:00Z',
      retentionDays: 7, expiresAt: '2026-08-08T00:00:00Z',
      analysis: {
        candidateId: 'candidate-1', identity: {}, redactedResume: '经验', findings: [],
        skills: [], timeline: [], experiences: [], projects: [], questions: [],
        engineVersion: 'test', createdAt: '2026-08-01T00:00:00Z',
      },
      transcriptText: '', transcriptReport: null, transcriptWarning: '', decision: null,
    }]);
    store.setActiveCandidateId('candidate-1');

    const expired = store.purgeExpired(Date.parse('2026-09-01T00:00:00Z'));
    expect(expired).toHaveLength(1);
    expect(store.getSnapshot().candidates).toHaveLength(0);
    expect(store.getSnapshot().activeCandidateId).toBe('');
    expect(store.getSnapshot().audits[0]?.action).toBe('retention_expired');
  });

  it('不同账号使用不同实例，不共享候选人隐私数据', () => {
    const first = new RecruitmentWorkspaceStore();
    const second = new RecruitmentWorkspaceStore();
    first.setJobTitle('岗位A');
    expect(second.getSnapshot().jobTitle).toBe('');
  });
});
