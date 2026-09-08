import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
import { createPostgresWorkableConnectionStore, createSqliteWorkableConnectionStore, revokeSqliteWorkableConnectionsForAccount, type WorkableConnectionRecord } from './workableConnectionStore.js';

const cipher = createEncryptedFieldCipher({ keyProvider: { getKey: () => Buffer.alloc(32, 17), clear() {} } });
it('does not initialize Workable storage when deleting an account without a connection', () => {
  const db = new Database(':memory:');
  try {
    revokeSqliteWorkableConnectionsForAccount(db, 'org', 'hr');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  } finally { db.close(); }
});

it('revokes only the exact owner, blocks stale callbacks and stays inside the account deletion transaction', async () => {
  const db = new Database(':memory:');
  const store = createSqliteWorkableConnectionStore(() => db, cipher);
  const entry: WorkableConnectionRecord = {
    revision: 1,
    grant: { id: 'grant', accessToken: 'private-token', expiresAt: '2099-01-01T00:00:00Z', targets: [] },
    bindings: [],
  };
  try {
    for (const [org, account] of [['org', 'hr'], ['org', 'other'], ['other', 'hr']]) {
      expect(await store.compareAndSet(org, account, 0, entry)).toBe(true);
    }
    db.exec('BEGIN');
    revokeSqliteWorkableConnectionsForAccount(db, 'org', 'hr');
    expect(await store.get('org', 'hr')).toEqual({ revision: 2, grant: null, bindings: [] });
    db.exec('ROLLBACK');
    expect(await store.get('org', 'hr')).toEqual(entry);

    revokeSqliteWorkableConnectionsForAccount(db, 'org', 'hr');
    expect(await store.get('org', 'hr')).toEqual({ revision: 2, grant: null, bindings: [] });
    expect(await store.compareAndSet('org', 'hr', 1, { ...entry, revision: 2 })).toBe(false);
    expect(await store.get('org', 'other')).toEqual(entry);
    expect(await store.get('other', 'hr')).toEqual(entry);
    expect(db.prepare('SELECT payload FROM enterprise_workable_connections_v1 WHERE organization_id=? AND account_id=?').get('org', 'hr')).toEqual({ payload: '' });
  } finally { db.close(); }
});

describe.each(['sqlite', 'postgres SQL contract'])('Workable encrypted connection: %s', (backend) => {
  it('encrypts tokens and account catalogs, isolates owners, persists tombstones and rejects stale writes', async () => {
    const db = new Database(':memory:');
    const pool = { async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('CREATE TABLE')) { db.exec(sql); return { rows: [] }; }
      const ordered: unknown[] = [];
      const statement = sql.replace(/\$(\d+)/g, (_match, n: string) => { ordered.push(values[Number(n) - 1]); return '?'; });
      return statement.startsWith('SELECT') ? { rows: db.prepare(statement).all(...ordered) } : { rows: [], rowCount: Number(db.prepare(statement).run(...ordered).changes) };
    } } as unknown as PostgresPoolLike;
    const create = () => backend === 'sqlite' ? createSqliteWorkableConnectionStore(() => db, cipher) : createPostgresWorkableConnectionStore(pool, cipher);
    const entry: WorkableConnectionRecord = { revision: 1, grant: { id: 'grant', accessToken: 'private-token', expiresAt: '2099-01-01T00:00:00Z', targets: [{ account: 'private-account', shortcode: 'FRONT', label: 'private-job' }] }, bindings: [], pendingOAuth: { phase: 'waiting', state: 'private-state', verifier: 'private-pkce', redirectUri: 'http://127.0.0.1:45678/otto-workable-callback', clientId: 'private-client', expiresAt: 9_999_999_999_999 } };
    try {
      expect(await create().compareAndSet('org', 'hr', 0, entry)).toBe(true);
      expect(await create().get('org', 'hr')).toEqual(entry);
      expect(await create().get('org', 'other')).toBeNull();
      expect(await create().get('other', 'hr')).toBeNull();
      const raw = JSON.stringify(db.prepare('SELECT * FROM enterprise_workable_connections_v1').all());
      for (const secret of ['private-token', 'private-account', 'private-job', 'private-state', 'private-pkce', 'private-client']) expect(raw).not.toContain(secret);
      expect(await create().compareAndSet('org', 'hr', 1, { revision: 2, grant: null, bindings: [] })).toBe(true);
      expect(await create().compareAndSet('org', 'hr', 0, entry)).toBe(false);
      expect(await create().compareAndSet('org', 'hr', 1, { ...entry, revision: 2 })).toBe(false);
      expect((await create().get('org', 'hr'))?.grant).toBeNull();
      db.prepare('INSERT INTO enterprise_workable_connections_v1 SELECT organization_id, ?, revision, payload FROM enterprise_workable_connections_v1 WHERE account_id=?').run('other', 'hr');
      await expect(create().get('org', 'other')).rejects.toThrow();
      // Account deletion erases secrets while preserving a CAS tombstone.
      db.prepare("UPDATE enterprise_workable_connections_v1 SET revision=revision+1,payload='' WHERE organization_id=? AND account_id=?").run('org', 'hr');
      expect(await create().get('org', 'hr')).toEqual({ revision: 3, grant: null, bindings: [] });
      expect(await create().compareAndSet('org', 'hr', 2, { ...entry, revision: 3 })).toBe(false);
    } finally { db.close(); }
  });
});
