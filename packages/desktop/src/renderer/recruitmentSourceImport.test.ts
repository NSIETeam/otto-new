import { describe, expect, it, vi } from 'vitest';
import type { RecruitmentMaterialResult } from 'otto-server';
import type { RecruitmentSemanticEvaluation, RecruitmentSemanticAnalysisInput } from '../main/recruitmentSemantic.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION } from '../main/recruitmentSemantic.js';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import { importRecruitmentSourceCandidate } from './recruitmentSourceImport.js';
import { captureRecruitmentAssessmentContext } from '../main/recruitmentAssessment.js';
import { sanitizeRecruitmentModelInput } from 'otto-server/recruitment';
import { withRecruitmentIntakeContext } from './recruitmentIntakeContext.js';

function fixture() {
  const store = new RecruitmentWorkspaceStore('org-a:hr-a');
  store.setJobTitle('前端工程师'); store.setJobDescription('负责 React 企业应用交付'); store.setConsentConfirmed(true);
  const source = { sourceId: 'official', sourceLabel: '企业授权人才库', sourceRecordId: 'person-1' };
  store.setSourceSearch({
    requisitionId: 'job-1', jobTitle: '前端工程师', jobDescription: '负责 React 企业应用交付',
    result: { runId: 'run-1', sources: [], candidates: [{
      canonicalId: 'canonical-1', displayName: '同名候选人', identityKeys: [], sourceCount: 1,
      sources: [source], fieldEvidence: {},
    }] },
  });
  const material: RecruitmentMaterialResult = {
    runId: 'run-1', requisitionId: 'job-1', canonicalId: 'canonical-1', source,
    contentHash: 'a'.repeat(64), acquisitionMode: 'authorized_api', retrievedAt: new Date().toISOString(),
    material: { sourceRecordId: 'person-1', fileName: 'resume.txt', completeness: 'full_text', text: '李明\n电话：13900139000\n邮箱：hr@example.com\n使用 React 开发企业应用，负责性能优化和测试，首屏耗时降低 30%。' },
  };
  const getMaterial = vi.fn(async () => structuredClone(material));
  const analyzeResume = vi.fn(async (_input: RecruitmentSemanticAnalysisInput) => ({
    summary: '有相关项目交付证据', overallScore: 75, matchLevel: 'good', evidenceCoverage: 80,
    dimensions: [], hardRequirements: [], strengths: ['交付'], risks: [], missingInformation: [],
    interviewQuestions: [], enterpriseContextUsed: false, analysisVersion: RECRUITMENT_SEMANTIC_ANALYSIS_VERSION,
    modelProvider: 'fixture', inputTokens: 10, outputTokens: 10, createdAt: new Date().toISOString(),
  } as RecruitmentSemanticEvaluation));
  const input = { store, canonicalId: 'canonical-1', sourceId: 'official', getMaterial, analyzeResume, enterpriseContext: '' };
  return { store, material, getMaterial, analyzeResume, input };
}

