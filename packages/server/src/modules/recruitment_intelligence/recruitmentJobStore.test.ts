import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
import { createPostgresRecruitmentJobStore, createSqliteRecruitmentJobStore } from './recruitmentJobStore.js';
import { RecruitmentJobService, type RecruitmentSharedJob } from './recruitmentJobs.js';

const cipher = createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 19), clear() {} } });
const job: RecruitmentSharedJob = { id: 'job-1', revision: 1, title: 'private-role', description: 'private-job-description', collaboratorAccountIds: ['hr'], updatedAt: '2026-09-08T00:00:00Z', updatedBy: 'admin', candidates: [] };

describe.each(['sqlite', 'postgres SQL contract'] as const)('recruitment job store: %s', (backend) => {
  it('preserves isolated encrypted snapshots across store instances and rejects stale updates/deletes', async () => {
    const db = new Database(':memory:');
    // SQL contract harness, not a live PostgreSQL acceptance test. Exercise the
    // production adapter's SQL and parameter positions against real SQLite IO.
    const pool = { async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('CREATE TABLE')) { db.exec(sql); return { rows: [] }; }
      const ordered: unknown[] = [];
      const statement = sql.replace(/\$(\d+)/g, (_match, index: string) => { ordered.push(values[Number(index) - 1]); return '?'; });
      if (statement.startsWith('SELECT')) return { rows: db.prepare(statement).all(...ordered) };
      return { rows: [], rowCount: Number(db.prepare(statement).run(...ordered).changes) };
    } } as unknown as PostgresPoolLike;
    const create = () => backend === 'sqlite' ? createSqliteRecruitmentJobStore(() => db, cipher) : createPostgresRecruitmentJobStore(pool, cipher);
    try {
      const first = create();
      expect(await first.compareAndSet('org-a', 0, job)).toBe(true);
      const second = create();
      expect(await second.get('org-a', job.id)).toEqual(job);
      expect(await second.get('org-b', job.id)).toBeNull();
      const pending = { id: 'a'.repeat(64), receivedAt: '2026-09-08T00:00:00Z', expiresAt: '2026-09-15T00:00:00Z', material: {
        runId: 'run', requisitionId: job.id, canonicalId: 'person', source: { sourceId: 'workable', sourceLabel: 'Workable', sourceRecordId: 'record' }, acquisitionMode: 'authorized_mcp' as const,
        contentHash: 'b'.repeat(64), retrievedAt: '2026-09-08T00:00:00Z', material: { sourceRecordId: 'record', text: 'private incoming resume', completeness: 'full_text' as const },
      } };
      expect(await second.compareAndSet('org-b', 0, { ...job, incomingMaterials: [pending] })).toBe(true);
      expect((await create().get('org-b', job.id))?.incomingMaterials).toEqual([pending]);
      const scan = await second.scan!({ organizationId: '', jobId: '' }, 1);
      expect(scan.hasMore).toBe(true); expect(scan.jobs[0]?.organizationId).toBe('org-a');
      const nextPage = await second.scan!({ organizationId: 'org-a', jobId: job.id }, 1);
      expect(nextPage.jobs[0]).toMatchObject({ organizationId: 'org-b', inboxExpiry: pending.expiresAt });
      expect(nextPage.jobs[0]?.job).not.toHaveProperty('incomingMaterials');
      expect((await second.list('org-b', '')).jobs[0]).not.toHaveProperty('inboxExpiry');
      await second.remove('org-b', job.id, 1);
      expect(await second.list('org-b', '')).toEqual({ jobs: [], nextCursor: null });
      const raw = JSON.stringify(db.prepare('SELECT * FROM enterprise_recruitment_jobs_v1').all());
      expect(raw).not.toContain('private-role'); expect(raw).not.toContain('private-job-description');
      expect(raw).not.toContain('private incoming resume');
      expect(await second.compareAndSet('org-a', 0, { ...job, id: 'source-job' })).toBe(true);
      expect(await second.compareAndSet('org-a', 1, { ...job, revision: 2 }, [{ id: 'source-job', revision: 2 }])).toBe(false);
      expect(await second.compareAndSet('org-a', 1, { ...job, revision: 2 }, [{ id: 'source-job', revision: 1 }])).toBe(true);
      expect(await second.remove('org-a', 'source-job', 1)).toBe(true);
      expect(await second.compareAndSet('org-a', 2, { ...job, revision: 3 }, [{ id: 'source-job', revision: 1 }])).toBe(false);
      expect(await first.compareAndSet('org-a', 1, { ...job, revision: 2, title: 'stale' })).toBe(false);
      expect(await first.remove('org-a', job.id, 1)).toBe(false);
      expect(await first.remove('org-a', job.id, 2)).toBe(true);
      expect(await first.compareAndSet('org-a', 0, job)).toBe(false);
    } finally { db.close(); }
  });
});

it('paginates only metadata and returns a cursor rather than silently dropping jobs', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSqliteRecruitmentJobStore(() => db, cipher);
    for (let index = 0; index < 101; index += 1) await store.compareAndSet('org-a', 0, { ...job, id: `j-${String(index).padStart(3, '0')}` });
    const first = await store.list('org-a', '');
    expect(first.jobs).toHaveLength(100); expect(first.nextCursor).toBe('j-099');
    expect(first.jobs[0]).not.toHaveProperty('candidates');
    expect(await store.list('org-a', first.nextCursor!)).toMatchObject({ jobs: [{ id: 'j-100' }], nextCursor: null });
  } finally { db.close(); }
});

it('fails closed before a write when mandatory production audit is unavailable', async () => {
  const db = new Database(':memory:');
  try {
    const store = createSqliteRecruitmentJobStore(() => db, cipher);
    const service = new RecruitmentJobService({ store, getActor: async (id) => ({ id, organizationId: 'org', isAdmin: true, active: true }), audit: async () => { throw new Error('audit unavailable'); } });
    await expect(service.act('admin', { kind: 'save', jobId: 'j1', title: '前端', description: '', expectedRevision: 0, sharingConfirmed: true, candidates: [] })).rejects.toThrow('audit unavailable');
    expect(await store.get('org', 'j1')).toBeNull();
  } finally { db.close(); }
});
