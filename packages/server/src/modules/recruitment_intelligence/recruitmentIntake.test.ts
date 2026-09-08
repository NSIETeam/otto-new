import { describe, expect, it, vi } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createSqliteRecruitmentJobStore } from './recruitmentJobStore.js';
import { RecruitmentJobService } from './recruitmentJobs.js';
import { RecruitmentIntakeWorker } from './recruitmentIntake.js';
import type { RecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';

async function fixture() {
  const db = new Database(':memory:'); let now = Date.parse('2026-09-08T00:00:00Z'); let active = true;
  const cipher = createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 21), clear() {} } });
  const store = createSqliteRecruitmentJobStore(() => db, cipher);
  const actor = async (id: string) => ({ id, organizationId: id === 'outsider' ? 'other' : 'org', isAdmin: id === 'admin', active });
  const source = { sourceId: 'workable', sourceLabel: 'Workable', sourceRecordId: 'person-1' };
  const material = { runId: 'run-1', requisitionId: 'job', canonicalId: 'candidate-1', source, acquisitionMode: 'authorized_mcp' as const, contentHash: 'a'.repeat(64), retrievedAt: new Date(now).toISOString(), material: { sourceRecordId: 'person-1', fileName: 'resume.txt', text: 'private resume: React 企业系统开发、自动化测试和项目交付。', completeness: 'full_text' as const } };
  const runtime: RecruitmentSourceRuntime = {
    listSources: vi.fn(async () => [{ id: 'workable', label: 'Workable', accessMode: 'authorized_mcp', capabilities: [], productionEnabled: true, authorized: true, searchable: true, materialReadable: true, status: 'ready', authorizationEvidenceRecorded: true }]),
    search: vi.fn(async () => ({ runId: 'run-1', sources: [{ sourceId: 'workable', label: 'Workable', status: 'ok', count: 1, durationMs: 1 }], candidates: [{ canonicalId: 'candidate-1', displayName: '同名', identityKeys: [], sourceCount: 1, sources: [source], fieldEvidence: {} }] })),
    getSearchRun: vi.fn(async () => null), getCandidateMaterial: vi.fn(async () => structuredClone(material)),
  };
  const service = new RecruitmentJobService({ store, getActor: actor, now: () => new Date(now), intakeSources: runtime });
  await service.act('owner', { kind: 'save', jobId: 'job', title: '前端', description: 'React 企业研发', expectedRevision: 0, sharingConfirmed: true, candidates: [] });
  const enable = async () => service.act('owner', { kind: 'configure_intake', jobId: 'job', expectedRevision: (await store.get('org', 'job'))!.revision, enabled: true, confirmed: true, intervalMinutes: 60, retentionDays: 7, maxMaterials: 5 });
  const entitled = vi.fn(async () => true);
  const worker = () => new RecruitmentIntakeWorker({ store, getActor: actor, isEntitled: entitled, runtime, now: () => now, audit: async () => undefined });
  return { db, store, service, enable, worker, runtime, material, entitled, advance: (hours = 1) => { now += hours * 3_600_001; }, deactivate: () => { active = false; } };
}

