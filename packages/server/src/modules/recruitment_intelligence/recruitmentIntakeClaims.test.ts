import { describe, expect, it } from 'vitest';
import { applyRecruitmentIntakeClaim, type RecruitmentIntakeClaimAction } from './recruitmentIntakeClaims.js';
import { recruitmentSyncMetadata } from './recruitmentCollaboration.js';
import type { RecruitmentSharedJob } from './recruitmentJobs.js';

const now = '2026-09-08T00:00:00Z';
function fixture() {
  const job: RecruitmentSharedJob = { id: 'job', title: '前端', description: 'React 企业研发', revision: 1, ownerAccountId: 'owner', collaboratorAccountIds: ['hr'], updatedAt: now, updatedBy: 'owner', candidates: [], incomingMaterials: [{ id: 'a'.repeat(64), receivedAt: now, expiresAt: '2026-09-09T00:00:00Z', material: { runId: 'run', canonicalId: 'person', requisitionId: 'job', contentHash: 'b'.repeat(64), acquisitionMode: 'authorized_mcp', retrievedAt: now, source: { sourceId: 'workable', sourceLabel: 'Workable', sourceRecordId: 'person' }, material: { sourceRecordId: 'person', text: 'React 企业研发、测试与交付有相关简历自述。', completeness: 'full_text' } } }] };
  const actor = { id: 'hr', organizationId: 'org', isAdmin: false, active: true };
  const action: RecruitmentIntakeClaimAction = { kind: 'claim_intake_analysis', jobId: job.id, itemId: 'a'.repeat(64), candidateId: 'candidate-1', requestId: 'request-1', confirmed: true, ...recruitmentSyncMetadata(job) };
  const claim = () => applyRecruitmentIntakeClaim(job, actor, action, now);
  return { job, actor, action, claim };
}
describe('shared intake analysis ownership', () => {
  it('lets an authorized HR claim once and start once; account/request substitution and repeated begin fail closed', () => {
    const h = fixture(); const claimed = h.claim(); const state = claimed.incomingMaterials![0]!.manualAnalysis!;
    expect(state.status).toBe('claimed'); expect(state.candidateId).toBe('candidate-1');
    expect(() => applyRecruitmentIntakeClaim(claimed, h.actor, h.action, now)).toThrow('认领');
    const start = { kind: 'start_intake_analysis' as const, jobId: h.job.id, itemId: h.action.itemId, claimId: state.id, requestId: 'request-1' };
    expect(() => applyRecruitmentIntakeClaim(claimed, { ...h.actor, id: 'owner' }, start, now)).toThrow();
    expect(() => applyRecruitmentIntakeClaim(claimed, h.actor, { ...start, requestId: 'another-device' }, now)).toThrow();
    const started = applyRecruitmentIntakeClaim(claimed, h.actor, start, now);
    expect(started.incomingMaterials![0]!.manualAnalysis!.status).toBe('started');
    expect(() => applyRecruitmentIntakeClaim(started, h.actor, start, now)).toThrow('启动');
    const done = applyRecruitmentIntakeClaim(started, h.actor, { ...start, kind: 'finish_intake_analysis', outcome: 'completed' }, now);
    expect(done.incomingMaterials![0]!.manualAnalysis!.status).toBe('completed');
  });
  it('blocks missing consent, expired/deleted/partial material, new standards and existing background attempts', () => {
    const h = fixture();
    expect(() => applyRecruitmentIntakeClaim(h.job, h.actor, { ...h.action, confirmed: false } as unknown as RecruitmentIntakeClaimAction, now)).toThrow('确认');
    expect(() => applyRecruitmentIntakeClaim({ ...h.job, title: '后端' }, h.actor, h.action, now)).toThrow('范围');
    expect(() => applyRecruitmentIntakeClaim({ ...h.job, incomingMaterials: [] }, h.actor, h.action, now)).toThrow();
    expect(() => applyRecruitmentIntakeClaim(h.job, h.actor, h.action, '2026-09-10T00:00:00Z')).toThrow();
    h.job.incomingMaterials![0]!.material.material.completeness = 'partial'; expect(h.claim).toThrow();
  });
  it('never automatically releases an expired claim and requires an exact, authorized human reset', () => {
    const h = fixture(); const claimed = h.claim(); const state = claimed.incomingMaterials![0]!.manualAnalysis!;
    const reset = { kind: 'reset_intake_analysis' as const, jobId: h.job.id, itemId: h.action.itemId, claimId: state.id, confirmed: true as const, ...recruitmentSyncMetadata(claimed) };
    expect(() => applyRecruitmentIntakeClaim(claimed, { ...h.actor, id: 'owner' }, reset, now)).toThrow('可能仍');
    expect(() => applyRecruitmentIntakeClaim(claimed, h.actor, reset, '2026-09-08T00:10:00Z')).toThrow('管理员');
    expect(() => applyRecruitmentIntakeClaim(claimed, h.actor, h.action, '2026-09-08T00:10:00Z')).toThrow('认领');
    const released = applyRecruitmentIntakeClaim(claimed, { ...h.actor, id: 'owner' }, reset, '2026-09-08T00:10:00Z');
    expect(released.incomingMaterials![0]!.manualAnalysis).toBeUndefined();
    expect(released.incomingMaterials![0]!.manualAnalysisHistory).toHaveLength(1);
    const newClaim = applyRecruitmentIntakeClaim(released, h.actor, h.action, '2026-09-08T00:10:00Z');
    expect(() => applyRecruitmentIntakeClaim(newClaim, h.actor, { kind: 'finish_intake_analysis', jobId: h.job.id, itemId: h.action.itemId, claimId: state.id, requestId: 'request-1', outcome: 'completed' }, '2026-09-08T00:10:00Z')).toThrow();
  });
  it('revokes an unused permit on changed standards or membership and cannot report a stale result as completed', () => {
    const h = fixture(); const claimed = h.claim(); const claim = claimed.incomingMaterials![0].manualAnalysis!;
    const action = { kind: 'start_intake_analysis' as const, jobId: 'job', itemId: h.action.itemId, claimId: claim.id, requestId: claim.requestId };
    expect(() => applyRecruitmentIntakeClaim({ ...claimed, description: '新的要求' }, h.actor, action, now)).toThrow('范围');
    expect(() => applyRecruitmentIntakeClaim({ ...claimed, collaboratorAccountIds: [] }, h.actor, action, now)).toThrow('访问');
    expect(() => applyRecruitmentIntakeClaim(claimed, { ...h.actor, active: false }, action, now)).toThrow('访问');
    const started = applyRecruitmentIntakeClaim(claimed, h.actor, action, now);
    const late = applyRecruitmentIntakeClaim({ ...started, description: '新的要求' }, h.actor, { ...action, kind: 'finish_intake_analysis', outcome: 'completed' }, now);
    expect(late.incomingMaterials![0].manualAnalysis?.status).toBe('unknown');
    expect(applyRecruitmentIntakeClaim(late, h.actor, { ...action, kind: 'finish_intake_analysis', outcome: 'completed' }, now)).toBe(late);
  });
});
