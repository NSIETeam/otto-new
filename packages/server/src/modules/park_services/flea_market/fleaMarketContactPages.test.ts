import { it, expect } from 'vitest';
import { createMarketContacts } from './fleaMarketContacts.js';
import { createMarketService } from './fleaMarketService.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: pages all same-timestamp contact history without duplicates or another account's records`, async () => {
    const h = await harness();
    try {
      const deps = await marketServiceFixture(h.repository);
      const item = await createMarketService(deps).publish('seller', {
        ...testListingFields,
        requestId: 'listing',
      });
      await h.repository.transaction(async (tx) => {
        for (let index = 0; index < 220; index++) {
          const suffix = String(index).padStart(3, '0');
          await tx.run(
            "INSERT INTO park_market_conversations VALUES (?,'P','buyer',?,'active',?)",
            ['thread-' + suffix, 'historical-peer-' + suffix, deps.now()],
          );
          await tx.run(
            "INSERT INTO park_market_contact_requests VALUES (?,'P',?,?,'buyer',?,'expired',0,?,?)",
            [
              'request-' + suffix,
              'thread-' + suffix,
              item.id,
              'historical-peer-' + suffix,
              deps.now(),
              deps.now(),
            ],
          );
        }
      });
      const contacts = createMarketContacts({
        ...deps,
        verifyMessage: async (_tx, _ctx, envelope) => envelope,
      });
      const first = await contacts.inbox('buyer');
      expect(first.requests).toHaveLength(200);
      expect(first.conversations).toHaveLength(200);
      expect(first.nextCursor).toBeTruthy();
      const second = await contacts.inbox('buyer', first.nextCursor!);
      expect(second.requests).toHaveLength(20);
      expect(second.conversations).toHaveLength(20);
      expect(second.nextCursor).toBeNull();
      expect(
        new Set([...first.requests, ...second.requests].map((row) => row.id))
          .size,
      ).toBe(220);
      expect(
        (await contacts.inbox('stranger', first.nextCursor!)).requests,
      ).toEqual([]);
      await expect(contacts.inbox('buyer', 'invalid')).rejects.toThrow();
    } finally {
      await h.close();
    }
  }, 30000);
}