describe('server-owned recruitment intake', () => {
  it('keeps an enabled schedule recoverable after graceful server shutdown, without saving late material', async () => {
    const h = await fixture(); const abort = new AbortController(); try {
      await h.enable();
      vi.mocked(h.runtime.getCandidateMaterial!).mockImplementationOnce(async () => { abort.abort(); return h.material; });
      await h.worker().tick(abort.signal);
      expect((await h.store.get('org', 'job'))?.incomingMaterials ?? []).toHaveLength(0);
      expect((await h.store.get('org', 'job'))?.intake?.enabled).toBe(true);
      await h.worker().tick();
      expect((await h.store.get('org', 'job'))?.incomingMaterials).toHaveLength(1);
    } finally { h.db.close(); }
  });
  it('does not read when the license is revoked, and removes expired inbox entries even while paused', async () => {
    const h = await fixture(); try {
      await h.enable(); await h.worker().tick(); h.advance(); h.entitled.mockResolvedValue(false);
      await h.worker().tick(); expect(h.runtime.search).toHaveBeenCalledOnce();
      expect((await h.store.get('org', 'job'))?.intake?.enabled).toBe(false);
      h.advance(24 * 8); await h.worker().tick();
      expect((await h.store.get('org', 'job'))?.incomingMaterials).toHaveLength(0);
    } finally { h.db.close(); }
  });
  it('keeps current candidate edits, retains partial results truthfully and hides raw upstream errors', async () => {
    const h = await fixture(); try {
      await h.enable();
      vi.mocked(h.runtime.getCandidateMaterial!).mockImplementationOnce(async () => {
        const job = (await h.store.get('org', 'job'))!;
        await h.store.compareAndSet('org', job.revision, { ...job, updatedBy: 'coworker', revision: job.revision + 1 });
        return { ...h.material, material: { ...h.material.material, completeness: 'partial' } };
      });
      await h.worker().tick(); const job = (await h.store.get('org', 'job'))!;
      expect(job.intake?.runs[0]).toMatchObject({ status: 'partial', received: 1, failed: 1 });
      h.advance(); vi.mocked(h.runtime.search).mockRejectedValueOnce(new Error('secret token https://private-resume'));
      await h.worker().tick();
      expect(JSON.stringify((await h.store.get('org', 'job'))?.intake)).not.toContain('secret token');
      expect((await h.store.get('org', 'job'))?.incomingMaterials).toHaveLength(1);
    } finally { h.db.close(); }
  });
  it('persists an explicitly enabled task and receives material without a desktop or model call', async () => {
    const h = await fixture(); try {
      await h.enable(); await h.worker().tick();
      const job = (await h.store.get('org', 'job'))!;
      expect(job.incomingMaterials).toHaveLength(1);
      expect(job.intake?.runs[0]).toMatchObject({ status: 'completed', received: 1, modelInvoked: false });
      expect(job.candidates).toEqual([]);
      expect(JSON.stringify(h.db.prepare('SELECT * FROM enterprise_recruitment_jobs_v1').all())).not.toContain('private resume');
      h.advance(); await h.worker().tick();
      expect((await h.store.get('org', 'job'))?.incomingMaterials).toHaveLength(1);
      expect((await h.store.get('org', 'job'))?.intake?.runs[0].unchanged).toBe(1);
    } finally { h.db.close(); }
  });
  it('allows only owner/admin enablement, with confirmation and an actually authorized readable source', async () => {
    const h = await fixture(); try {
      await expect(h.service.act('outsider', { kind: 'configure_intake', jobId: 'job', expectedRevision: 1, enabled: true, confirmed: true, intervalMinutes: 60, retentionDays: 7, maxMaterials: 5 })).rejects.toThrow();
      vi.mocked(h.runtime.listSources).mockResolvedValue([]);
      await expect(h.enable()).rejects.toThrow('授权');
      expect(h.runtime.search).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it('uses a persisted lease to prevent concurrent workers fetching the same job', async () => {
    const h = await fixture(); try {
      await h.enable(); await Promise.all(Array.from({ length: 25 }, () => h.worker().tick()));
      expect(h.runtime.search).toHaveBeenCalledOnce();
    } finally { h.db.close(); }
  });
  it('discards in-flight material after pause and stops further reads after actor deactivation', async () => {
    const h = await fixture(); try {
      await h.enable();
      vi.mocked(h.runtime.getCandidateMaterial!).mockImplementationOnce(async () => {
        const job = (await h.store.get('org', 'job'))!;
        await h.service.act('owner', { kind: 'configure_intake', jobId: 'job', expectedRevision: job.revision, enabled: false, confirmed: true });
        return h.material;
      });
      await h.worker().tick(); expect((await h.store.get('org', 'job'))?.incomingMaterials ?? []).toHaveLength(0);
      await h.enable(); h.deactivate(); h.advance(); await h.worker().tick();
      expect(h.runtime.getCandidateMaterial).toHaveBeenCalledOnce();
      expect((await h.store.get('org', 'job'))?.intake?.enabled).toBe(false);
    } finally { h.db.close(); }
  });
  it('does not resurrect a deleted job or admit results after sharing scope changes', async () => {
    for (const operation of ['delete', 'share'] as const) {
      const h = await fixture(); try {
        await h.enable();
        vi.mocked(h.runtime.getCandidateMaterial!).mockImplementationOnce(async () => {
          const job = (await h.store.get('org', 'job'))!;
          await h.service.act('owner', operation === 'delete' ? { kind: 'delete', jobId: 'job', expectedRevision: job.revision }
            : { kind: 'share', jobId: 'job', expectedRevision: job.revision, collaboratorAccountIds: ['hr2'] });
          return h.material;
        });
        await h.worker().tick(); const result = await h.store.get('org', 'job');
        if (operation === 'delete') expect(result).toBeNull();
        else { expect(result?.incomingMaterials ?? []).toHaveLength(0); expect(result?.intake?.enabled).toBe(false); }
      } finally { h.db.close(); }
    }
  });
  it('continues pagination after restart and retains a changed resume as a separate inbox version', async () => {
    const h = await fixture(); try {
      await h.enable();
      const result = await h.runtime.search({ organizationId: 'org', actorAccountId: 'owner', requisitionId: 'job', query: 'React' });
      vi.mocked(h.runtime.search).mockClear().mockResolvedValue({ ...result, sources: [{ ...result.sources[0]!, nextCursor: 'next-page' }] });
      await h.worker().tick(); h.advance();
      vi.mocked(h.runtime.getCandidateMaterial!).mockResolvedValue({ ...h.material, material: { ...h.material.material, text: '新增了服务端交付与自动化测试的完整经历说明。' } });
      await h.worker().tick();
      expect(h.runtime.search).toHaveBeenLastCalledWith(expect.objectContaining({ cursors: { workable: 'next-page' } }));
      expect((await h.store.get('org', 'job'))?.incomingMaterials).toHaveLength(2);
    } finally { h.db.close(); }
  });
});
