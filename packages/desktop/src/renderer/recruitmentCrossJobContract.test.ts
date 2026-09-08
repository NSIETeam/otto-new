import { describe, expect, it } from 'vitest';
import { copyRecruitmentCandidate, type RecruitmentSharedJob } from 'otto-server';
import { analyzeCandidateResume } from './recruitmentAnalysis.js';
import { parseRecruitmentCandidateDocument } from './recruitmentArchive.js';
import type { CandidateWorkspace } from './recruitmentWorkspaceStore.js';

describe('server-copy to desktop-load document contract', () => {
  it('roundtrips a real desktop archive while keeping material and resetting role-specific state', () => {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 29 * 86_400_000).toISOString();
    const candidate: CandidateWorkspace = { id: 'old', fileName: 'resume.txt', sources: [], consentAt: now, retentionDays: 30, expiresAt,
      analysis: analyzeCandidateResume({ candidateId: 'old', resumeText: '电话：13800138000\n邮箱：person@example.test\n使用 React 完成企业系统', jobDescription: 'React' }),
      transcriptText: '面试回答内容', transcriptReport: null, transcriptWarning: '', workSampleText: '实战成果正文', decision: null, pipelineStage: 'interview',
    };
    const target: RecruitmentSharedJob = { id: 'target', title: '全栈', description: 'Node 与 React', revision: 1, candidates: [], collaboratorAccountIds: [], updatedAt: now, updatedBy: 'admin' };
    const copied = copyRecruitmentCandidate({ id: candidate.id, expiresAt, personId: 'person:known', document: JSON.stringify({ ...candidate, archiveVersion: 1, archiveAudits: [] }) }, target, now);
    const parsed = parseRecruitmentCandidateDocument(copied.document);
    expect(parsed.candidate.id).not.toBe(candidate.id);
    expect(parsed.candidate.analysis.candidateId).toBe(parsed.candidate.id);
    expect(parsed.candidate.analysis.redactedResume).toBe(candidate.analysis.redactedResume);
    expect(parsed.candidate).toMatchObject({ transcriptText: candidate.transcriptText, workSampleText: candidate.workSampleText, semanticEvaluation: null, decision: null, pipelineStage: 'new', consentAt: now, expiresAt });
    expect(parsed.audits).toMatchObject([{ candidateId: copied.id, action: 'cross_job_material_copy' }]);
  });
});
