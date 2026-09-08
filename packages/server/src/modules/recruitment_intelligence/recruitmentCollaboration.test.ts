import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createSqliteRecruitmentJobStore } from './recruitmentJobStore.js';
import { RecruitmentJobService, type RecruitmentJobActor, type RecruitmentJobAction, type RecruitmentJobResponse } from './recruitmentJobs.js';

const candidate = (id: string, note = '') => ({ id, expiresAt: '2026-10-01T00:00:00Z', document: JSON.stringify({ id, expiresAt: '2026-10-01T00:00:00Z', consentAt: '2026-09-08T00:00:00Z', retentionDays: 30, note }) });
function job(result: RecruitmentJobResponse) { if (result.kind !== 'job') throw new Error('expected job'); return result; }
describe('candidate-scoped recruitment collaboration', () => {
  let db: Database; let service: RecruitmentJobService;
  const actors = new Map<string, RecruitmentJobActor>();
  const create = (): RecruitmentJobAction => ({ kind: 'save', jobId: 'job', expectedRevision: 0, title: '前端', description: 'React', sharingConfirmed: true, candidates: [candidate('a'), candidate('b')] });
  beforeEach(() => {
    db = new Database(':memory:'); actors.clear();
    for (const id of ['admin', 'hr', 'peer', 'other', 'foreign']) actors.set(id, { id, organizationId: id === 'foreign' ? 'other-org' : 'org', isAdmin: id === 'admin', active: true });
    service = new RecruitmentJobService({ store: createSqliteRecruitmentJobStore(() => db, createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 24), clear() {} } })), getActor: async (id) => actors.get(id) ?? null, now: () => new Date('2026-09-08T12:00:00Z') });
  });
  afterEach(() => db.close());
  const patch = (base: ReturnType<typeof job>, id: string, note: string): RecruitmentJobAction => ({ kind: 'patch', jobId: base.job.id, sharingConfirmed: true, scopeToken: base.sync!.scopeToken, headerToken: base.sync!.headerToken,
    changes: [{ id, expectedToken: base.sync!.candidateTokens[id] ?? null, candidate: candidate(id, note) }] });
  it('lets a member own a new private job, but not access or manage anyone else’s job', async () => {
    const own = job(await service.act('hr', create()));
    expect(own.canManage).toBe(true); expect(own.job.ownerAccountId).toBe('hr');
    await expect(service.act('peer', { kind: 'get', jobId: 'job' })).rejects.toMatchObject({ status: 404 });
    const shared = job(await service.act('hr', { kind: 'share', jobId: 'job', expectedRevision: 1, collaboratorAccountIds: ['peer'] }));
    expect(shared.job.ownerAccountId).toBe('hr');
    expect(job(await service.act('hr', { kind: 'get', jobId: 'job' })).canManage).toBe(true);
    expect(job(await service.act('peer', { kind: 'get', jobId: 'job' })).canManage).toBe(false);
    await expect(service.act('peer', { kind: 'delete', jobId: 'job', expectedRevision: 2 })).rejects.toMatchObject({ status: 403 });
  });
  it('merges concurrent edits to different candidates without dropping either', async () => {
    await service.act('admin', create());
    const base = job(await service.act('admin', { kind: 'share', jobId: 'job', expectedRevision: 1, collaboratorAccountIds: ['hr', 'peer'] }));
    await Promise.all([service.act('hr', patch(base, 'a', 'HR 的面试笔记')), service.act('peer', patch(base, 'b', '用人负责人补充'))]);
    const latest = job(await service.act('admin', { kind: 'get', jobId: 'job' }));
    expect(latest.job.candidates.map((item) => JSON.parse(item.document).note)).toEqual(['HR 的面试笔记', '用人负责人补充']);
  });
  it('rejects conflicting edits to one candidate and supports exact retry after a lost response', async () => {
    const base = job(await service.act('admin', create()));
    const action = patch(base, 'a', '第一份修改'); const first = job(await service.act('admin', action));
    const replay = job(await service.act('admin', action)); expect(replay.job.revision).toBe(first.job.revision);
    await expect(service.act('admin', patch(base, 'a', '冲突修改'))).rejects.toMatchObject({ status: 409 });
  });
  it('stops stale autosave when job requirements or sharing scope change', async () => {
    const base = job(await service.act('admin', create()));
    await service.act('admin', { ...create(), expectedRevision: 1, description: '不同要求' });
    await expect(service.act('admin', patch(base, 'a', 'stale'))).rejects.toMatchObject({ status: 409 });
    const current = job(await service.act('admin', { kind: 'get', jobId: 'job' }));
    await service.act('admin', { kind: 'share', jobId: 'job', expectedRevision: 2, collaboratorAccountIds: ['hr'] });
    await expect(service.act('admin', patch(current, 'a', 'new audience'))).rejects.toMatchObject({ status: 409 });
  });
  it('blocks foreign, unassigned, revoked and inactive actors, and forged identity links', async () => {
    const base = job(await service.act('admin', create()));
    for (const actor of ['foreign', 'other']) await expect(service.act(actor, patch(base, 'a', 'x'))).rejects.toMatchObject({ status: 404 });
    const action = patch(base, 'a', 'x');
    if (action.kind === 'patch') action.changes[0].candidate!.personId = 'forged';
    const changed = job(await service.act('admin', action));
    expect(changed.job.candidates[0].personId).toBe(base.job.candidates[0].personId);
    actors.get('admin')!.active = false;
    await expect(service.act('admin', patch(changed, 'b', 'x'))).rejects.toMatchObject({ status: 403 });
  });
  it('does not lose other records on deletion and does not resurrect a deleted candidate on stale retry', async () => {
    const base = job(await service.act('admin', create()));
    const deletion = patch(base, 'a', ''); if (deletion.kind === 'patch') deletion.changes[0].candidate = null;
    const result = job(await service.act('admin', deletion)); expect(result.job.candidates.map((item) => item.id)).toEqual(['b']);
    await expect(service.act('admin', patch(base, 'a', 'resurrect'))).rejects.toMatchObject({ status: 409 });
    expect(job(await service.act('admin', deletion)).job.revision).toBe(result.job.revision);
  });
  it('treats an exact retry of initial creation as success instead of creating another job', async () => {
    const first = job(await service.act('hr', create()));
    expect(job(await service.act('hr', create())).job.revision).toBe(first.job.revision);
  });
  it('returns an unchanged response without material payload only after validating job access', async () => {
    const base = job(await service.act('hr', create()));
    expect(await service.act('hr', { kind: 'get', jobId: 'job', knownRevision: base.job.revision })).toEqual({ kind: 'unchanged', jobId: 'job', revision: 1 });
    await expect(service.act('other', { kind: 'get', jobId: 'job', knownRevision: 1 })).rejects.toMatchObject({ status: 404 });
  });
  it('preserves all distinct edits under contention and permits retry after the bounded CAS window', async () => {
    const base = job(await service.act('hr', { ...create(), candidates: [] }));
    const actions = Array.from({ length: 20 }, (_, index) => patch(base, `c${index}`, `note-${index}`));
    const results = await Promise.allSettled(actions.map((action) => service.act('hr', action)));
    for (const [index, result] of results.entries()) if (result.status === 'rejected') {
      expect(result.reason).toMatchObject({ status: 409 }); await service.act('hr', actions[index]);
    }
    const latest = job(await service.act('hr', { kind: 'get', jobId: 'job' }));
    expect(latest.job.candidates).toHaveLength(20); expect(new Set(latest.job.candidates.map((item) => item.id)).size).toBe(20);
  });
  it('does not partially save a patch if a later change is malformed or conflicted', async () => {
    const base = job(await service.act('hr', create()));
    const action = patch(base, 'a', 'must not save');
    if (action.kind !== 'patch') throw new Error();
    await expect(service.act('hr', { ...action, changes: [...action.changes, { id: 'b', expectedToken: null, candidate: candidate('b', 'conflict') }] })).rejects.toMatchObject({ status: 409 });
    expect(job(await service.act('hr', { kind: 'get', jobId: 'job' })).job.revision).toBe(1);
    for (const changes of [null, [null], [{ ...action.changes[0], expectedToken: '__proto__' }], [...action.changes, ...action.changes]]) {
      await expect(service.act('hr', { ...action, changes } as never)).rejects.toMatchObject({ status: 400 });
    }
  });
  it('rechecks revoked job access after losing a CAS race', async () => {
    await service.act('admin', create());
    const base = job(await service.act('admin', { kind: 'share', jobId: 'job', expectedRevision: 1, collaboratorAccountIds: ['hr'] }));
    const worker = new RecruitmentJobService({ store: createSqliteRecruitmentJobStore(() => db, createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 24), clear() {} } })), getActor: async (id) => actors.get(id) ?? null,
      now: () => new Date('2026-09-08T12:00:00Z'), audit: async (event) => {
        if (event.phase === 'requested') await service.act('admin', { kind: 'share', jobId: 'job', expectedRevision: 2, collaboratorAccountIds: [] });
      } });
    await expect(worker.act('hr', patch(base, 'a', 'revoked write'))).rejects.toMatchObject({ status: 404 });
    expect(JSON.parse(job(await service.act('admin', { kind: 'get', jobId: 'job' })).job.candidates[0].document).note).toBe('');
  });
});
