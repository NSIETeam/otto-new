/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketInbox } from './fleaMarketInbox.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
} from './fleaMarketTestSupport.js';
for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: pages through same-timestamp notifications without duplicates and retains cross-device read state`, async () => {
    const h = await harness();
    try {
      const deps = await marketServiceFixture(h.repository);
      await h.repository.transaction(async (tx) => {
        for (let i = 0; i < 205; i++)
          await tx.run(
            'INSERT INTO park_market_notifications VALUES (?,?,?,?,?,?,NULL)',
            [
              `notice-${String(i).padStart(3, '0')}`,
              'seller',
              'expiry',
              'item',
              i,
              100,
            ],
          );
      });
      const inbox = createMarketInbox(deps);
      const first = await inbox.list('seller');
      expect(first.items).toHaveLength(100);
      expect(first.nextCursor).toBeTruthy();
      const second = await inbox.list('seller', undefined, first.nextCursor!);
      const third = await inbox.list('seller', undefined, second.nextCursor!);
      expect(third.nextCursor).toBeNull();
      const ids = [...first.items, ...second.items, ...third.items].map(
        (item) => item.id,
      );
      expect(ids).toHaveLength(205);
      expect(new Set(ids).size).toBe(205);
      await inbox.markRead(
        'seller',
        second.items.map((item) => item.id),
      );
      expect((await createMarketInbox(deps).list('seller')).unread).toBe(105);
      expect(
        (await inbox.list('buyer', undefined, first.nextCursor!)).items,
      ).toEqual([]);
      await expect(inbox.list('seller', undefined, 'broken')).rejects.toThrow(
        'INVALID_INPUT',
      );
    } finally {
      await h.close();
    }
  }, 30000);
}
