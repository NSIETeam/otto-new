import { describe, expect, it, vi } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createSqliteRecruitmentJobStore } from './recruitmentJobStore.js';
import { RecruitmentJobService, type RecruitmentSharedJob } from './recruitmentJobs.js';
import { captureRecruitmentAssessmentContext } from './recruitmentAssessment.js';
import { parseRecruitmentSemanticAnalysis, sanitizeRecruitmentModelInput } from './recruitmentSemanticModel.js';
import { RecruitmentAutoArchiveWorker, startRecruitmentAutoArchive } from './recruitmentAutoArchive.js';
import type { RecurringTaskRegistry } from 'otto-core';
import { RECRUITMENT_SEMANTIC_DIMENSIONS } from './recruitmentSemantic.js';

async function fixture() {
  const db = new Database(':memory:'); let time = Date.now();
  const store = createSqliteRecruitmentJobStore(() => db, createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 17), clear() {} } }));
  const actor = { id: 'owner', organizationId: 'org', active: true, isAdmin: false };
  const getActor = vi.fn(async (id: string) => ({ ...actor, id, organizationId: id === 'other-org' ? 'other' : 'org' }));
  const entitled = vi.fn(async () => true); const audit = vi.fn(async () => undefined);
  const service = new RecruitmentJobService({ store, getActor, now: () => new Date(time) });
  await service.act('owner', { kind: 'save', jobId: 'job', title: '前端', description: 'React 开发交付', candidates: [], expectedRevision: 0, sharingConfirmed: true });
  const get = async () => (await store.get('org', 'job'))!;
  const mutate = async (change: (job: RecruitmentSharedJob) => RecruitmentSharedJob) => { const job = await get(); expect(await store.compareAndSet('org', job.revision, { ...change(job), revision: job.revision + 1 })).toBe(true); };
  const add = async (id: string, record = 'person-1', text = 'React 企业应用开发，负责需求、测试与交付。') => {
    const job = await get(); const redactedResume = sanitizeRecruitmentModelInput(text);
    const runId = `run-${id}`; const inputFingerprint = id.repeat(64).slice(0, 64); const now = new Date(time).toISOString();
    const evaluation = { ...parseRecruitmentSemanticAnalysis(JSON.stringify({ summary: '简历自述具备相关交付经验，待面试核实', dimensions: RECRUITMENT_SEMANTIC_DIMENSIONS.map((d) => ({ ...d, score: 50, evidence: [] })) }), redactedResume, { modelProvider: 'fixture', inputTokens: 10, outputTokens: 5 }),
      assessmentContext: await captureRecruitmentAssessmentContext({ candidateId: id, jobTitle: job.title, jobDescription: job.description, redactedResume }, 'fixture'),
      execution: { runId, disposition: 'executed' as const, requestedAt: now, inputFingerprint, inputTokens: 10, outputTokens: 5 } };
    await mutate((j) => ({ ...j, incomingMaterials: [...j.incomingMaterials ?? [], { id: inputFingerprint, receivedAt: now, expiresAt: new Date(time + 7 * 86_400_000).toISOString(),
      material: { runId: 'search', canonicalId: record, requisitionId: 'job', source: { sourceId: 'workable', sourceLabel: 'Workable', sourceRecordId: record }, acquisitionMode: 'authorized_mcp', contentHash: inputFingerprint, retrievedAt: now, material: { sourceRecordId: record, fileName: '测试简历.txt', text, completeness: 'full_text' } },
      analysis: { status: 'completed', runId, attemptedAt: now, inputFingerprint, modelVersion: 'fixture-v1', redactedResume, evaluation, message: '有简历自述支持' } }] }));
  };
  const configure = async (enabled = true) => service.act('owner', { kind: 'configure_auto_archive', jobId: 'job', expectedRevision: (await get()).revision, enabled, confirmed: true, retentionDays: 30 });
  const worker = () => new RecruitmentAutoArchiveWorker({ store, getActor, isEntitled: entitled, audit, now: () => time });
  return { db, store, get, mutate, actor, getActor, service, entitled, audit, add, configure, worker, advance: (ms = 60_000) => { time += ms; } };
}

