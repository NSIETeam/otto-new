import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
import { createSqliteRecruitmentUsageStore, createPostgresRecruitmentUsageStore, RecruitmentUsageLedger, readRecruitmentOrganizationBudget } from './recruitmentUsageLedger.js';

const budget = { dailyRequests: 2, dailyReservedTokens: 20_000 };
const cipher = createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 31), clear() {} } });
const request = (key = 'a'.repeat(64), runId = 'first') => ({ key, runId, reservedTokens: 10_000 });

describe.each(['sqlite', 'postgres SQL contract'] as const)('enterprise recruitment usage ledger: %s', (backend) => {
  function fixture() {
    const db = new Database(':memory:'); let now = Date.parse('2026-09-08T15:59:00Z');
    // Real SQLite IO, translated PostgreSQL SQL contract; NOT a PostgreSQL concurrency acceptance test.
    const pool = { async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('CREATE TABLE')) { db.exec(sql); return { rows: [] }; }
      const ordered: unknown[] = []; const statement = sql.replace(/\$(\d+)/g, (_m, i: string) => { ordered.push(values[Number(i) - 1]); return '?'; });
      if (statement.startsWith('SELECT')) return { rows: db.prepare(statement).all(...ordered) };
      return { rows: [], rowCount: Number(db.prepare(statement).run(...ordered).changes) };
    } } as unknown as PostgresPoolLike;
    const store = () => backend === 'sqlite' ? createSqliteRecruitmentUsageStore(() => db, cipher) : createPostgresRecruitmentUsageStore(pool, cipher);
    return { db, ledger: () => new RecruitmentUsageLedger(store(), () => now), advance: (ms: number) => { now += ms; } };
  }
  it('admits at most the enterprise total across 25 independently constructed workers and different jobs', async () => {
    const h = fixture(); try {
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => h.ledger().reserve('org', budget, request(i.toString(16).padStart(64, '0'), `run-${i}`))));
      expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(2);
      expect(await h.ledger().snapshot('org', budget)).toMatchObject({ requests: 2, reservedTokens: 20_000, unknownRequests: 2, dailyRequests: 2 });
      expect((await h.ledger().reserve('other-org', budget, request())).kind).toBe('reserved');
    } finally { h.db.close(); }
  });
  it('does not let another entry, restarted instance, day rollover or lower limits replay an uncertain attempt', async () => {
    const h = fixture(); try {
      expect((await h.ledger().reserve('org', budget, request())).kind).toBe('reserved');
      expect(await h.ledger().reserve('org', budget, request('a'.repeat(64), 'another-item'))).toMatchObject({ kind: 'duplicate', runId: 'first', status: 'reserved' });
      h.advance(60_000);
      expect(await h.ledger().snapshot('org', budget)).toMatchObject({ requests: 0 });
      expect((await h.ledger().reserve('org', budget, request())).kind).toBe('duplicate');
      await h.ledger().finish('org', 'first', 'unknown', { inputTokens: null, outputTokens: null });
      h.advance(91 * 86_400_000);
      expect(await h.ledger().reserve('org', { dailyRequests: 1, dailyReservedTokens: 10_000 }, request())).toMatchObject({ kind: 'duplicate', status: 'unknown' });
    } finally { h.db.close(); }
  });
  it('settles actual usage once without refunding reservations and rejects unknown counts as zero', async () => {
    const h = fixture(); try {
      await h.ledger().reserve('org', budget, request());
      await Promise.all(Array.from({ length: 25 }, () => h.ledger().finish('org', 'first', 'completed', { inputTokens: 500, outputTokens: 100 })));
      expect(await h.ledger().snapshot('org', budget)).toMatchObject({ requests: 1, reservedTokens: 10_000, inputTokens: 500, outputTokens: 100, unknownRequests: 0 });
      await h.ledger().reserve('org', budget, request('b'.repeat(64), 'second'));
      await h.ledger().finish('org', 'second', 'unknown', { inputTokens: 10, outputTokens: null });
      expect(await h.ledger().snapshot('org', budget)).toMatchObject({ inputTokens: 510, outputTokens: 100, unknownRequests: 1 });
      expect((await h.ledger().reserve('org', budget, request('c'.repeat(64), 'third'))).kind).toBe('budget');
      expect(JSON.stringify(h.db.prepare('SELECT * FROM enterprise_recruitment_usage_v1').all())).not.toMatch(/first|second|inputTokens|aaaaaaaa/u);
    } finally { h.db.close(); }
  });
  it('rejects malformed reservations and fails safely when the ledger is unavailable', async () => {
    const h = fixture(); try {
      await expect(h.ledger().reserve('org', budget, { ...request(), reservedTokens: -1 })).rejects.toThrow();
      await expect(h.ledger().reserve('org', budget, { ...request(), key: 'resume body' })).rejects.toThrow();
      await expect(h.ledger().reserve('org', { ...budget, dailyRequests: NaN }, request())).rejects.toThrow();
      expect(await h.ledger().snapshot('org', budget)).toMatchObject({ requests: 0 });
      const failed = new RecruitmentUsageLedger({ get: async () => { throw new Error('unavailable'); }, compareAndSet: async () => false });
      await expect(failed.reserve('org', budget, request())).rejects.toThrow();
    } finally { h.db.close(); }
  });
});

it('requires an exact, unambiguous operator-owned enterprise budget; no default or wildcard', () => {
  const env = { OTTO_RECRUITMENT_ORGANIZATION_BUDGETS: JSON.stringify([{ organizationId: 'org', ...budget }]) };
  expect(readRecruitmentOrganizationBudget('org', env)).toEqual(budget);
  expect(readRecruitmentOrganizationBudget('other', env)).toBeNull();
  for (const value of ['{}', 'bad-json', JSON.stringify([{ organizationId: '*', ...budget }]), JSON.stringify([{ organizationId: 'org', ...budget }, { organizationId: 'org', ...budget }]), JSON.stringify([{ organizationId: 'org', ...budget, dailyRequests: 0 }])]) {
    expect(readRecruitmentOrganizationBudget('org', { OTTO_RECRUITMENT_ORGANIZATION_BUDGETS: value })).toBeNull();
  }
});
