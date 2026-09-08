import { expect, it, vi } from 'vitest';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createPostgresRecruitmentSourceStore, createSqliteRecruitmentSourceStore, deletePostgresRecruitmentSearchesForAccount } from './recruitmentSourceStore.js';

const clock = Date.parse('2026-09-08T00:00:00Z');
const cipher = createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 17), clear() {} } });
const run = (id = 'run', actor = 'hr') => ({ runId: id, organizationId: 'org', actorAccountId: actor, requisitionId: 'job', query: 'private query', createdAt: new Date(clock).toISOString(), candidates: [], sources: [] });

it('uses an account row lock in the insert itself and rejects a post-deletion insert', async () => {
  let active = true;
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: [], rowCount: sql.includes('WITH owner') && active ? 1 : 0 }));
  const store = createPostgresRecruitmentSourceStore({ query } as unknown as PostgresPoolLike, cipher, { now: () => clock });
  await store.saveSearchRun(run());
  const [sql, values] = query.mock.calls.find(([text]) => text.includes('WITH owner'))!;
  expect(sql).toContain("id=$6 AND organization_id=$1 AND status='active' AND deleted_at IS NULL FOR SHARE");
  expect(sql).toContain("SELECT $1,'search',$2,$3,$4,$5 FROM owner");
  expect(values).toEqual(['org', 'run', 'job', expect.any(String), new Date(clock).toISOString(), 'hr']);
  expect(values![3]).not.toContain('private query');
  active = false;
  await expect(store.saveSearchRun(run('late'))).rejects.toThrow(/账号/);
});

it('applies the TTL predicate to all reads and rechecks expiry on the outer DELETE for concurrent cursor refreshes', async () => {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: [], rowCount: sql.startsWith('DELETE') ? 2 : 0 }));
  const store = createPostgresRecruitmentSourceStore({ query } as unknown as PostgresPoolLike, cipher, { now: () => clock });
  await store.getSearchRun('org', 'run'); await store.listSearchRuns('org', 'job', 20); await store.getCursor('org', 'source');
  for (const [sql, values] of query.mock.calls.filter(([text]) => text.trimStart().startsWith('SELECT'))) {
    expect(sql).toMatch(/updated_at>\$3/);
    expect(values![2]).toBe('2026-09-07T00:00:00.000Z');
  }
  expect(await store.purgeExpired(2)).toBe(2);
  const [sql, values] = query.mock.calls.find(([text]) => text.startsWith('DELETE'))!;
  expect(sql).toContain('WHERE updated_at<=$1 AND (organization_id,record_kind,record_id) IN');
  expect(sql).toContain('ORDER BY updated_at LIMIT $2');
  expect(values).toEqual(['2026-09-07T00:00:00.000Z', 2]);
  await expect(store.purgeExpired(501)).rejects.toThrow(/limit/);
});

// Executes the scoped row operations against isolated SQLite fixtures. This is
// a PostgreSQL adapter contract test, not a claim of live PostgreSQL acceptance.
it('cleans legacy encrypted owner data across pages without deleting a coworker or a cursor', async () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE accounts (id TEXT, organization_id TEXT, status TEXT, deleted_at TEXT); INSERT INTO accounts VALUES ('hr','org','active',NULL),('peer','org','active',NULL);");
    const store = createSqliteRecruitmentSourceStore(() => db, cipher, { now: () => clock });
    for (let i = 0; i < 101; i++) await store.saveSearchRun(run(`run-${String(i).padStart(3, '0')}`, i % 2 ? 'peer' : 'hr'));
    await store.setCursor({ organizationId: 'org', sourceId: 'source', cursor: 'opaque', updatedAt: new Date(clock).toISOString() });
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('to_regclass')) return { rows: [{ present: true }], rowCount: 1 };
      const statement = db.prepare(sql.replace(/\$[12]/g, '?'));
      if (sql.startsWith('SELECT')) { const rows = statement.all(...values); return { rows, rowCount: rows.length }; }
      return { rows: [], rowCount: Number(statement.run(...values).changes) };
    });
    db.exec('BEGIN IMMEDIATE');
    expect(await deletePostgresRecruitmentSearchesForAccount({ query } as unknown as PostgresPoolLike, cipher, 'org', 'hr')).toBe(51);
    db.exec('COMMIT');
    expect(await store.getSearchRun('org', 'run-000')).toBeNull();
    expect((await store.listSearchRuns('org', 'job', 200)).length).toBe(50);
    expect(await store.getCursor('org', 'source')).not.toBeNull();
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('SELECT record_id')).length).toBe(4);
  } finally { db.close(); }
});