describe('source result → shared candidate workspace', () => {
  it('imports the explicitly scoped background result without requesting another model, and rejects stale standards', async () => {
    const h = fixture();
    const redactedResume = sanitizeRecruitmentModelInput(h.material.material.text);
    const evaluation = { ...await h.analyzeResume({} as RecruitmentSemanticAnalysisInput), assessmentContext: await captureRecruitmentAssessmentContext({ candidateId: 'one', jobTitle: '前端工程师', jobDescription: '负责 React 企业应用交付', redactedResume }, 'fixture'), execution: { runId: 'background-one', disposition: 'executed' as const, requestedAt: new Date().toISOString(), inputFingerprint: 'c'.repeat(64), inputTokens: 10, outputTokens: 10 } };
    h.analyzeResume.mockClear();
    h.store.setSharedJob({ id: 'job-1', revision: 1, savedFingerprint: '', base: {
      id: 'job-1', revision: 1, title: '前端工程师', description: '负责 React 企业应用交付', ownerAccountId: 'hr-a', collaboratorAccountIds: [], updatedAt: new Date().toISOString(), updatedBy: 'hr-a', candidates: [],
      incomingMaterials: [{ id: 'a'.repeat(64), receivedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), material: h.material,
        analysis: { status: 'completed', runId: 'background-one', attemptedAt: new Date().toISOString(), message: '简历自述支持', inputFingerprint: 'c'.repeat(64), modelVersion: 'profile', redactedResume, evaluation } }],
    } });
    const result = await importRecruitmentSourceCandidate({ ...h.input, incomingMaterialId: 'a'.repeat(64) });
    expect(result.status).toBe('unchanged'); expect(result.candidate.analysis.redactedResume).toBe(redactedResume);
    expect(result.candidate.semanticEvaluation?.execution?.runId).toBe('background-one');
    expect(h.analyzeResume).not.toHaveBeenCalled(); expect(h.getMaterial).not.toHaveBeenCalled();
    h.store.setJobDescription('改成后端开发');
    await expect(importRecruitmentSourceCandidate({ ...h.input, incomingMaterialId: 'a'.repeat(64) })).rejects.toThrow('后台结果');
    expect(h.analyzeResume).not.toHaveBeenCalled();
  });
  it('imports a retained shared inbox item without another platform fetch or search', async () => {
    const h = fixture(); h.store.setSourceSearch(null);
    const sync = { scopeToken: 'b'.repeat(64), headerToken: 'c'.repeat(64), candidateTokens: {} };
    h.store.setSharedJob({ id: 'job-1', revision: 1, savedFingerprint: '', sync, base: {
      id: 'job-1', revision: 1, title: '前端工程师', description: '负责 React 企业应用交付', ownerAccountId: 'hr-a', collaboratorAccountIds: [], updatedAt: new Date().toISOString(), updatedBy: 'hr-a', candidates: [],
      incomingMaterials: [{ id: 'a'.repeat(64), receivedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), material: h.material }],
    } });
    const result = await importRecruitmentSourceCandidate({ ...h.input, incomingMaterialId: 'a'.repeat(64) });
    expect(result.status).toBe('analyzed'); expect(h.getMaterial).not.toHaveBeenCalled();
    expect(h.analyzeResume).toHaveBeenCalledWith(expect.objectContaining({ sharedIntake: { scopeId: 'org-a:hr-a', jobId: 'job-1', itemId: 'a'.repeat(64), scopeToken: sync.scopeToken, headerToken: sync.headerToken } }));
    expect(h.store.getSnapshot().sourceSearch).toBeNull();
    expect(h.store.getSnapshot().sharedJob?.base?.incomingMaterials).toHaveLength(1); // Do not lose material before the candidate is shared.
    h.store.setSharedJob({ id: 'another-job', revision: 1, savedFingerprint: '' });
    await expect(importRecruitmentSourceCandidate({ ...h.input, incomingMaterialId: 'a'.repeat(64) })).rejects.toThrow();
    expect(h.analyzeResume).toHaveBeenCalledOnce();
  });
  it('requires claim coordination for initial analysis but allows explicit follow-up after its result has been retained', async () => {
    const h = fixture(); const result = await importRecruitmentSourceCandidate(h.input);
    const sync = { scopeToken: 'b'.repeat(64), headerToken: 'c'.repeat(64), candidateTokens: {} };
    const item = { id: 'a'.repeat(64), receivedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), material: h.material,
      manualAnalysis: { id: 'claim', requestId: 'request', candidateId: result.candidate.id, actorAccountId: 'hr-a', status: 'completed' as const, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), scopeToken: sync.scopeToken, headerToken: sync.headerToken, message: '已完成' } };
    h.store.setSharedJob({ id: 'job-1', revision: 1, savedFingerprint: '', sync, base: { id: 'job-1', revision: 1, title: '前端工程师', description: '负责 React 企业应用交付', collaboratorAccountIds: [], updatedAt: '', updatedBy: '', candidates: [], incomingMaterials: [item] } });
    const input = { candidateId: result.candidate.id, jobTitle: '前端工程师', jobDescription: '负责 React 企业应用交付', redactedResume: result.candidate.analysis.redactedResume, interviewTranscript: '新面试记录' };
    expect(withRecruitmentIntakeContext(h.store, input).sharedIntake).toBeDefined();
    h.store.setCandidates((entries) => entries.map((entry) => ({ ...entry, semanticEvaluation: { ...entry.semanticEvaluation!, coordination: { claimId: 'claim', status: 'recorded', message: '已登记' } } })));
    expect(withRecruitmentIntakeContext(h.store, input)).toBe(input);
    await expect(importRecruitmentSourceCandidate({ ...h.input, incomingMaterialId: item.id })).rejects.toThrow('认领');
    expect(h.analyzeResume).toHaveBeenCalledOnce();
  });
  it('does not reuse results from old analysis rules after an upgrade', async () => {
    const h = fixture(); await importRecruitmentSourceCandidate(h.input);
    h.store.activeCandidate()!.semanticEvaluation!.analysisVersion = 'otto-recruitment-semantic-v3.0';
    await importRecruitmentSourceCandidate(h.input);
    expect(h.analyzeResume).toHaveBeenCalledTimes(2);
    expect(h.store.activeCandidate()!.sourceHistory?.[0].evaluation?.analysisVersion).toBe('otto-recruitment-semantic-v3.0');
  });
  it('retains changed attachment evidence while reusing analysis when extracted text is unchanged', async () => {
    const h = fixture();
    h.material.material.attachment = { sha256: 'a'.repeat(64), bytes: 500, format: 'pdf', pages: 1, extractorVersion: 'otto-resume-v1' };
    await importRecruitmentSourceCandidate(h.input);
    h.analyzeResume.mockResolvedValueOnce({ ...h.store.activeCandidate()!.semanticEvaluation!, execution: {
      runId: 'reused-run', disposition: 'reused', requestedAt: new Date().toISOString(), inputFingerprint: 'a'.repeat(64), inputTokens: 10, outputTokens: 10,
    } });
    h.material.material.attachment.sha256 = 'b'.repeat(64);
    const result = await importRecruitmentSourceCandidate(h.input);
    expect(result.status).toBe('unchanged');
    expect(result.candidate.sourceMaterial?.material.attachment?.sha256).toBe('b'.repeat(64));
    expect(result.candidate.sourceHistory?.[0].material.material.attachment?.sha256).toBe('a'.repeat(64));
    expect(h.analyzeResume).toHaveBeenCalledTimes(2); // Both requests reach the common boundary; only it knows current model settings.
    expect(h.store.getSnapshot().candidates).toHaveLength(1);
  });
  it('leaves a previous complete dossier and analysis untouched when a new attachment download fails', async () => {
    const h = fixture(); await importRecruitmentSourceCandidate(h.input);
    const previous = h.store.activeCandidate();
    h.getMaterial.mockRejectedValueOnce(new Error('简历下载失败'));
    await expect(importRecruitmentSourceCandidate(h.input)).rejects.toThrow(/下载/);
    expect(h.store.activeCandidate()).toBe(previous);
    expect(h.analyzeResume).toHaveBeenCalledOnce();
  });
  it('imports full text, retains its source and isolates contact data before model analysis', async () => {
    const h = fixture();
    const result = await importRecruitmentSourceCandidate(h.input);
    expect(result.status).toBe('analyzed');
    expect(h.store.activeCandidate()?.sourceMaterial?.material.text).toContain('13900139000');
    expect(h.analyzeResume.mock.calls[0]?.[0]).not.toBeUndefined();
    expect(JSON.stringify(h.analyzeResume.mock.calls)).not.toContain('13900139000');
    expect(JSON.stringify(h.analyzeResume.mock.calls)).not.toContain('hr@example.com');
    expect(h.store.activeCandidate()?.sources[0]).toMatchObject({ providerId: 'official', sourceRecordId: 'person-1' });
  });

  it('reuses unchanged material without another model call, including concurrent clicks', async () => {
    const h = fixture();
    await Promise.all([importRecruitmentSourceCandidate(h.input), importRecruitmentSourceCandidate(h.input)]);
    expect(h.getMaterial).toHaveBeenCalledOnce(); expect(h.analyzeResume).toHaveBeenCalledOnce();
    h.analyzeResume.mockResolvedValueOnce({ ...h.store.activeCandidate()!.semanticEvaluation!, execution: {
      runId: 'reused-run', disposition: 'reused', requestedAt: new Date().toISOString(), inputFingerprint: 'a'.repeat(64), inputTokens: 10, outputTokens: 10,
    } });
    expect((await importRecruitmentSourceCandidate(h.input)).status).toBe('unchanged');
    expect(h.analyzeResume).toHaveBeenCalledTimes(2); expect(h.store.getSnapshot().candidates).toHaveLength(1);
  });

  it('checks the common boundary again when only the configured model has changed', async () => {
    const h = fixture(); await importRecruitmentSourceCandidate(h.input);
    h.analyzeResume.mockResolvedValueOnce({ ...h.store.activeCandidate()!.semanticEvaluation!, modelProvider: 'new-provider', createdAt: '2026-09-09T00:00:00Z' });
    expect((await importRecruitmentSourceCandidate(h.input)).status).toBe('analyzed');
    expect(h.analyzeResume).toHaveBeenCalledTimes(2);
    expect(h.store.activeCandidate()?.analysisHistory).toHaveLength(2);
  });

  it.each(['partial', 'unavailable'] as const)('keeps %s material visibly incomplete and does not spend model tokens', async (completeness) => {
    const h = fixture(); h.material.material.completeness = completeness;
    if (completeness === 'unavailable') h.material.material.text = '';
    const result = await importRecruitmentSourceCandidate(h.input);
    expect(result.status).toBe('incomplete'); expect(h.analyzeResume).not.toHaveBeenCalled();
    expect(h.store.activeCandidate()?.semanticEvaluation).toBeNull();
    expect(h.store.activeCandidate()?.semanticError).toMatch(/资料|正文/u);
  });

  it('preserves previous text and evaluation when material changes', async () => {
    const h = fixture(); await importRecruitmentSourceCandidate(h.input);
    h.material.material.text += '\n补充：负责 Electron 桌面端异常恢复。'; h.material.contentHash = 'b'.repeat(64);
    await importRecruitmentSourceCandidate(h.input);
    expect(h.store.getSnapshot().candidates).toHaveLength(1);
    expect(h.store.activeCandidate()?.sourceHistory).toHaveLength(1);
    expect(h.store.activeCandidate()?.sourceHistory?.[0]?.evaluation?.summary).toBe('有相关项目交付证据');
    expect(h.analyzeResume).toHaveBeenCalledTimes(2);
  });

  it('does not confuse equal names with the same person', async () => {
    const h = fixture(); await importRecruitmentSourceCandidate(h.input);
    const search = structuredClone(h.store.getSnapshot().sourceSearch!);
    search.result.candidates[0]!.canonicalId = 'canonical-2'; search.result.candidates[0]!.sources[0]!.sourceRecordId = 'person-2';
    h.store.setSourceSearch(search);
    h.material.canonicalId = 'canonical-2'; h.material.source.sourceRecordId = 'person-2'; h.material.material.sourceRecordId = 'person-2';
    await importRecruitmentSourceCandidate({ ...h.input, canonicalId: 'canonical-2' });
    expect(h.store.getSnapshot().candidates).toHaveLength(2);
  });

  it('retains the draft on a model failure and retries analysis without duplicating the candidate', async () => {
    const h = fixture(); h.analyzeResume.mockRejectedValueOnce(new Error('model unavailable'));
    expect((await importRecruitmentSourceCandidate(h.input)).status).toBe('analysis_failed');
    expect(h.store.activeCandidate()?.sourceMaterial).toBeTruthy();
    expect((await importRecruitmentSourceCandidate(h.input)).status).toBe('analyzed');
    expect(h.store.getSnapshot().candidates).toHaveLength(1);
  });

  it('requires consent before reading any private material', async () => {
    const h = fixture(); h.store.setConsentConfirmed(false);
    await expect(importRecruitmentSourceCandidate(h.input)).rejects.toThrow(/授权/u);
    expect(h.getMaterial).not.toHaveBeenCalled();
  });

  it('rejects stale job results and mismatched connector responses', async () => {
    const h = fixture(); h.material.canonicalId = 'wrong';
    await expect(importRecruitmentSourceCandidate(h.input)).rejects.toThrow(/匹配/u);
    expect(h.analyzeResume).not.toHaveBeenCalled();
    h.store.setJobDescription('完全不同的岗位');
    await expect(importRecruitmentSourceCandidate(h.input)).rejects.toThrow(/检索/u);
  });

  it('discards late results after a job switch or a cancellation', async () => {
    const h = fixture();
    h.getMaterial.mockImplementation(async () => { h.store.setJobDescription('新岗位'); return h.material; });
    await expect(importRecruitmentSourceCandidate(h.input)).rejects.toThrow(/变化/u);
    expect(h.store.getSnapshot().candidates).toHaveLength(0); expect(h.analyzeResume).not.toHaveBeenCalled();
    const second = fixture();
    await expect(importRecruitmentSourceCandidate({ ...second.input, signal: AbortSignal.abort() })).rejects.toThrow(/取消/u);
    expect(second.getMaterial).not.toHaveBeenCalled();
  });

  it('does not resurrect a candidate deleted during analysis', async () => {
    const h = fixture();
    h.analyzeResume.mockImplementationOnce(async () => { h.store.setCandidates([]); return { summary: 'late' } as RecruitmentSemanticEvaluation; });
    await expect(importRecruitmentSourceCandidate(h.input)).rejects.toThrow(/变化|清除/u);
    expect(h.store.getSnapshot().candidates).toHaveLength(0);
  });

  it('does not resurrect an existing candidate deleted while a new material read is in flight', async () => {
    const h = fixture(); await importRecruitmentSourceCandidate(h.input);
    h.getMaterial.mockImplementationOnce(async () => { h.store.setCandidates([]); return h.material; });
    await expect(importRecruitmentSourceCandidate(h.input)).rejects.toThrow(/变化|清除/u);
    expect(h.store.getSnapshot().candidates).toHaveLength(0);
  });

  it('keeps the previous evaluation when company criteria change even if the resume did not change', async () => {
    const h = fixture(); await importRecruitmentSourceCandidate(h.input);
    await importRecruitmentSourceCandidate({ ...h.input, enterpriseContext: '新增交付标准：必须提供测试依据' });
    expect(h.store.activeCandidate()?.sourceHistory).toHaveLength(1);
    expect(h.analyzeResume).toHaveBeenCalledTimes(2);
  });
});