describe('automatic formal candidate archive', () => {
  it('registers an independent zero-model-cost task and aborts it on shutdown', async () => {
    const h = await fixture(); try {
      const register = vi.fn(); const unregister = vi.fn(); register.mockReturnValue(unregister);
      const worker = h.worker(); const tick = vi.spyOn(worker, 'tick').mockResolvedValue(undefined);
      const stop = startRecruitmentAutoArchive(worker, { register } as unknown as RecurringTaskRegistry);
      const config = register.mock.calls[0][0]; expect(config).toMatchObject({ name: 'enterprise.recruitment-auto-archive', estimatedCostUsdPerRun: 0 });
      await config.run(); const signal = tick.mock.calls[0][0]!; expect(signal.aborted).toBe(false);
      stop(); expect(signal.aborted).toBe(true); expect(unregister).toHaveBeenCalledOnce();
    } finally { h.db.close(); }
  });
  it('blocks a collaborator from changing consent, expires the window and stops when the owner is disabled', async () => {
    const h = await fixture(); try {
      await h.mutate((job) => ({ ...job, collaboratorAccountIds: ['coworker'] }));
      await expect(h.service.act('coworker', { kind: 'configure_auto_archive', jobId: 'job', expectedRevision: (await h.get()).revision, enabled: true, confirmed: true })).rejects.toThrow('岗位创建者');
      await h.configure(); h.advance(31 * 86_400_000); await h.add('a'); await h.worker().tick();
      expect((await h.get()).autoArchive?.enabled).toBe(false); expect((await h.get()).candidates).toHaveLength(0);
      await h.configure(); h.getActor.mockResolvedValue({ ...h.actor, active: false }); await h.worker().tick();
      expect((await h.get()).candidates).toHaveLength(0);
    } finally { h.db.close(); }
  });
  it('retains completed results across audit failure and a restarted worker without creating another dossier', async () => {
    const h = await fixture(); try {
      await h.add('a'); await h.configure(); h.audit.mockRejectedValueOnce(new Error('audit unavailable'));
      await expect(h.worker().tick()).rejects.toThrow('audit unavailable'); expect((await h.get()).candidates).toHaveLength(0);
      h.audit.mockImplementation(async () => { if ((await h.get()).candidates.length) throw new Error('completion audit unavailable'); });
      await expect(h.worker().tick()).rejects.toThrow('completion audit unavailable');
      const job = await h.get(); expect(job.candidates).toHaveLength(1);
      h.audit.mockResolvedValue(undefined); await h.worker().tick(); expect((await h.get()).revision).toBe(job.revision);
    } finally { h.db.close(); }
  });
  it('does not overwrite a manually imported source or accept a mismatched analysis context', async () => {
    const h = await fixture(); try {
      await h.add('a'); await h.configure(); await h.worker().tick();
      await h.mutate((job) => ({ ...job, autoArchive: { ...job.autoArchive!, bindings: [] } }));
      h.advance(); await h.add('b'); await h.worker().tick();
      expect((await h.get()).candidates).toHaveLength(1); expect((await h.get()).incomingMaterials![1].archive?.message).toContain('人工合并');
      h.advance(); await h.add('c', 'another-person');
      await h.mutate((job) => ({ ...job, incomingMaterials: job.incomingMaterials!.map((item) => item.id.startsWith('c') ? { ...item, analysis: { ...item.analysis!, redactedResume: '被替换的正文' } } : item) }));
      await h.worker().tick(); expect((await h.get()).incomingMaterials![2].archive?.status).toBe('needs_review'); expect((await h.get()).candidates).toHaveLength(1);
    } finally { h.db.close(); }
  });
  it('defaults off, requires explicit owner consent, and lets 25 workers create only one shared candidate', async () => {
    const h = await fixture(); try {
      await h.add('a'); await h.worker().tick(); expect((await h.get()).candidates).toHaveLength(0);
      await expect(h.service.act('owner', { kind: 'configure_auto_archive', jobId: 'job', expectedRevision: (await h.get()).revision, enabled: true, confirmed: false, retentionDays: 30 } as never)).rejects.toThrow();
      await expect(h.service.act('other-org', { kind: 'get', jobId: 'job' })).rejects.toThrow();
      await h.configure(); await Promise.all(Array.from({ length: 25 }, () => h.worker().tick()));
      const job = await h.get(); expect(job.candidates).toHaveLength(1); expect(job.incomingMaterials![0].archive?.status).toBe('created');
      const candidate = JSON.parse(job.candidates[0].document);
      expect(candidate.semanticEvaluation.summary).toContain('简历自述'); expect(candidate.analysisHistory).toHaveLength(1);
      expect(candidate.pipelineStage).toBe('new'); expect(candidate.decision).toBeNull(); expect(candidate.consentAt).toBe(job.autoArchive?.confirmedAt);
      const revision = job.revision; await h.worker().tick(); expect((await h.get()).revision).toBe(revision);
      expect(JSON.stringify(h.db.prepare('SELECT * FROM enterprise_recruitment_jobs_v1').all())).not.toContain('React 企业应用');
    } finally { h.db.close(); }
  });
  it('updates the same source without extending consent, retaining old text and complete analysis history', async () => {
    const h = await fixture(); try {
      await h.add('a'); await h.configure(); await h.worker().tick(); const first = (await h.get()).candidates[0];
      h.advance(); await h.add('b', 'person-1', 'React 企业应用开发，新材料补充大型系统交付及性能优化经验。'); await h.worker().tick();
      const job = await h.get(); expect(job.candidates).toHaveLength(1); expect(job.candidates[0].id).toBe(first.id); expect(job.candidates[0].expiresAt).toBe(first.expiresAt);
      const doc = JSON.parse(job.candidates[0].document); expect(doc.analysisHistory).toHaveLength(2); expect(doc.sourceHistory).toHaveLength(1);
      expect(doc.sourceHistory[0].material.material.text).toContain('负责需求'); expect(job.incomingMaterials![1].archive?.status).toBe('updated');
    } finally { h.db.close(); }
  });
  it('never overwrites human edits or recreates a deleted candidate', async () => {
    const h = await fixture(); try {
      await h.add('a'); await h.configure(); await h.worker().tick();
      await h.mutate((job) => ({ ...job, candidates: job.candidates.map((entry) => ({ ...entry, document: JSON.stringify({ ...JSON.parse(entry.document), transcriptText: '同事新补充的面试记录' }) })) }));
      const prior = (await h.get()).candidates[0].document;
      h.advance(); await h.add('b', 'person-1', 'React 应用研发测试交付，新简历正文与旧版不同。'); await h.worker().tick();
      expect((await h.get()).candidates[0].document).toBe(prior); expect((await h.get()).incomingMaterials![1].archive?.status).toBe('needs_review');
      await h.mutate((job) => ({ ...job, candidates: [] })); h.advance(); await h.add('c'); await h.worker().tick();
      expect((await h.get()).candidates).toHaveLength(0); expect((await h.get()).incomingMaterials![2].archive?.message).toContain('删除');
    } finally { h.db.close(); }
  });
  it('stops on license, standards or authority changes and skips unknown results', async () => {
    const h = await fixture(); try {
      await h.add('a'); await h.configure(); h.entitled.mockResolvedValue(false); await h.worker().tick();
      expect((await h.get()).candidates).toHaveLength(0); expect((await h.get()).autoArchive?.enabled).toBe(false);
      h.entitled.mockResolvedValue(true); await h.configure(); await h.mutate((job) => ({ ...job, title: '其他岗位' })); await h.worker().tick(); expect((await h.get()).candidates).toHaveLength(0);
      await h.configure(); await h.mutate((job) => ({ ...job, incomingMaterials: job.incomingMaterials!.map((item) => ({ ...item, analysis: { ...item.analysis!, status: 'unknown' } })) })); await h.worker().tick(); expect((await h.get()).candidates).toHaveLength(0);
    } finally { h.db.close(); }
  });
  it('rechecks scope after audit, and keeps unrelated concurrent edits', async () => {
    const h = await fixture(); try {
      await h.add('a'); await h.configure();
      h.audit.mockImplementationOnce(async () => { await h.configure(false); });
      await h.worker().tick(); expect((await h.get()).candidates).toHaveLength(0);
      await h.configure(); await h.worker().tick(); const first = (await h.get()).candidates[0];
      h.advance(); await h.add('b', 'another-person');
      h.audit.mockImplementationOnce(async () => { await h.mutate((job) => ({ ...job, candidates: job.candidates.map((entry) => ({ ...entry, document: JSON.stringify({ ...JSON.parse(entry.document), pipelineStage: 'interview' }) })) })); });
      await h.worker().tick(); const job = await h.get(); expect(job.candidates).toHaveLength(2); expect(JSON.parse(job.candidates.find((entry) => entry.id === first.id)!.document).pipelineStage).toBe('interview');
    } finally { h.db.close(); }
  });
});
