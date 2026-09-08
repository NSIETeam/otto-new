import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/sqliteCompat.js';
import { createEncryptedFieldCipher } from '../data_platform/encryptedFieldCipher.js';
import { createSqlitePolicyStore, MemoryPolicyStore } from './policyStore.js';
import { policyCollectionSlot } from './policyRuntime.js';
import { EnterprisePolicyService } from './policyService.js';
import type { PolicyMailbox } from './policyNotifications.js';
import { policyMailboxKey } from './policyNotifications.js';
describe('policy persistence and schedule', () => {
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
