import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createSqliteRecruitmentJobStore } from './recruitmentJobStore.js';
import { RecruitmentJobService, type RecruitmentJobActor, type RecruitmentJobAction } from './recruitmentJobs.js';

describe('enterprise recruitment job archive', () => {
  let db: Database;
  let service: RecruitmentJobService;
  const actors = new Map<string, RecruitmentJobActor>();
  const expiresAt = '2026-10-01T00:00:00.000Z';
  const candidate = { id: 'candidate-1', expiresAt, document: JSON.stringify({ id: 'candidate-1', expiresAt, consentAt: '2026-09-08T00:00:00.000Z', retentionDays: 30, fileName: 'private-resume.pdf' }) };
  const save: RecruitmentJobAction = { kind: 'save', jobId: 'frontend', expectedRevision: 0, title: '前端工程师', description: 'React', candidates: [candidate], sharingConfirmed: true };
  beforeEach(() => {
    db = new Database(':memory:');
    actors.clear();
    for (const [id, organizationId, isAdmin] of [['admin', 'org-a', true], ['hr', 'org-a', false], ['other', 'org-a', false], ['foreign', 'org-b', true]] as const) actors.set(id, { id, organizationId, isAdmin, active: true });
    service = new RecruitmentJobService({ store: createSqliteRecruitmentJobStore(() => db, createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 31), clear() {} } })), getActor: async (id) => actors.get(id) ?? null, now: () => new Date('2026-09-08T12:00:00Z') });
  });
  afterEach(() => db.close());
  it('persists encrypted materials and lets an assigned non-admin continue the same job', async () => {
    await service.act('admin', save);
    expect(JSON.stringify(db.prepare('SELECT * FROM enterprise_recruitment_jobs_v1').all())).not.toContain('private-resume');
    await service.act('admin', { kind: 'share', jobId: 'frontend', expectedRevision: 1, collaboratorAccountIds: ['hr'] });
    const result = await service.act('hr', { kind: 'get', jobId: 'frontend' });
    expect(result).toMatchObject({ kind: 'job', job: { revision: 2, candidates: [candidate] } });
    expect(await service.act('hr', { ...save, expectedRevision: 2, description: 'React + TypeScript' })).toMatchObject({ job: { revision: 3, updatedBy: 'hr' } });
  });
  it('blocks unassigned users, foreign tenants, inactive users and grants to foreign accounts', async () => {
    await service.act('admin', save);
    for (const actor of ['hr', 'foreign']) await expect(service.act(actor, { kind: 'get', jobId: 'frontend' })).rejects.toMatchObject({ status: 404 });
    expect(await service.act('hr', { kind: 'list' })).toMatchObject({ jobs: [] });
    await expect(service.act('hr', save)).rejects.toMatchObject({ status: 404 });
    await expect(service.act('admin', { kind: 'share', jobId: 'frontend', expectedRevision: 1, collaboratorAccountIds: ['foreign'] })).rejects.toMatchObject({ status: 400 });
    actors.get('admin')!.active = false;
    await expect(service.act('admin', { kind: 'get', jobId: 'frontend' })).rejects.toMatchObject({ status: 403 });
  });
  it('does not allow collaborators to change ACL and revocation prevents stale writes', async () => {
    await service.act('admin', save);
    await service.act('admin', { kind: 'share', jobId: 'frontend', expectedRevision: 1, collaboratorAccountIds: ['hr'] });
    await expect(service.act('hr', { kind: 'share', jobId: 'frontend', expectedRevision: 2, collaboratorAccountIds: ['other'] })).rejects.toMatchObject({ status: 403 });
    await service.act('admin', { kind: 'share', jobId: 'frontend', expectedRevision: 2, collaboratorAccountIds: [] });
    await expect(service.act('hr', { ...save, expectedRevision: 2 })).rejects.toMatchObject({ status: 404 });
  });
  it('accepts one of 30 concurrent saves, never overwrites newer changes', async () => {
    await service.act('admin', save);
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => service.act('admin', { ...save, expectedRevision: 1 })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').every((result) => result.reason.status === 409)).toBe(true);
  });
  it('requires explicit sharing consent and rejects duplicates, oversized or forged retention metadata', async () => {
    await expect(service.act('admin', { ...save, sharingConfirmed: false } as unknown as RecruitmentJobAction)).rejects.toMatchObject({ status: 400 });
    await expect(service.act('admin', { ...save, candidates: [candidate, candidate] })).rejects.toMatchObject({ status: 400 });
    await expect(service.act('admin', { ...save, candidates: [{ ...candidate, expiresAt: '2035-01-01' }] })).rejects.toMatchObject({ status: 400 });
    await expect(service.act('admin', { ...save, title: 'x'.repeat(501) })).rejects.toMatchObject({ status: 400 });
  });
  it('deletes materials without allowing a delayed create to resurrect the same archive', async () => {
    await service.act('admin', save);
    await service.act('admin', { kind: 'delete', jobId: 'frontend', expectedRevision: 1 });
    expect(await service.act('admin', { kind: 'list' })).toMatchObject({ jobs: [] });
    await expect(service.act('admin', save)).rejects.toMatchObject({ status: 409 });
    expect(db.prepare('SELECT header,payload FROM enterprise_recruitment_jobs_v1').get()).toEqual({ header: '', payload: '' });
  });
  it('clears expired documents without exposing them or retaining copies in previous job revisions', async () => {
    await service.act('admin', save);
    const expiredService = new RecruitmentJobService({ store: createSqliteRecruitmentJobStore(() => db, createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 31), clear() {} } })), getActor: async (id) => actors.get(id) ?? null, now: () => new Date('2026-10-02T00:00:00Z') });
    expect(await expiredService.act('admin', { kind: 'get', jobId: 'frontend' })).toMatchObject({ job: { candidates: [], revision: 2 } });
  });
});
