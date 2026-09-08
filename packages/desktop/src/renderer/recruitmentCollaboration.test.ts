import { describe, expect, it, vi } from 'vitest';
import type { RecruitmentJobResponse, RecruitmentSharedJob } from 'otto-server';
import { recruitmentSyncMetadata, RecruitmentJobService, type RecruitmentJobStore } from 'otto-server';
import { RecruitmentWorkspaceStore, type CandidateWorkspace } from './recruitmentWorkspaceStore.js';
import { analyzeCandidateResume } from './recruitmentAnalysis.js';
import { loadRecruitmentArchive, saveRecruitmentArchive, recruitmentArchiveFingerprint, refreshRecruitmentArchive } from './recruitmentArchive.js';

function candidate(id: string): CandidateWorkspace {
  return { id, fileName: `${id}.txt`, sources: [], consentAt: new Date().toISOString(), retentionDays: 30, expiresAt: new Date(Date.now() + 29 * 86400000).toISOString(), analysis: analyzeCandidateResume({ candidateId: id, resumeText: 'React 项目开发与交付经验', jobDescription: 'React' }), transcriptText: '', transcriptReport: null, transcriptWarning: '', decision: null };
}
function setup() {
  let job: RecruitmentSharedJob | null = null;
  const repository: RecruitmentJobStore = { get: async () => structuredClone(job), list: async () => ({ jobs: [], nextCursor: null }), remove: async () => false,
    compareAndSet: async (_org, revision, next) => { if ((job?.revision ?? 0) !== revision) return false; job = structuredClone(next); return true; } };
  const service = new RecruitmentJobService({ store: repository, getActor: async (id) => ({ id, organizationId: 'org', active: true, isAdmin: true }) });
  const call = vi.fn((action: Parameters<RecruitmentJobService['act']>[1]) => service.act('hr', action));
  const store = new RecruitmentWorkspaceStore('org:hr');
  store.setJobTitle('前端'); store.setJobDescription('React'); store.setCandidates([candidate('a'), candidate('b')]);
  return { store, call, service, job: () => job! };
}
const edit = (store: RecruitmentWorkspaceStore, id: string, name: string) => store.setCandidates((items) => items.map((item) => item.id === id ? { ...item, fileName: name } : item));
const dirty = (store: RecruitmentWorkspaceStore) => recruitmentArchiveFingerprint(store.getSnapshot()) !== store.getSnapshot().sharedJob?.savedFingerprint;

