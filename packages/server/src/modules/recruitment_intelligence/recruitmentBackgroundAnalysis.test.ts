import { describe, expect, it, vi } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createSqliteRecruitmentJobStore } from './recruitmentJobStore.js';
import { RecruitmentJobService } from './recruitmentJobs.js';
import { RecruitmentBackgroundWorker } from './recruitmentBackgroundAnalysis.js';
import { RECRUITMENT_SEMANTIC_DIMENSIONS } from './recruitmentSemantic.js';
import { createSqliteRecruitmentUsageStore, RecruitmentUsageLedger } from './recruitmentUsageLedger.js';
import { recruitmentSyncMetadata } from './recruitmentCollaboration.js';

async function fixture() {
  const db = new Database(':memory:'); let now = Date.parse('2026-09-08T00:00:00Z');
  const store = createSqliteRecruitmentJobStore(() => db, createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 21), clear() {} } }));
  const usageLedger = new RecruitmentUsageLedger(createSqliteRecruitmentUsageStore(() => db, createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 22), clear() {} } })), () => now);
  const getActor = vi.fn(async (id: string) => ({ id, organizationId: id === 'outsider' ? 'other' : 'org', isAdmin: false, active: true }));
  const invoke = vi.fn(async () => ({ raw: JSON.stringify({ summary: '简历自述具有 React 项目经验，待面试验证', dimensions: RECRUITMENT_SEMANTIC_DIMENSIONS.map((d) => ({ ...d, score: 60, evidence: [] })) }), inputTokens: 500, outputTokens: 100 }));
  const model = { id: 'test/model', version: 'profile-v1', invoke, organizationBudget: { dailyRequests: 10, dailyReservedTokens: 1_000_000 } };
  const resolveModel = vi.fn(() => model as typeof model | null);
  const service = new RecruitmentJobService({ store, getActor, backgroundModel: resolveModel, analyzeOnce: (accountId, action) => worker().analyzeOnce(accountId, action), now: () => new Date(now) });
  await service.act('owner', { kind: 'save', jobId: 'job', title: '前端', description: 'React 企业系统开发', candidates: [], expectedRevision: 0, sharingConfirmed: true });
  const add = async (id: string, completeness: 'full_text' | 'partial' = 'full_text') => {
    const job = (await store.get('org', 'job'))!;
    await store.compareAndSet('org', job.revision, { ...job, revision: job.revision + 1, incomingMaterials: [...job.incomingMaterials ?? [], { id, receivedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000 * 7).toISOString(), material: { runId: 'source-run', canonicalId: id, requisitionId: 'job', source: { sourceId: 'workable', sourceLabel: 'Workable', sourceRecordId: id }, acquisitionMode: 'authorized_mcp', contentHash: id, retrievedAt: new Date(now).toISOString(), material: { sourceRecordId: id, text: `姓名：张三\n手机：13812345678\nReact 企业系统开发与测试。${id}`, completeness } } }] });
  };
  const configure = async (enabled = true, limit = 2) => service.act('owner', { kind: 'configure_background_analysis', jobId: 'job', expectedRevision: (await store.get('org', 'job'))!.revision, enabled, confirmed: true, dailyRequestLimit: limit, dailyReservedTokenLimit: 100_000 });
  const entitled = vi.fn(async () => true);
  const worker = () => new RecruitmentBackgroundWorker({ store, usageLedger, getActor, resolveModel, isEntitled: entitled, audit: async () => undefined, now: () => now });
  const onceAction = async (itemId: string) => {
    const job = (await store.get('org', 'job'))!; const sync = recruitmentSyncMetadata(job);
    return { kind: 'analyze_intake_once' as const, jobId: job.id, itemId, expectedRevision: job.revision, scopeToken: sync.scopeToken, headerToken: sync.headerToken, modelVersion: job.backgroundAnalysis!.modelVersion, confirmed: true as const };
  };
  return { db, store, usageLedger, model, service, add, configure, invoke, resolveModel, getActor, entitled, worker, onceAction, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('paid server recruitment analysis', () => {
  it.each(['revoke', 'deactivate', 'pause', 'remove'] as const)('does not adopt late one-off results after %s, and retains the paid reservation', async (change) => {
    const h = await fixture(); try {
      const id = 'f'.repeat(64); await h.add(id);
      const before = (await h.store.get('org', 'job'))!;
      await h.service.act('owner', { kind: 'share', jobId: 'job', expectedRevision: before.revision, collaboratorAccountIds: ['hr'] });
      await h.configure(false);
      h.invoke.mockImplementationOnce(async () => {
        const job = (await h.store.get('org', 'job'))!;
        if (change === 'pause') await h.configure(false);
        else if (change === 'revoke') await h.service.act('owner', { kind: 'share', jobId: 'job', expectedRevision: job.revision, collaboratorAccountIds: [] });
        else if (change === 'deactivate') h.getActor.mockImplementation(async (accountId) => ({ id: accountId, organizationId: 'org', isAdmin: false, active: accountId !== 'hr' }));
        else await h.service.act('owner', { kind: 'dismiss_intake', jobId: 'job', expectedRevision: job.revision, itemId: id, confirmed: true });
        return { raw: JSON.stringify({ summary: '模型已完成，但晚到结果不得采用', dimensions: RECRUITMENT_SEMANTIC_DIMENSIONS.map((d) => ({ ...d, score: 60, evidence: [] })) }), inputTokens: 500, outputTokens: 100 };
      });
      const run = h.service.act('hr', await h.onceAction(id));
      if (change === 'revoke' || change === 'deactivate') await expect(run).rejects.toThrow(); else await run;
      const after = (await h.store.get('org', 'job'))!;
      expect(after.backgroundAnalysis?.enabled).toBe(false);
      expect(after.incomingMaterials?.find((item) => item.id === id)?.analysis?.evaluation).toBeUndefined();
      if (change === 'remove') expect(after.incomingMaterials).toEqual([]);
      expect(await h.usageLedger.snapshot('org', h.model.organizationBudget)).toMatchObject({ requests: 1, inputTokens: 500, outputTokens: 100 });
      await h.worker().tick(); expect(h.invoke).toHaveBeenCalledOnce();
    } finally { h.db.close(); }
  });
  it('lets an authorized colleague analyze only the selected server material without enabling the scheduler', async () => {
    const h = await fixture(); try {
      const a = 'a'.repeat(64); const b = 'b'.repeat(64); await h.add(a); await h.add(b);
      const job = (await h.store.get('org', 'job'))!;
      await h.service.act('owner', { kind: 'share', jobId: 'job', expectedRevision: job.revision, collaboratorAccountIds: ['hr'] });
      await h.configure(false);
      const result = await h.service.act('hr', await h.onceAction(b));
      expect(result.kind).toBe('job');
      const after = (await h.store.get('org', 'job'))!;
      expect(after.backgroundAnalysis?.enabled).toBe(false);
      expect(after.incomingMaterials![0].analysis).toBeUndefined();
      expect(after.incomingMaterials![1].analysis?.status).toBe('completed');
      expect(after.updatedBy).toBe('hr');
      expect(await h.usageLedger.snapshot('org', h.model.organizationBudget)).toMatchObject({ requests: 1 });
      await h.worker().tick(); expect(h.invoke).toHaveBeenCalledOnce();
      await h.service.act('hr', await h.onceAction(b)); expect(h.invoke).toHaveBeenCalledOnce();
    } finally { h.db.close(); }
  });
  it('allows only one paid request when one-off, background and desktop claims race', async () => {
    const h = await fixture(); try {
      const id = 'c'.repeat(64); await h.add(id); await h.configure();
      const action = await h.onceAction(id); const manual = vi.fn();
      await Promise.allSettled([h.service.act('owner', action), ...Array.from({ length: 10 }, () => h.worker().tick()),
        ...Array.from({ length: 10 }, async (_, i) => {
          const response = await h.service.act('owner', { kind: 'claim_intake_analysis', jobId: 'job', itemId: id, requestId: `r-${i}`, candidateId: `c-${i}`, scopeToken: action.scopeToken, headerToken: action.headerToken, confirmed: true });
          if (response.kind !== 'job') throw new Error();
          await h.service.act('owner', { kind: 'start_intake_analysis', jobId: 'job', itemId: id, requestId: `r-${i}`, claimId: response.job.incomingMaterials![0].manualAnalysis!.id }); manual();
        })]);
      expect(h.invoke.mock.calls.length + manual.mock.calls.length).toBe(1);
    } finally { h.db.close(); }
  });
  it('requires separate confirmation, exact scope/model, full text and current membership before one-off IO', async () => {
    const h = await fixture(); try {
      const id = 'd'.repeat(64); await h.add(id); await h.configure(false); const action = await h.onceAction(id);
      await expect(h.service.act('owner', { ...action, confirmed: false } as unknown as typeof action)).rejects.toThrow();
      await expect(h.service.act('outsider', action)).rejects.toThrow();
      await expect(h.service.act('unassigned', action)).rejects.toThrow();
      await expect(h.service.act('owner', { ...action, scopeToken: 'e'.repeat(64) })).rejects.toThrow();
      await expect(h.service.act('owner', { ...action, modelVersion: 'not-the-confirmed-model' })).rejects.toThrow();
      h.entitled.mockResolvedValue(false); await expect(h.service.act('owner', action)).rejects.toThrow(); h.entitled.mockResolvedValue(true);
      const current = (await h.store.get('org', 'job'))!;
      await h.store.compareAndSet('org', current.revision, { ...current, revision: current.revision + 1, incomingMaterials: [{ ...current.incomingMaterials![0], material: { ...current.incomingMaterials![0].material, material: { sourceRecordId: id, text: 'partial', completeness: 'partial' } } }] });
      await expect(h.service.act('owner', await h.onceAction(id))).rejects.toThrow();
      expect(h.invoke).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it('respects the same enterprise cap for one-off requests and never falls back to another model after failure', async () => {
    const h = await fixture(); try {
      h.model.organizationBudget.dailyRequests = 1;
      const a = 'a'.repeat(64); const b = 'b'.repeat(64); await h.add(a); await h.add(b); await h.configure(false);
      h.invoke.mockRejectedValueOnce(new Error('provider private payload'));
      await h.service.act('owner', await h.onceAction(a));
      await h.service.act('owner', await h.onceAction(a));
      await h.service.act('owner', await h.onceAction(b));
      expect(h.invoke).toHaveBeenCalledOnce();
      const job = (await h.store.get('org', 'job'))!;
      expect(job.backgroundAnalysis?.enabled).toBe(false); expect(job.incomingMaterials![1].analysis).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain('provider private payload');
    } finally { h.db.close(); }
  });
  it('enforces one enterprise ceiling across jobs without charging denied items against their job limit', async () => {
    const h = await fixture(); try {
      h.model.organizationBudget.dailyRequests = 1;
      await h.add('one'); await h.configure();
      const first = (await h.store.get('org', 'job'))!;
      await h.store.compareAndSet('org', 0, { ...first, id: 'job-two', revision: 1 });
      await h.service.act('owner', { kind: 'configure_background_analysis', jobId: 'job-two', expectedRevision: 1, enabled: true, confirmed: true });
      await Promise.all(Array.from({ length: 10 }, () => h.worker().tick()));
      expect(h.invoke).toHaveBeenCalledOnce();
      const other = (await h.store.get('org', 'job-two'))!;
      expect(other.incomingMaterials![0].analysis).toBeUndefined();
      expect(other.backgroundAnalysis).toMatchObject({ enabled: true, organizationUsage: { requests: 1, dailyRequests: 1 } });
      expect(other.backgroundAnalysis!.usage[0].requests).toBe(0);
      expect(other.backgroundAnalysis!.message).toContain('企业');
      h.advance(86_400_000); await h.worker().tick(); expect(h.invoke).toHaveBeenCalledTimes(2);
    } finally { h.db.close(); }
  });
  it('blocks identical material under a new inbox ID after restart, including unknown outcomes', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure();
      h.invoke.mockRejectedValueOnce(new Error('ambiguous upstream'));
      await h.worker().tick();
      const first = (await h.store.get('org', 'job'))!;
      await h.store.compareAndSet('org', first.revision, { ...first, revision: first.revision + 1, incomingMaterials: [
        ...first.incomingMaterials!, { ...first.incomingMaterials![0], id: 'new-inbox-id', analysis: undefined },
      ] });
      await h.configure(); await h.worker().tick();
      expect(h.invoke).toHaveBeenCalledOnce();
      const duplicate = (await h.store.get('org', 'job'))!;
      expect(duplicate.incomingMaterials![1].analysis?.message).toContain('相同');
      expect(duplicate.backgroundAnalysis!.usage[0].requests).toBe(1);
      expect(await h.usageLedger.snapshot('org', h.model.organizationBudget)).toMatchObject({ requests: 1, unknownRequests: 1 });
    } finally { h.db.close(); }
  });
  it('fails closed without an enterprise budget and when the ledger write or settlement is unavailable', async () => {
    const h = await fixture(); try {
      await h.add('one');
      h.resolveModel.mockReturnValueOnce({ ...h.model, organizationBudget: undefined } as unknown as typeof h.model);
      await expect(h.configure()).rejects.toThrow('企业总额度');
      await h.configure();
      vi.spyOn(h.usageLedger, 'reserve').mockRejectedValueOnce(new Error('database connection secret'));
      await h.worker().tick(); expect(h.invoke).not.toHaveBeenCalled();
      expect((await h.store.get('org', 'job'))!.backgroundAnalysis!.enabled).toBe(false);
      expect(JSON.stringify(await h.store.get('org', 'job'))).not.toContain('connection secret');
    } finally { h.db.close(); }
  });
  it('keeps a usable result but pauses when enterprise usage settlement fails, without paying again', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure();
      vi.spyOn(h.usageLedger, 'finish').mockRejectedValueOnce(new Error('settlement network error'));
      await h.worker().tick(); await h.worker().tick();
      const job = (await h.store.get('org', 'job'))!;
      expect(job.incomingMaterials![0].analysis?.status).toBe('completed');
      expect(job.backgroundAnalysis).toMatchObject({ enabled: false, message: expect.stringContaining('账本回报未确认') });
      expect(await h.usageLedger.snapshot('org', h.model.organizationBudget)).toMatchObject({ requests: 1, unknownRequests: 1 });
      await h.configure(); await h.worker().tick(); expect(h.invoke).toHaveBeenCalledOnce();
    } finally { h.db.close(); }
  });
  it('reserves conservatively when a successful enterprise write response is lost and rechecks budget revocation before IO', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure();
      const reserve = h.usageLedger.reserve.bind(h.usageLedger);
      vi.spyOn(h.usageLedger, 'reserve').mockImplementationOnce(async (...args) => { await reserve(...args); throw new Error('lost reply'); });
      await h.worker().tick(); expect(h.invoke).not.toHaveBeenCalled();
      expect(await h.usageLedger.snapshot('org', h.model.organizationBudget)).toMatchObject({ requests: 1, unknownRequests: 1 });
      await h.add('two'); await h.configure();
      const worker = new RecruitmentBackgroundWorker({ store: h.store, usageLedger: h.usageLedger, resolveModel: h.resolveModel, now: h.now, getActor: async () => ({ id: 'owner', organizationId: 'org', isAdmin: false, active: true }), isEntitled: h.entitled,
        audit: async () => { h.resolveModel.mockReturnValue({ ...h.model, organizationBudget: undefined } as unknown as typeof h.model); } });
      await worker.tick(); expect(h.invoke).not.toHaveBeenCalled();
      expect(await h.usageLedger.snapshot('org', h.model.organizationBudget)).toMatchObject({ requests: 2, unknownRequests: 2 });
    } finally { h.db.close(); }
  });
  it('keeps manual claims excluded from background work after client failure or expiry', async () => {
    const h = await fixture(); try {
      const itemId = 'a'.repeat(64); await h.add(itemId);
      const current = await h.service.act('owner', { kind: 'get', jobId: 'job' }); if (current.kind !== 'job') throw new Error();
      const claimed = await h.service.act('owner', { kind: 'claim_intake_analysis', jobId: 'job', itemId, requestId: 'client', candidateId: 'candidate', ...current.sync!, confirmed: true });
      if (claimed.kind !== 'job') throw new Error(); const claimId = claimed.job.incomingMaterials![0].manualAnalysis!.id;
      await h.service.act('owner', { kind: 'start_intake_analysis', jobId: 'job', itemId, requestId: 'client', claimId });
      await h.configure(); await h.worker().tick(); h.advance(240_000); await h.worker().tick();
      expect(h.invoke).not.toHaveBeenCalled(); expect((await h.store.get('org', 'job'))?.incomingMaterials?.[0].manualAnalysis?.status).toBe('started');
      await expect(h.service.act('owner', { kind: 'start_intake_analysis', jobId: 'job', itemId, requestId: 'client', claimId })).rejects.toThrow();
    } finally { h.db.close(); }
  });
  it('allows only one of competing manual clients and a background worker to reserve the same item', async () => {
    const h = await fixture(); try {
      const itemId = 'b'.repeat(64); await h.add(itemId); await h.configure();
      const current = await h.service.act('owner', { kind: 'get', jobId: 'job' }); if (current.kind !== 'job') throw new Error();
      const manualModel = vi.fn();
      await Promise.allSettled([...Array.from({ length: 25 }, async (_, i) => {
        const requestId = `client-${i}`;
        const result = await h.service.act('owner', { kind: 'claim_intake_analysis', jobId: 'job', itemId, requestId, candidateId: `candidate-${i}`, ...current.sync!, confirmed: true });
        if (result.kind !== 'job') throw new Error();
        await h.service.act('owner', { kind: 'start_intake_analysis', jobId: 'job', itemId, requestId, claimId: result.job.incomingMaterials![0].manualAnalysis!.id });
        manualModel();
      }), h.worker().tick()]);
      expect(manualModel.mock.calls.length + h.invoke.mock.calls.length).toBe(1);
      const item = (await h.store.get('org', 'job'))!.incomingMaterials![0];
      expect(Boolean(item.manualAnalysis) !== Boolean(item.analysis)).toBe(true);
      await h.worker().tick(); expect(manualModel.mock.calls.length + h.invoke.mock.calls.length).toBe(1);
      expect(JSON.stringify(h.db.prepare('SELECT * FROM enterprise_recruitment_jobs_v1').all())).not.toContain('13812345678');
    } finally { h.db.close(); }
  });
  it('does not claim an already attempted background item and preserves independent concurrent claims', async () => {
    const h = await fixture(); try {
      const itemId = 'c'.repeat(64); await h.add(itemId); await h.configure(); await h.worker().tick();
      const current = await h.service.act('owner', { kind: 'get', jobId: 'job' }); if (current.kind !== 'job') throw new Error();
      await expect(h.service.act('owner', { kind: 'claim_intake_analysis', jobId: 'job', itemId, requestId: 'client', candidateId: 'candidate', ...current.sync!, confirmed: true })).rejects.toThrow('后台');
      await h.configure(false); await h.add('d'.repeat(64)); await h.add('e'.repeat(64));
      const before = await h.service.act('owner', { kind: 'get', jobId: 'job' }); if (before.kind !== 'job') throw new Error();
      await Promise.all(['d', 'e'].map((letter) => h.service.act('owner', { kind: 'claim_intake_analysis', jobId: 'job', itemId: letter.repeat(64), requestId: letter, candidateId: letter, ...before.sync!, confirmed: true })));
      const entries = (await h.store.get('org', 'job'))!.incomingMaterials!;
      expect(entries.slice(1).every((entry) => entry.manualAnalysis?.status === 'claimed')).toBe(true);
      expect(entries[0].analysis?.status).toBe('completed');
    } finally { h.db.close(); }
  });
  it('defaults off and requires an approved model and owner confirmation', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.worker().tick(); expect(h.invoke).not.toHaveBeenCalled();
      h.resolveModel.mockReturnValue(null); await expect(h.configure()).rejects.toThrow('模型');
      await expect(h.service.act('outsider', { kind: 'configure_background_analysis', jobId: 'job', expectedRevision: 2, enabled: true, confirmed: true })).rejects.toThrow();
    } finally { h.db.close(); }
  });
  it('atomically reserves before a single model call across 25 competing workers, and never reanalyzes unchanged inbox entries', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure();
      h.invoke.mockImplementationOnce(async () => {
        expect((await h.store.get('org', 'job'))?.backgroundAnalysis?.usage[0].requests).toBe(1);
        expect((await h.store.get('org', 'job'))?.backgroundAnalysis?.pending).toBeDefined();
        return { raw: JSON.stringify({ summary: '需要核实', dimensions: RECRUITMENT_SEMANTIC_DIMENSIONS.map((d) => ({ ...d, score: 50, evidence: [] })) }), inputTokens: 500, outputTokens: 100 };
      });
      await Promise.all(Array.from({ length: 25 }, () => h.worker().tick())); await h.worker().tick();
      expect(h.invoke).toHaveBeenCalledOnce();
      const job = (await h.store.get('org', 'job'))!;
      expect(job.incomingMaterials?.[0].analysis?.status).toBe('completed');
      expect(job.incomingMaterials?.[0].analysis?.evaluation?.assessmentContext?.materialScope).toEqual(['resume']);
      expect(job.backgroundAnalysis?.usage[0]).toMatchObject({ requests: 1, inputTokens: 500, outputTokens: 100, unknownRequests: 0 });
      expect(JSON.stringify(h.invoke.mock.calls)).not.toContain('13812345678');
      expect(JSON.stringify(h.db.prepare('SELECT * FROM enterprise_recruitment_jobs_v1').all())).not.toContain('React 企业系统');
    } finally { h.db.close(); }
  });
  it('keeps reservations and pauses after ambiguous failure, including reconfiguration', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure(); h.invoke.mockRejectedValueOnce(new Error('private credential response'));
      await h.worker().tick(); await h.configure(); await h.worker().tick();
      expect(h.invoke).toHaveBeenCalledOnce();
      const job = (await h.store.get('org', 'job'))!;
      expect(job.backgroundAnalysis?.usage[0]).toMatchObject({ requests: 1, unknownRequests: 1 });
      expect(job.incomingMaterials?.[0].analysis?.status).toBe('unknown');
      expect(JSON.stringify(job.backgroundAnalysis)).not.toContain('credential');
    } finally { h.db.close(); }
  });
  it('does not reset daily budget when reconfigured and skips incomplete material', async () => {
    const h = await fixture(); try {
      await h.add('partial', 'partial'); await h.add('one'); await h.add('two'); await h.configure(true, 1);
      await h.worker().tick(); await h.configure(true, 1); await h.worker().tick(); expect(h.invoke).toHaveBeenCalledOnce();
      h.advance(86_400_000); await h.worker().tick(); expect(h.invoke).toHaveBeenCalledTimes(2);
      expect((await h.store.get('org', 'job'))?.incomingMaterials?.[0].analysis).toBeUndefined();
    } finally { h.db.close(); }
  });
  it('rejects late paid results when paused and retains the reservation', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure(); h.invoke.mockImplementationOnce(async () => { await h.configure(false); return { raw: '{}', inputTokens: 1, outputTokens: 1 }; });
      await h.worker().tick(); const job = (await h.store.get('org', 'job'))!;
      expect(job.backgroundAnalysis?.enabled).toBe(false); expect(job.backgroundAnalysis?.usage[0].requests).toBe(1);
      expect(job.incomingMaterials?.[0].analysis?.evaluation).toBeUndefined();
      await h.configure(); await h.worker().tick(); expect(h.invoke).toHaveBeenCalledOnce();
    } finally { h.db.close(); }
  });
  it('pauses without calls after license or job standards change', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure(); h.entitled.mockResolvedValue(false); await h.worker().tick(); expect(h.invoke).not.toHaveBeenCalled();
      h.entitled.mockResolvedValue(true); await h.configure(); const job = (await h.store.get('org', 'job'))!;
      await h.store.compareAndSet('org', job.revision, { ...job, title: '后端', revision: job.revision + 1 });
      await h.worker().tick(); expect(h.invoke).not.toHaveBeenCalled(); expect((await h.store.get('org', 'job'))?.backgroundAnalysis?.enabled).toBe(false);
    } finally { h.db.close(); }
  });
  it('recovers an expired in-flight marker without resending and never calls for an oversized daily reservation', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure();
      const before = (await h.store.get('org', 'job'))!;
      const interrupted = new RecruitmentBackgroundWorker({ store: h.store, usageLedger: h.usageLedger, resolveModel: h.resolveModel, now: h.now, getActor: async () => ({ id: 'owner', organizationId: 'org', isAdmin: false, active: true }), isEntitled: h.entitled,
        audit: async (event) => { if (event.phase === 'requested') { h.advance(240_000); await h.worker().tick(); } } });
      await interrupted.tick(); expect(h.invoke).not.toHaveBeenCalled();
      expect((await h.store.get('org', 'job'))?.backgroundAnalysis?.enabled).toBe(false);
      await h.configure(); await h.worker().tick(); expect(h.invoke).not.toHaveBeenCalled();
      await h.add('two'); const current = (await h.store.get('org', 'job'))!;
      await h.store.compareAndSet('org', current.revision, { ...current, revision: current.revision + 1, backgroundAnalysis: { ...current.backgroundAnalysis!, dailyReservedTokenLimit: 10_000 } });
      await h.worker().tick(); expect(h.invoke).not.toHaveBeenCalled();
      expect((await h.store.get('org', 'job'))?.backgroundAnalysis?.usage[0].requests).toBe(1);
      expect(before.incomingMaterials?.[0].analysis).toBeUndefined();
    } finally { h.db.close(); }
  });
  it('does not transmit material removed after reservation but before invocation', async () => {
    const h = await fixture(); try {
      await h.add('one'); await h.configure();
      const worker = new RecruitmentBackgroundWorker({ store: h.store, usageLedger: h.usageLedger, resolveModel: h.resolveModel, getActor: async () => ({ id: 'owner', organizationId: 'org', isAdmin: false, active: true }), isEntitled: h.entitled,
        audit: async (event) => { if (event.phase === 'requested') { const job = (await h.store.get('org', 'job'))!; await h.store.compareAndSet('org', job.revision, { ...job, revision: job.revision + 1, incomingMaterials: [] }); } } });
      await worker.tick(); expect(h.invoke).not.toHaveBeenCalled(); expect((await h.store.get('org', 'job'))?.incomingMaterials).toEqual([]);
    } finally { h.db.close(); }
  });
});
