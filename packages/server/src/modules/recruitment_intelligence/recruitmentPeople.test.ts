import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createSqliteRecruitmentJobStore, type RecruitmentJobStore } from './recruitmentJobStore.js';
import { RecruitmentJobService, type RecruitmentJobAction, type RecruitmentJobActor } from './recruitmentJobs.js';
import { recruitmentIdentityMatch } from './recruitmentPeople.js';

const now = '2026-09-08T12:00:00.000Z';
const expiresAt = '2026-10-01T00:00:00.000Z';
function candidate(id = 'c1', identity = { name: '同名候选人', email: 'person@example.test', phone: '13800138000' }) {
  return { id, expiresAt, document: JSON.stringify({ id, fileName: 'resume.txt', expiresAt, consentAt: '2026-09-08T00:00:00.000Z', retentionDays: 30,
    analysis: { candidateId: id, identity, redactedResume: 'React 项目交付原文', skills: ['React'], timeline: [], experiences: [], projects: [], findings: [{ criterion: '旧岗位要求' }], questions: ['旧面试问题'], engineVersion: 'v2', createdAt: now },
    sources: [], transcriptText: '原始面试回答', transcriptReport: { oldRole: true }, transcriptWarning: '', workSampleText: '实战材料',
    semanticEvaluation: { overallScore: 99 }, decision: { decision: 'shortlist' }, sourceHistory: [{ evaluation: { overallScore: 98 } }], pipelineStage: 'interview', archiveVersion: 1, archiveAudits: [],
  }) };
}
describe('cross-job candidate reuse', () => {
  let db: Database;
  let store: RecruitmentJobStore;
  let service: RecruitmentJobService;
  let actors: Map<string, RecruitmentJobActor>;
  const save = (jobId: string, items = [candidate()], expectedRevision = 0): RecruitmentJobAction => ({ kind: 'save', jobId, title: jobId, description: `Requirements for ${jobId}`, candidates: items, expectedRevision, sharingConfirmed: true });
  const get = async (jobId: string) => {
    const result = await service.act('admin', { kind: 'get', jobId });
    if (result.kind !== 'job') throw new Error('unexpected result');
    return result.job;
  };
  beforeEach(() => {
    db = new Database(':memory:');
    store = createSqliteRecruitmentJobStore(() => db, createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 23), clear() {} } }));
    actors = new Map([['admin', { id: 'admin', organizationId: 'org-a', isAdmin: true, active: true }], ['hr', { id: 'hr', organizationId: 'org-a', isAdmin: false, active: true }], ['foreign', { id: 'foreign', organizationId: 'org-b', isAdmin: true, active: true }]]);
    service = new RecruitmentJobService({ store, getActor: async (id) => actors.get(id) ?? null, now: () => new Date(now) });
  });
  afterEach(() => db.close());
  it('assigns server-owned identity, ignores forgery and preserves it across ordinary saves', async () => {
    await service.act('admin', save('source', [{ ...candidate(), personId: 'forged' }] as Array<ReturnType<typeof candidate>>));
    const first = await get('source');
    expect(first.candidates[0]?.personId).toMatch(/^person:/);
    await service.act('admin', save('source', [candidate()], 1));
    expect((await get('source')).candidates[0]?.personId).toBe(first.candidates[0]?.personId);
  });
  it('copies raw materials, resets all role assessments, retains expiry and links identities', async () => {
    await service.act('admin', save('source')); await service.act('admin', save('target', []));
    const source = await get('source');
    const result = await service.act('admin', { kind: 'copy_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 1, targetJobId: 'target', targetRevision: 1, sharingConfirmed: true });
    expect(result.kind).toBe('job');
    const copied = (await get('target')).candidates[0]!;
    expect(copied.personId).toBe(source.candidates[0]!.personId);
    expect(copied.expiresAt).toBe(expiresAt);
    expect(JSON.parse(copied.document)).toMatchObject({ pipelineStage: 'new', semanticEvaluation: null, decision: null, transcriptReport: null, transcriptText: '原始面试回答', workSampleText: '实战材料', analysis: { redactedResume: 'React 项目交付原文', findings: [], questions: [] }, sourceHistory: [] });
    expect(await get('source')).toEqual(source);
    await expect(service.act('admin', { kind: 'copy_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 1, targetJobId: 'target', targetRevision: 2, sharingConfirmed: true })).rejects.toMatchObject({ status: 409 });
  });
  it('finds strong contact matches but not same-name or single-contact matches; does not merge silently', async () => {
    await service.act('admin', save('source'));
    await service.act('admin', save('pair', [candidate('c2')]));
    await service.act('admin', save('name-only', [candidate('c3', { name: '同名候选人', email: '', phone: '' })]));
    await service.act('admin', save('phone-only', [candidate('c4', { name: '同名候选人', email: 'other@example.test', phone: '13800138000' })]));
    const result = await service.act('admin', { kind: 'related', jobId: 'source', candidateId: 'c1' });
    expect(result).toMatchObject({ kind: 'related', matches: [{ jobId: 'pair', candidateId: 'c2', reason: 'contact_pair', stage: 'interview' }] });
    expect((await get('pair')).candidates[0]!.personId).not.toBe((await get('source')).candidates[0]!.personId);
    await expect(service.act('admin', { kind: 'copy_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 1, targetJobId: 'pair', targetRevision: 1, sharingConfirmed: true })).rejects.toMatchObject({ status: 409 });
    expect((await get('pair')).candidates).toHaveLength(1);
  });
  it('links two existing applications only after confirmation without overwriting either analysis', async () => {
    await service.act('admin', save('source')); await service.act('admin', save('target', [candidate('c2')]));
    const before = await get('target');
    await service.act('admin', { kind: 'link_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 1, targetJobId: 'target', targetCandidateId: 'c2', targetRevision: 1, sharingConfirmed: true });
    const after = await get('target');
    expect(after.candidates[0]!.document).toBe(before.candidates[0]!.document);
    expect(after.candidates[0]!.personId).toBe((await get('source')).candidates[0]!.personId);
    expect(await service.act('admin', { kind: 'related', jobId: 'source', candidateId: 'c1' })).toMatchObject({ matches: [{ reason: 'linked' }] });
    await service.act('admin', { kind: 'unlink_candidate', jobId: 'target', candidateId: 'c2', expectedRevision: 2, confirmed: true });
    expect((await get('target')).candidates[0]!.document).toBe(before.candidates[0]!.document);
    expect((await get('target')).candidates[0]!.personId).not.toBe((await get('source')).candidates[0]!.personId);
  });
  it('hides unauthorized jobs and blocks cross-tenant or unconfirmed copies', async () => {
    await service.act('admin', save('source')); await service.act('admin', save('hidden'));
    await service.act('admin', { kind: 'share', jobId: 'source', expectedRevision: 1, collaboratorAccountIds: ['hr'] });
    expect(await service.act('hr', { kind: 'related', jobId: 'source', candidateId: 'c1' })).toMatchObject({ matches: [] });
    const copy: RecruitmentJobAction = { kind: 'copy_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 2, targetJobId: 'hidden', targetRevision: 1, sharingConfirmed: true };
    await expect(service.act('hr', copy)).rejects.toMatchObject({ status: 404 });
    await expect(service.act('foreign', copy)).rejects.toMatchObject({ status: 404 });
    await expect(service.act('admin', { ...copy, sharingConfirmed: false } as unknown as RecruitmentJobAction)).rejects.toMatchObject({ status: 400 });
  });
  it('checks both revisions in the atomic write, including revocation after reads', async () => {
    await service.act('admin', save('source')); await service.act('admin', save('target', []));
    const original = store.compareAndSet.bind(store);
    store.compareAndSet = async (org, revision, job, dependencies) => {
      if (job.id === 'target') await original(org, 1, { ...(await get('source')), revision: 2, collaboratorAccountIds: [] });
      return original(org, revision, job, dependencies);
    };
    await expect(service.act('admin', { kind: 'copy_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 1, targetJobId: 'target', targetRevision: 1, sharingConfirmed: true })).rejects.toMatchObject({ status: 409 });
    expect((await get('target')).candidates).toEqual([]);
  });
  it('concurrent copies accept only one and expired candidates cannot be reused', async () => {
    await service.act('admin', save('source')); await service.act('admin', save('target', []));
    const action: RecruitmentJobAction = { kind: 'copy_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 1, targetJobId: 'target', targetRevision: 1, sharingConfirmed: true };
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.act('admin', action)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await get('target')).candidates).toHaveLength(1);
    const expired = new RecruitmentJobService({ store, getActor: async (id) => actors.get(id) ?? null, now: () => new Date('2026-11-01') });
    await expect(expired.act('admin', { ...action, targetRevision: 2 })).rejects.toMatchObject({ status: 404 });
  });
  it('normalizes paired contacts and keeps source conflicts as review hints without treating names as identity', () => {
    const left = candidate();
    const right = candidate('other', { name: '另一写法', email: 'PERSON@EXAMPLE.TEST', phone: '+86 138 0013 8000' });
    expect(recruitmentIdentityMatch(left, right)).toBe('contact_pair');
    const source = (item: ReturnType<typeof candidate>, sourceId: string) => ({ ...item, document: JSON.stringify({ ...JSON.parse(item.document), sourceMaterial: { source: { sourceId, sourceRecordId: '123' } } }) });
    const conflict = candidate('different', { name: '同名候选人', email: 'different@example.test', phone: '13900139000' });
    expect(recruitmentIdentityMatch(source(left, 'ats-a'), source(conflict, 'ats-a'))).toBe('conflict');
    expect(recruitmentIdentityMatch(source(left, 'ats-a'), source(conflict, 'ats-b'))).toBeNull();
  });
  it('does not drop matches after the first bounded page of jobs', async () => {
    await service.act('admin', save('source'));
    for (let index = 0; index < 16; index += 1) await service.act('admin', save(`job-${String(index).padStart(2, '0')}`, [candidate(`c-${index}`)]));
    const first = await service.act('admin', { kind: 'related', jobId: 'source', candidateId: 'c1' });
    if (first.kind !== 'related') throw new Error('unexpected result');
    expect(first.matches).toHaveLength(15); expect(first.nextCursor).toBe('job-14');
    const second = await service.act('admin', { kind: 'related', jobId: 'source', candidateId: 'c1', cursor: first.nextCursor! });
    expect(second).toMatchObject({ matches: [{ jobId: 'job-15' }], nextCursor: null });
  });
  it('allows assigned HR to reuse between two authorized jobs but not after target revocation', async () => {
    await service.act('admin', save('source')); await service.act('admin', save('target', []));
    for (const jobId of ['source', 'target']) await service.act('admin', { kind: 'share', jobId, expectedRevision: 1, collaboratorAccountIds: ['hr'] });
    const action: RecruitmentJobAction = { kind: 'copy_candidate', jobId: 'source', candidateId: 'c1', expectedRevision: 2, targetJobId: 'target', targetRevision: 2, sharingConfirmed: true };
    expect(await service.act('hr', action)).toMatchObject({ job: { id: 'target', revision: 3 }, canManage: false });
    await service.act('admin', { kind: 'share', jobId: 'target', expectedRevision: 3, collaboratorAccountIds: [] });
    expect(await service.act('hr', { kind: 'related', jobId: 'source', candidateId: 'c1' })).toMatchObject({ matches: [] });
    await expect(service.act('hr', action)).rejects.toMatchObject({ status: 404 });
  });
});