describe('incremental archive collaboration', () => {
  it('sends only changed candidates and incorporates another colleague’s updates without a model call', async () => {
    const { store, call } = setup(); await saveRecruitmentArchive(store, call, true);
    const other = new RecruitmentWorkspaceStore('org:other'); await loadRecruitmentArchive(other, call, store.getSnapshot().sharedJob!.id);
    edit(store, 'a', 'local-a'); edit(other, 'b', 'remote-b');
    await saveRecruitmentArchive(other, call, true); await saveRecruitmentArchive(store, call, true);
    expect(call.mock.lastCall?.[0]).toMatchObject({ kind: 'patch', changes: [{ id: 'a' }] });
    expect(store.getSnapshot().candidates.map((item) => item.fileName)).toEqual(['local-a', 'remote-b']);
    expect(dirty(store)).toBe(false);
  });
  it('preserves additional local edits made while a save response is in flight', async () => {
    const { store, call } = setup(); await saveRecruitmentArchive(store, call, true); edit(store, 'a', 'sent');
    await saveRecruitmentArchive(store, async (action) => { const result = await call(action); edit(store, 'a', 'not-yet-sent'); return result; }, true);
    expect(store.getSnapshot().candidates[0]?.fileName).toBe('not-yet-sent'); expect(dirty(store)).toBe(true);
    await saveRecruitmentArchive(store, call, true); expect(dirty(store)).toBe(false);
  });
  it('preserves unchanged candidate references so acknowledgement does not cancel an ongoing source analysis', async () => {
    const { store, call } = setup(); const original = store.getSnapshot().candidates[0];
    await saveRecruitmentArchive(store, call, true); expect(store.getSnapshot().candidates[0]).toBe(original);
    edit(store, 'b', 'changed'); await saveRecruitmentArchive(store, call, true); expect(store.getSnapshot().candidates[0]).toBe(original);
  });
  it('does not replace the baseline when a concurrent local edit overlaps an unseen remote change', async () => {
    const { store, call, service, job } = setup(); await saveRecruitmentArchive(store, call, true);
    const base = store.getSnapshot().sharedJob; const other = new RecruitmentWorkspaceStore('org:other'); await loadRecruitmentArchive(other, call, base!.id);
    edit(other, 'b', 'remote'); await saveRecruitmentArchive(other, call, true); edit(store, 'a', 'mine');
    await expect(saveRecruitmentArchive(store, async (action) => { const result = await service.act('hr', action); edit(store, 'b', 'unsent'); return result; }, true)).rejects.toThrow('冲突');
    expect(store.getSnapshot().sharedJob).toBe(base); expect(store.getSnapshot().candidates[1]?.fileName).toBe('unsent');
    await expect(saveRecruitmentArchive(store, call, true)).rejects.toThrow('其他同事');
    expect(JSON.parse(job().candidates[1]!.document).fileName).toBe('remote');
  });
  it('refreshes a clean workspace without resetting consent, but never overwrites a dirty workspace', async () => {
    const { store, call } = setup(); await saveRecruitmentArchive(store, call, true); store.setConsentConfirmed(true);
    const epoch = store.getWorkspaceEpoch(); const other = new RecruitmentWorkspaceStore('org:other'); await loadRecruitmentArchive(other, call, store.getSnapshot().sharedJob!.id);
    edit(other, 'b', 'remote'); await saveRecruitmentArchive(other, call, true); await refreshRecruitmentArchive(store, call);
    expect(store.getSnapshot().candidates[1]?.fileName).toBe('remote'); expect(store.getSnapshot().consentConfirmed).toBe(true); expect(store.getWorkspaceEpoch()).toBe(epoch);
    edit(store, 'a', 'unsaved'); const count = call.mock.calls.length; await refreshRecruitmentArchive(store, call); expect(call).toHaveBeenCalledTimes(count);
  });
  it('pauses refresh when sharing scope changes and keeps the old baseline', async () => {
    const { store, call, service, job } = setup(); await saveRecruitmentArchive(store, call, true); const base = store.getSnapshot().sharedJob;
    await service.act('hr', { kind: 'share', jobId: job().id, expectedRevision: job().revision, collaboratorAccountIds: ['other'] });
    await expect(refreshRecruitmentArchive(store, call)).rejects.toThrow('共享范围'); expect(store.getSnapshot().sharedJob).toBe(base);
  });
  it('rejects malformed sync metadata without enabling unsafe incremental saves', async () => {
    const { store, call } = setup(); await saveRecruitmentArchive(store, call, true);
    await expect(loadRecruitmentArchive(store, async (action) => { const result = await call(action); return { ...result, sync: { ...recruitmentSyncMetadata((result as Extract<RecruitmentJobResponse, { kind: 'job' }>).job), candidateTokens: {} } } as RecruitmentJobResponse; }, store.getSnapshot().sharedJob!.id)).rejects.toThrow('版本标识');
  });
  it('sends expired local removals explicitly instead of leaving their material on the server until another read', async () => {
    const { store, call, job } = setup(); await saveRecruitmentArchive(store, call, true);
    const future = Date.now() + 31 * 86400000; const now = vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      await saveRecruitmentArchive(store, call, true);
      expect(call.mock.lastCall?.[0]).toMatchObject({ kind: 'patch', changes: [{ id: 'a', candidate: null }, { id: 'b', candidate: null }] });
      expect(job().candidates).toEqual([]);
    } finally { now.mockRestore(); }
  });
});
