import { describe, expect, it, vi } from 'vitest';
import { readWorkableAcceptanceApproval, probeWorkableMaterial } from './workableAcceptance.js';
import type { RecruitmentSourceAdapter } from './recruitmentSourceGateway.js';

const scope = { organizationId: 'org', actorAccountId: 'hr', requisitionId: 'job' };
const now = Date.parse('2026-09-08T00:00:00Z');
const permit = { organizationId: 'org', actorAccountId: 'hr', jobId: 'job', expiresAt: '2026-09-09T00:00:00Z', approvalReference: 'approved-test-only' };
const env = (entry = permit) => ({ OTTO_WORKABLE_ACCEPTANCE_SCOPES: JSON.stringify([entry]) });
describe('bounded real-account material acceptance', () => {
  it('requires an exact, time-limited enterprise, actor and job allowlist; production approval alone is not permission', () => {
    expect(readWorkableAcceptanceApproval({}, scope, now)).toBeNull();
    expect(readWorkableAcceptanceApproval({ OTTO_WORKABLE_REAL_ACCOUNT_VERIFIED: '1' }, scope, now)).toBeNull();
    expect(readWorkableAcceptanceApproval(env(), scope, now)?.approvalFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    for (const patch of [{ organizationId: '*' }, { actorAccountId: 'other' }, { jobId: 'other' }, { expiresAt: '2099-01-01' }, { expiresAt: '2026-09-07' }, { approvalReference: '' }]) expect(readWorkableAcceptanceApproval(env({ ...permit, ...patch }), scope, now)).toBeNull();
    expect(readWorkableAcceptanceApproval({ OTTO_WORKABLE_ACCEPTANCE_SCOPES: 'private-broken-json' }, scope, now)).toBeNull();
  });
  function setup(completeness: 'full_text' | 'partial' = 'full_text') {
    const search = vi.fn(async () => ({ candidates: [{ sourceRecordId: 'private-record', displayName: '私人姓名', identityKeys: [] }], hasMore: true }));
    const getCandidate = vi.fn(async () => ({ sourceRecordId: 'private-record', text: '电话号码 13800138000，测试简历正文与项目内容', completeness }));
    const adapter: RecruitmentSourceAdapter = { id: 'workable', label: 'Workable', capabilities: ['search_candidates', 'get_candidate'], search, getCandidate };
    const assertAuthorized = vi.fn(async () => undefined);
    return { search, getCandidate, assertAuthorized, run: () => probeWorkableMaterial({ adapter, scope, assertAuthorized, signal: new AbortController().signal, now: () => now }) };
  }
  it('reads at most one candidate, follows no next page, and returns metadata rather than personal material', async () => {
    const h = setup(); const report = await h.run();
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ ...scope, limit: 1 }), expect.anything());
    expect(h.search).toHaveBeenCalledOnce(); expect(h.getCandidate).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ status: 'full_text', candidatesRead: 1, modelInvoked: false, productionAccepted: false });
    expect(JSON.stringify(report)).not.toMatch(/私人姓名|13800138000|private-record|项目内容/u);
  });
  it('does not label partial material or an empty job as full-text acceptance', async () => {
    const h = setup('partial'); expect((await h.run()).status).toBe('partial');
    h.search.mockResolvedValue({ candidates: [], hasMore: false }); h.getCandidate.mockClear();
    expect((await h.run()).status).toBe('empty'); expect(h.getCandidate).not.toHaveBeenCalled();
  });
  it('rejects over-return, revocation and upstream errors without exposing private errors', async () => {
    const h = setup(); h.search.mockResolvedValue({ candidates: [{ sourceRecordId: '1', displayName: 'a', identityKeys: [] }, { sourceRecordId: '2', displayName: 'b', identityKeys: [] }], hasMore: true });
    await expect(h.run()).rejects.toThrow(); expect(h.getCandidate).not.toHaveBeenCalled();
    const revoked = setup(); revoked.assertAuthorized.mockRejectedValueOnce(new Error('secret-token'));
    await expect(revoked.run()).rejects.toThrow('验收读取未完成'); expect(revoked.search).not.toHaveBeenCalled();
    const failed = setup(); failed.getCandidate.mockRejectedValueOnce(new Error('private signed-url'));
    await expect(failed.run()).rejects.toThrow('验收读取未完成');
  });
});
