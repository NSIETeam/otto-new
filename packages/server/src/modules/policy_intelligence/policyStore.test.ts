import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createSqlitePolicyStore, MemoryPolicyStore } from './policyStore.js';
import { policyCollectionSlot } from './policyRuntime.js';
describe('policy persistence and schedule', () => {
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
