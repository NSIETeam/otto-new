import { describe, expect, it, vi } from 'vitest';
import { RecruitmentAutoArchiveWorker, RecruitmentJobService, type RecruitmentJobStore, type RecruitmentSharedJob } from 'otto-server';
import { parseRecruitmentSemanticAnalysis, sanitizeRecruitmentModelInput } from 'otto-server/recruitment';
import { captureRecruitmentAssessmentContext } from '../main/recruitmentAssessment.js';
import { RECRUITMENT_SEMANTIC_DIMENSIONS } from '../main/recruitmentSemantic.js';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import { loadRecruitmentArchive, saveRecruitmentArchive, updateRecruitmentIntake } from './recruitmentArchive.js';
import { assessCandidateComparison } from './recruitmentAssessment.js';
import { importRecruitmentSourceCandidate } from './recruitmentSourceImport.js';

describe('background formal archive to desktop contract', () => {
  it('loads, compares and updates a real worker-generated dossier without a model call or losing history on desktop roundtrip', async () => {
    let current: RecruitmentSharedJob | null = null; let now = Date.now();
    const store: RecruitmentJobStore = {
      get: async () => current ? structuredClone(current) : null,
      list: async () => ({ jobs: current ? [structuredClone(current)] : [], nextCursor: null }),
      scan: async () => ({ jobs: current ? [{ organizationId: 'org', job: structuredClone(current) }] : [], hasMore: false }),
      compareAndSet: async (_org, revision, job) => { if ((current?.revision ?? 0) !== revision) return false; current = structuredClone(job); return true; },
      remove: async () => { current = null; return true; },
    };
    const getActor = async () => ({ id: 'hr', active: true, organizationId: 'org', isAdmin: false });
    const service = new RecruitmentJobService({ store, getActor, now: () => new Date(now) });
    const worker = new RecruitmentAutoArchiveWorker({ store, getActor, isEntitled: async () => true, audit: async () => undefined, now: () => now });
    await service.act('hr', { kind: 'save', jobId: 'job', expectedRevision: 0, title: '前端', description: 'React 开发', candidates: [], sharingConfirmed: true });
    await service.act('hr', { kind: 'configure_auto_archive', jobId: 'job', expectedRevision: 1, enabled: true, confirmed: true, retentionDays: 30 });
    const get = async () => (await store.get('org', 'job'))!;
    const add = async (letter: string, text: string) => {
      const job = await get(); const at = new Date(now).toISOString(); const fp = letter.repeat(64);
      const resume = sanitizeRecruitmentModelInput(text);
      const evaluation = { ...parseRecruitmentSemanticAnalysis(JSON.stringify({ summary: '简历自述支持，待面试核实', dimensions: RECRUITMENT_SEMANTIC_DIMENSIONS.map((d) => ({ ...d, score: 60, evidence: [] })) }), resume, { modelProvider: 'fixture', inputTokens: 12, outputTokens: 6 }),
        assessmentContext: await captureRecruitmentAssessmentContext({ candidateId: fp, jobTitle: job.title, jobDescription: job.description, redactedResume: resume }, 'fixture'),
        execution: { runId: letter, disposition: 'executed' as const, requestedAt: at, inputFingerprint: fp, inputTokens: 12, outputTokens: 6 } };
      await store.compareAndSet('org', job.revision, { ...job, revision: job.revision + 1, incomingMaterials: [...job.incomingMaterials ?? [], {
        id: fp, receivedAt: at, expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
        material: { runId: 'search', requisitionId: 'job', canonicalId: 'person', source: { sourceId: 'workable', sourceLabel: 'Workable', sourceRecordId: 'record' }, acquisitionMode: 'authorized_mcp', contentHash: fp, retrievedAt: at, material: { sourceRecordId: 'record', fileName: '简历.txt', text, completeness: 'full_text' } },
        analysis: { status: 'completed', runId: letter, attemptedAt: at, message: '完成', inputFingerprint: fp, modelVersion: 'fixture', redactedResume: resume, evaluation },
      }] });
    };
    await add('a', '电话：13800138000\nReact 企业应用开发，负责测试、上线及性能优化。'); await worker.tick();
    const desktop = new RecruitmentWorkspaceStore('org:hr'); const call = (action: Parameters<typeof service.act>[1]) => service.act('hr', action);
    await loadRecruitmentArchive(desktop, call, 'job');
    const first = desktop.getSnapshot().candidates[0]; expect(first).toBeTruthy();
    expect(first.backgroundArchive?.mode).toBe('created'); expect(first.analysis.redactedResume).not.toContain('13800138000');
    expect((await assessCandidateComparison([first], { jobTitle: '前端', jobDescription: 'React 开发' })).rows[0].reasons).toEqual([]);
    await saveRecruitmentArchive(desktop, call, true);
    now += 60_000; await add('b', 'React 企业应用开发，新简历补充：负责上线、测试、性能优化及交付。'); await worker.tick();
    await updateRecruitmentIntake(desktop, call, { kind: 'get', jobId: 'job' });
    const next = desktop.getSnapshot().candidates[0];
    expect(next.id).toBe(first.id); expect(next.backgroundArchive?.mode).toBe('updated');
    expect(next.analysisHistory).toHaveLength(2); expect(next.sourceHistory).toHaveLength(1);
    expect(next.expiresAt).toBe(first.expiresAt); expect(desktop.getSnapshot().audits).toHaveLength(2);
    desktop.setConsentConfirmed(true); const analyzeResume = vi.fn(); const getMaterial = vi.fn();
    await expect(importRecruitmentSourceCandidate({ store: desktop, incomingMaterialId: 'b'.repeat(64), canonicalId: 'person', sourceId: 'workable', analyzeResume, getMaterial })).rejects.toThrow('已正式入档');
    expect(analyzeResume).not.toHaveBeenCalled(); expect(getMaterial).not.toHaveBeenCalled();
  });
});
