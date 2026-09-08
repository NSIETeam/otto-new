import { runMarketJobs } from './fleaMarketJobs.js';
import { createMarketInbox } from './fleaMarketInbox.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
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
  it(`${backend}: atomically commits first question, snapshot, quota and notification; terminal requests never revive`, async () => {
    const h = await harness();
    try {
      const base = await marketServiceFixture(h.repository);
      let time = base.now();
      const deps = {
        ...base,
        now: () => time,
        verifyMessage: async (
          _tx: unknown,
          context: unknown,
          envelope: unknown,
        ) => ({ context, envelope }),
      };
      const service = createMarketService(deps);
      const contacts = createMarketContacts(deps);
      const item = await service.publish('seller', {
        ...testListingFields,
        requestId: 'publish',
      });
      const body = {
        requestId: 'question',
        expectedVersion: 1,
        envelope: { ciphertext: 'fixture-injected-transport' },
      };
      const [first, retry] = await Promise.all([
        contacts.contact('buyer', item.id, body),
        contacts.contact('buyer', item.id, body),
      ]);
      expect(retry).toEqual(first);
      expect((await contacts.inbox('seller')).requests).toHaveLength(1);
      expect((await service.mine('seller'))[0].pendingContacts).toBe(1);
      await contacts.resolve('seller', first.requestId!, {
        requestId: 'ignore',
        action: 'ignore',
      });
      expect((await contacts.inbox('buyer')).requests[0].ignored).toBe(false);
      await expect(
        contacts.contact('outsider', item.id, {
          ...body,
          requestId: 'cross-park',
        }),
      ).rejects.toThrow('NOT_FOUND');
      await service.command('seller', item.id, 'reserve', {
        requestId: 'reserve',
        expectedVersion: 1,
      });
      await contacts.resolve('seller', first.requestId!, {
        requestId: 'accept',
        action: 'accept',
      });
      expect((await service.mine('seller'))[0].pendingContacts).toBe(0);
      await service.command('seller', item.id, 'offline', {
        requestId: 'offline',
        expectedVersion: 2,
      });
      await contacts.send('buyer', first.conversationId, {
        requestId: 'chat',
        envelope: body.envelope,
      });
      expect(
        (await contacts.messages('seller', first.conversationId)).items,
      ).toHaveLength(2);
      await contacts.read('seller', first.conversationId, 1);
      const receipts = await contacts.messages('buyer', first.conversationId);
      expect(receipts.items[0].readAt).toBe(time);
      expect(receipts.items[1].readAt).toBeNull();
      expect(receipts.items.map((item) => item.sequence)).toEqual([1, 2]);
      expect(
        (await contacts.messages('seller', first.conversationId, 2)).items.map(
          (item) => item.id,
        ),
      ).toEqual(['question']);
      await runMarketJobs(deps);
      expect(
        (await createMarketInbox(deps).list('seller')).items.find(
          (notice) => notice.id === 'contact:question',
        )?.readAt,
      ).toBe(time);

      await contacts.block('seller', 'buyer', {
        requestId: 'block',
        enabled: true,
      });
      await expect(
        contacts.send('buyer', first.conversationId, {
          requestId: 'blocked-chat',
          envelope: body.envelope,
        }),
      ).rejects.toThrow('FORBIDDEN');
      expect(
        (await contacts.messages('buyer', first.conversationId)).items,
      ).toHaveLength(2);
      expect((await service.detail('buyer', item.id)).title).toBe(item.title);
      await contacts.block('seller', 'buyer', {
        requestId: 'unblock',
        enabled: false,
      });
      await service.command('seller', item.id, 'relist', {
        requestId: 'relist',
        expectedVersion: 3,
      });
      const pending = await contacts.contact('stranger', item.id, {
        ...body,
        requestId: 'second',
        expectedVersion: 4,
      });
      time += 8 * 86400000;
      await expect(
        contacts.resolve('seller', pending.requestId!, {
          requestId: 'late-accept',
          action: 'accept',
        }),
      ).rejects.toThrow('CONFLICT');
      expect((await contacts.inbox('stranger')).requests[0].state).toBe(
        'expired',
      );
      await h.repository.transaction((tx) =>
        tx
          .run("UPDATE test_market_accounts SET park_id=NULL WHERE id='buyer'")
          .then(() => undefined),
      );
      expect(
        (await contacts.messages('buyer', first.conversationId)).items,
      ).toHaveLength(2);
      await expect(
        contacts.send('buyer', first.conversationId, {
          requestId: 'left',
          envelope: body.envelope,
        }),
      ).rejects.toThrow('FORBIDDEN');
    } finally {
      await h.close();
    }
  }, 30000);
}
