import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { reapplyPrivacyDeletionTombstones } from '../data_governance/dataGovernanceRepository.js';
import { createSqliteRecruitmentSourceStore, deleteSqliteRecruitmentSearchesForAccount, MemoryRecruitmentSourceStore } from './recruitmentSourceStore.js';

const start = Date.parse('2026-09-08T00:00:00Z');
const ttl = 86_400_000;
const cipher = createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 17), clear() {} } });
const run = (id = 'run', actor = 'hr', org = 'org') => ({ runId: id, organizationId: org, actorAccountId: actor, requisitionId: 'job', query: 'private-query', createdAt: new Date(start).toISOString(), candidates: [], sources: [] });
function fixture() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE accounts (id TEXT, organization_id TEXT, status TEXT, deleted_at TEXT); INSERT INTO accounts VALUES ('hr','org','active',NULL),('peer','org','active',NULL),('hr','other','active',NULL);");
  let clock = start;
  return { db, store: createSqliteRecruitmentSourceStore(() => db, cipher, { now: () => clock }), advance: (ms: number) => { clock += ms; } };
}
describe.each(['sqlite', 'memory'])('recruitment temporary cache lifecycle: %s', (kind) => {
  it('hides search results and cursors exactly at 24 hours, then physically purges in bounded batches', async () => {
    const f = fixture(); let clock = start;
    const store = kind === 'sqlite' ? f.store : new MemoryRecruitmentSourceStore({ now: () => clock });
    try {
      await store.saveSearchRun(run()); await store.saveSearchRun(run('second'));
      await store.setCursor({ organizationId: 'org', sourceId: 'workable', cursor: 'private-cursor', updatedAt: new Date(start).toISOString() });
      clock += ttl - 1; f.advance(ttl - 1);
      expect(await store.getSearchRun('org', 'run')).not.toBeNull();
      clock++; f.advance(1);
      expect(await store.getSearchRun('org', 'run')).toBeNull();
      expect(await store.listSearchRuns('org', 'job', 20)).toEqual([]);
      expect(await store.getCursor('org', 'workable')).toBeNull();
      expect(await store.purgeExpired(2)).toBe(2);
      expect(await store.purgeExpired(2)).toBe(1);
      expect(await store.purgeExpired(2)).toBe(0);
      if (kind === 'sqlite') expect(f.db.prepare('SELECT COUNT(*) AS count FROM enterprise_recruitment_records_v1').get()).toEqual({ count: 0 });
    } finally { f.db.close(); }
  });
});
it('deletes only the target account search snapshots, including old encrypted records without owner columns', async () => {
  const f = fixture();
  try {
    await f.store.saveSearchRun(run()); await f.store.saveSearchRun(run('peer', 'peer')); await f.store.saveSearchRun(run('foreign', 'hr', 'other'));
    f.db.exec("CREATE TABLE enterprise_recruitment_jobs_v1 (payload TEXT); INSERT INTO enterprise_recruitment_jobs_v1 VALUES ('shared-candidate');");
    f.db.exec('BEGIN IMMEDIATE');
    expect(deleteSqliteRecruitmentSearchesForAccount(f.db, cipher, 'org', 'hr')).toBe(1);
    f.db.prepare("UPDATE accounts SET status='disabled',deleted_at='deleted' WHERE id=? AND organization_id=?").run('hr', 'org');
    f.db.exec('COMMIT');
    await expect(f.store.saveSearchRun(run('late-request'))).rejects.toThrow(/账号/);
    expect(await f.store.getSearchRun('org', 'peer')).not.toBeNull();
    expect(await f.store.getSearchRun('other', 'foreign')).not.toBeNull();
    expect(f.db.prepare('SELECT payload FROM enterprise_recruitment_jobs_v1').get()).toEqual({ payload: 'shared-candidate' });
  } finally { f.db.close(); }
});
it('rolls back deletion on corrupt ciphertext instead of falsely claiming completion or deleting a coworker record', async () => {
  const f = fixture();
  try {
    await f.store.saveSearchRun(run('a')); await f.store.saveSearchRun(run('z', 'peer'));
    f.db.prepare("UPDATE enterprise_recruitment_records_v1 SET payload='corrupt' WHERE record_id='z'").run();
    f.db.exec('BEGIN IMMEDIATE');
    expect(() => deleteSqliteRecruitmentSearchesForAccount(f.db, cipher, 'org', 'hr')).toThrow();
    f.db.exec('ROLLBACK');
    expect(await f.store.getSearchRun('org', 'a')).not.toBeNull();
  } finally { f.db.close(); }
});
it('replays deletion for an already-deleted account restored with a legacy search snapshot', async () => {
  const f = fixture();
  try {
    await f.store.saveSearchRun(run()); await f.store.saveSearchRun(run('peer', 'peer'));
    f.db.exec("ALTER TABLE accounts ADD COLUMN account_type TEXT; ALTER TABLE accounts ADD COLUMN employee_id TEXT; ALTER TABLE accounts ADD COLUMN username TEXT; ALTER TABLE accounts ADD COLUMN name TEXT; ALTER TABLE accounts ADD COLUMN is_admin INTEGER; UPDATE accounts SET deleted_at='deleted' WHERE id='hr' AND organization_id='org';");
    const store = { db: () => f.db, fieldCipher: cipher, now: () => start, createId: () => 'id', createDeletionPasswordHash: () => 'unused', appendDeletionTombstone() {} };
    const tombstones = [{ accountId: 'hr', organizationId: 'org', requestedAtMs: start }];
    expect(reapplyPrivacyDeletionTombstones(store, tombstones)).toBe(0);
    expect(await f.store.getSearchRun('org', 'run')).toBeNull();
    expect(await f.store.getSearchRun('org', 'peer')).not.toBeNull();
    expect(reapplyPrivacyDeletionTombstones(store, tombstones)).toBe(0);
  } finally { f.db.close(); }
});
