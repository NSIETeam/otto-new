import { describe, expect, it, vi } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import {
  createPostgresPolicyStore,
  createSqlitePolicyStore,
  MemoryPolicyStore,
} from './policyStore.js';
import type { PostgresPoolLike } from '../data_platform/postgresDatabaseLifecycle.js';
import { policyCollectionSlot } from './policyRuntime.js';
import { EnterprisePolicyService } from './policyService.js';
import type { PolicyMailbox } from './policyNotifications.js';
import { policyMailboxKey } from './policyNotifications.js';
describe('policy persistence and schedule', () => {
  it.each(['memory', 'sqlite'])(
    'checks stored bytes without loading an oversized legacy mailbox: %s',
    async (backend) => {
      const db = new Database(':memory:');
      const cipher = createEncryptedFieldCipher({
        keyProvider: { getKey: () => Buffer.alloc(32, 3), clear() {} },
      });
      const store =
        backend === 'memory'
          ? new MemoryPolicyStore()
          : createSqlitePolicyStore(() => db, cipher);
      const legacy = {
        watches: { p: {} },
        notices: [
          {
            id: 'original-event',
            readAt: '2026-09-01',
            body: 'x'.repeat(2 * 1024 * 1024),
          },
        ],
      };
      try {
        await store.update('policy-inbox:large', () => legacy);
        await store.update('policy-inbox:small', () => ({
          watches: {},
          notices: [],
        }));
        const decrypt = vi.spyOn(cipher, 'decryptText');
        const keys = await store.keysPage('policy-inbox:', { limit: 2 });
        expect(keys.rows.map((row) => row.key)).toEqual([
          'policy-inbox:large',
          'policy-inbox:small',
        ]);
        expect(keys.rows[0].payloadBytes).toBeGreaterThan(1024 * 1024);
        expect(decrypt).not.toHaveBeenCalled();
        await expect(
          store.getBounded('policy-inbox:large', 1024 * 1024),
        ).rejects.toMatchObject({
          key: 'policy-inbox:large',
          limitBytes: 1024 * 1024,
        });
        const change = vi.fn(() => ({ notices: [] }));
        await expect(
          store.update('policy-inbox:large', change, {
            maxPayloadBytes: 1024 * 1024,
          }),
        ).rejects.toMatchObject({ key: 'policy-inbox:large' });
        expect(change).not.toHaveBeenCalled();
        expect(decrypt).not.toHaveBeenCalled();
        expect(
          await store.getBounded('policy-inbox:small', 1024 * 1024),
        ).toEqual({ watches: {}, notices: [] });
        expect(
          await store.getBounded('policy-inbox:missing', 1024 * 1024),
        ).toBeNull();
        expect(await store.get('policy-inbox:large')).toEqual(legacy);
        await expect(
          store.update('policy-inbox:small', () => legacy, {
            maxPayloadBytes: 1024 * 1024,
          }),
        ).rejects.toMatchObject({ key: 'policy-inbox:small' });
        expect(await store.get('policy-inbox:small')).toEqual({
          watches: {},
          notices: [],
        });
      } finally {
        db.close();
      }
    },
  );
  it('does not transfer an oversized PostgreSQL payload to the decryptor', async () => {
    const queries: string[] = [];
    const cipher = createEncryptedFieldCipher({
      keyProvider: { getKey: () => Buffer.alloc(32, 2), clear() {} },
    });
    const decrypt = vi.spyOn(cipher, 'decryptText');
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: /SELECT/i.test(sql)
            ? [{ payload: null, payload_bytes: 2 * 1024 * 1024 }]
            : [],
        };
      },
    } as unknown as PostgresPoolLike;
    const store = createPostgresPolicyStore(pool, cipher);
    await expect(
      store.getBounded('policy-inbox:large', 1024 * 1024),
    ).rejects.toThrow(/large|limit|size/i);
    expect(queries.find((sql) => /SELECT/i.test(sql))).toMatch(
      /CASE WHEN.*octet_length\(payload\).*THEN payload/is,
    );
    expect(decrypt).not.toHaveBeenCalled();
  });
  it.each(['memory', 'sqlite'])(
    'pages an encrypted history with an exclusive durable cursor: %s',
    async (backend) => {
      const db = new Database(':memory:');
      const cipher = createEncryptedFieldCipher({
        keyProvider: { getKey: () => Buffer.alloc(32, 7), clear() {} },
      });
      const store =
        backend === 'memory'
          ? new MemoryPolicyStore()
          : createSqlitePolicyStore(() => db, cipher);
      try {
        for (let i = 69; i >= 0; i--)
          await store.update(`document:${String(i).padStart(3, '0')}`, () => ({
            body: `正文-${i}`,
          }));
        await store.update('document-other:000', () => ({ body: 'foreign' }));
        const first = await store.page<{ body: string }>('document:', {
          limit: 32,
        });
        expect(first.rows).toHaveLength(32);
        expect(first.nextCursor).toBe('document:031');
        const second = await store.page<{ body: string }>('document:', {
          limit: 32,
          after: first.nextCursor,
        });
        expect(second.rows).toHaveLength(32);
        const last = await store.page<{ body: string }>('document:', {
          limit: 32,
          after: second.nextCursor,
        });
        expect(last.rows).toHaveLength(6);
        expect(last.nextCursor).toBeUndefined();
        const keys = [...first.rows, ...second.rows, ...last.rows].map(
          (row) => row.key,
        );
        expect(new Set(keys).size).toBe(70);
        expect(keys).toEqual([...keys].sort());
        await expect(store.page('document:', { limit: 33 })).rejects.toThrow(
          /limit|page/i,
        );
        await expect(store.page('document:', { limit: 0 })).rejects.toThrow(
          /limit|page/i,
        );
        await expect(
          store.page('document:', { after: 'workspace:999' }),
        ).rejects.toThrow(/cursor/i);
        await store.remove('document:031');
        expect(
          (await store.page('document:', { after: first.nextCursor, limit: 1 }))
            .rows[0].key,
        ).toBe('document:032');
      } finally {
        db.close();
      }
    },
  );

  it('uses a real PostgreSQL LIMIT and exclusive key cursor before decrypting payloads', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [] };
      },
    } as unknown as PostgresPoolLike;
    const cipher = createEncryptedFieldCipher({
      keyProvider: { getKey: () => Buffer.alloc(32, 6), clear() {} },
    });
    const store = createPostgresPolicyStore(pool, cipher);
    expect(
      await store.page('document:', { limit: 16, after: 'document:abc' }),
    ).toEqual({ rows: [] });
    const query = queries.find(({ sql }) => /SELECT/i.test(sql))!;
    expect(query.sql).toMatch(/record_key\s*>\s*\$\d/i);
    expect(query.sql).toMatch(/ORDER BY record_key/i);
    expect(query.sql).toMatch(/LIMIT\s*\$\d/i);
    expect(query.sql).not.toMatch(/OFFSET/i);
    expect(query.values).toContain('document:abc');
    expect(query.values).toContain(16);
  });
  it('retains inbox and read acknowledgements across service reconstruction using the encrypted SQLite store', async () => {
    const db = new Database(':memory:');
    const cipher = createEncryptedFieldCipher({
      keyProvider: { getKey: () => Buffer.alloc(32, 9), clear() {} },
    });
    const actor = {
      id: 'a',
      organizationId: 'org',
      organizationName: '企业',
      isAdmin: false,
      active: true,
    };
    try {
      const store = createSqlitePolicyStore(() => db, cipher);
      const id = 'a'.repeat(64);
      await store.update<PolicyMailbox>(policyMailboxKey(actor), () => ({
        accountId: actor.id,
        organizationId: actor.organizationId,
        watches: {},
        notices: [
          {
            id,
            policyId: 'p',
            policyTitle: '政策期限',
            url: 'https://www.gov.cn/p',
            kind: 'deadline',
            body: '准备申报材料',
            createdAt: '2026-09-01T00:00:00Z',
            policyVersion: 1,
          },
        ],
      }));
      const service = () =>
        new EnterprisePolicyService({
          store: createSqlitePolicyStore(() => db, cipher),
          sources: [],
          getActor: async () => actor,
        });
      await service().readNotifications(actor.id, [id]);
      const restored = await service().inbox(actor.id);
      expect(restored.notices).toHaveLength(1);
      expect(restored.notices[0].readAt).toBeTruthy();
      expect(restored.unreadCount).toBe(0);
      expect(
        JSON.stringify(
          db.prepare('SELECT * FROM enterprise_policy_records_v1').all(),
        ),
      ).not.toContain('准备申报材料');
    } finally {
      db.close();
    }
  });
  it('encrypts database payloads and isolates prefixes with transaction rollback', async () => {
    const db = new Database(':memory:');
    const cipher = createEncryptedFieldCipher({
      keyProvider: { getKey: () => Buffer.alloc(32, 8), clear() {} },
    });
    try {
      const store = createSqlitePolicyStore(() => db, cipher);
      await store.update('org:a:private', () => ({ revenue: '企业秘密收入' }));
      expect(
        JSON.stringify(
          db.prepare('SELECT * FROM enterprise_policy_records_v1').all(),
        ),
      ).not.toContain('企业秘密收入');
      expect(await store.get('org:a:private')).toEqual({
        revenue: '企业秘密收入',
      });
      expect(await store.list('org:b:')).toEqual([]);
      await expect(
        store.update('org:a:private', () => {
          throw new Error('rollback');
        }),
      ).rejects.toThrow();
      expect(await store.get('org:a:private')).toEqual({
        revenue: '企业秘密收入',
      });
      await store.remove('org:a:private');
      expect(await store.get('org:a:private')).toBeNull();
    } finally {
      db.close();
    }
  });
  it('atomically reserves 200 concurrent counters without lost updates', async () => {
    const store = new MemoryPolicyStore();
    await Promise.all(
      Array.from({ length: 200 }, () =>
        store.update<number>('counter', (old) => (old ?? 0) + 1),
      ),
    );
    expect(await store.get('counter')).toBe(200);
  });
  it('uses Shanghai 03:00 and 18:30 slots, not client opening and closing', () => {
    expect(policyCollectionSlot(new Date('2026-09-03T02:59:00+08:00'))).toBe(
      '2026-09-02:18:30',
    );
    expect(policyCollectionSlot(new Date('2026-09-03T03:00:00+08:00'))).toBe(
      '2026-09-03:03:00',
    );
    expect(policyCollectionSlot(new Date('2026-09-03T18:30:00+08:00'))).toBe(
      '2026-09-03:18:30',
    );
  });
});
