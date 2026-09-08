import { describe, expect, it, vi } from 'vitest';
import { coordinateRecruitmentIntakeAnalysis } from './recruitmentIntakeCoordinator.js';
import type { RecruitmentJobAction, RecruitmentJobResponse } from 'otto-server';
import type { RecruitmentSemanticAnalysisInput, RecruitmentSemanticEvaluation } from './recruitmentSemantic.js';

function fixture() {
  const context = { scopeId: 'org:hr', jobId: 'job', itemId: 'a'.repeat(64), scopeToken: 'b'.repeat(64), headerToken: 'c'.repeat(64) };
  const input: RecruitmentSemanticAnalysisInput = { candidateId: 'candidate', jobTitle: '前端', jobDescription: 'React', redactedResume: 'React 开发交付与自动化测试相关简历正文', sharedIntake: context };
  const evaluation = { summary: '有简历自述支持' } as RecruitmentSemanticEvaluation;
  const analyze = vi.fn(async () => evaluation); let valid = true;
  const call = vi.fn(async (action: RecruitmentJobAction): Promise<RecruitmentJobResponse> => ({ kind: 'job', canManage: false,
    job: { id: 'job', title: '前端', description: 'React', revision: 2, candidates: [], collaboratorAccountIds: ['hr'], updatedAt: new Date().toISOString(), updatedBy: 'hr', incomingMaterials: [{ id: context.itemId, receivedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), material: {} as never,
      manualAnalysis: { id: 'claim-1', requestId: 'requestId' in action ? action.requestId : '', candidateId: input.candidateId, actorAccountId: 'hr', scopeToken: context.scopeToken, headerToken: context.headerToken, status: action.kind === 'claim_intake_analysis' ? 'claimed' : action.kind === 'start_intake_analysis' ? 'started' : 'completed', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 180000).toISOString(), message: 'test' } }] } }));
  const options = { analyze, call, assertScope: () => { if (!valid) throw new Error('账号变化'); }, getSessionKey: () => valid ? 'session-1' : 'session-2' };
  return { input, evaluation, options, analyze, call, invalidate: () => { valid = false; } };
}
describe('main-process intake coordinator', () => {
  it('claims, consumes the start permit, then invokes the model and reports completion', async () => {
    const h = fixture(); await coordinateRecruitmentIntakeAnalysis(h.input, h.options);
    expect(h.call.mock.calls.map(([action]) => action.kind)).toEqual(['claim_intake_analysis', 'start_intake_analysis', 'finish_intake_analysis']);
    expect(h.analyze).toHaveBeenCalledOnce();
    expect(h.call.mock.invocationCallOrder[1]).toBeLessThan(h.analyze.mock.invocationCallOrder[0]!);
    expect(h.analyze.mock.invocationCallOrder[0]).toBeLessThan(h.call.mock.invocationCallOrder[2]!);
  });
  it('never falls back to a model call when claim/start is denied or its response is lost', async () => {
    for (const phase of ['claim_intake_analysis', 'start_intake_analysis']) {
      const h = fixture(); const normal = h.call.getMockImplementation()!;
      h.call.mockImplementation(async (action) => { if (action.kind === phase) throw new Error('连接未确认'); return normal(action); });
      await expect(coordinateRecruitmentIntakeAnalysis(h.input, h.options)).rejects.toThrow(); expect(h.analyze).not.toHaveBeenCalled();
    }
  });
  it('marks model failure unknown, keeps useful results on finish failure, and prevents cross-account writeback', async () => {
    const h = fixture(); h.analyze.mockRejectedValueOnce(new Error('model failed'));
    await expect(coordinateRecruitmentIntakeAnalysis(h.input, h.options)).rejects.toThrow('model failed');
    expect(h.call.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'finish_intake_analysis', outcome: 'unknown' });
    const good = fixture(); const normal = good.call.getMockImplementation()!;
    good.call.mockImplementation(async (action) => { if (action.kind === 'finish_intake_analysis') throw new Error('offline'); return normal(action); });
    expect((await coordinateRecruitmentIntakeAnalysis(good.input, good.options)).coordination?.status).toBe('unconfirmed');
    const changed = fixture(); changed.analyze.mockImplementationOnce(async () => { changed.invalidate(); return changed.evaluation; });
    await expect(coordinateRecruitmentIntakeAnalysis(changed.input, changed.options)).rejects.toThrow('账号');
    expect(changed.call).toHaveBeenCalledTimes(2);
  });
  it('keeps unshared local analysis usable without contacting a server', async () => {
    const h = fixture(); await coordinateRecruitmentIntakeAnalysis({ ...h.input, sharedIntake: undefined }, h.options);
    expect(h.analyze).toHaveBeenCalledOnce(); expect(h.call).not.toHaveBeenCalled();
  });
  it('rejects malformed or mismatched grants before invoking the model', async () => {
    for (const mutation of ['job', 'claim', 'deadline', 'request']) {
      const h = fixture(); const normal = h.call.getMockImplementation()!;
      h.call.mockImplementation(async (action) => {
        const response = await normal(action); if (response.kind !== 'job') throw new Error();
        if (action.kind === 'start_intake_analysis') {
          const claim = response.job.incomingMaterials![0].manualAnalysis!;
          if (mutation === 'job') response.job.title = '另一个岗位';
          if (mutation === 'claim') claim.id = '';
          if (mutation === 'deadline') claim.expiresAt = 'not-a-date';
          if (mutation === 'request') claim.requestId = 'another-request';
        }
        return response;
      });
      await expect(coordinateRecruitmentIntakeAnalysis(h.input, h.options)).rejects.toThrow();
      expect(h.analyze).not.toHaveBeenCalled();
    }
  });
  it('discards results after an explicit permission denial or a changed job, instead of treating either as temporary offline', async () => {
    for (const reason of ['revoked', 'changed']) {
      const h = fixture(); const normal = h.call.getMockImplementation()!;
      h.call.mockImplementation(async (action) => {
        if (action.kind === 'finish_intake_analysis' && reason === 'revoked') throw Object.assign(new Error('已撤销岗位权限'), { status: 403 });
        const response = await normal(action);
        if (action.kind === 'finish_intake_analysis' && response.kind === 'job') response.job.description = '新岗位要求';
        return response;
      });
      await expect(coordinateRecruitmentIntakeAnalysis(h.input, h.options)).rejects.toThrow();
      expect(h.analyze).toHaveBeenCalledOnce();
    }
  });
});
