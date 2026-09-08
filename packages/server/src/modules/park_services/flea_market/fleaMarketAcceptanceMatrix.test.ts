/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
import { createMarketContacts } from './fleaMarketContacts.js';
import { runMarketJobs } from './fleaMarketJobs.js';
import {
  postgresMarketHarness,
  sqliteMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: A14/A32/A38 keep grants per item and retry existing-conversation consultations without changing snapshots`, async () => {
    const h = await harness();
    try {
      const base = await marketServiceFixture(h.repository);
      const service = createMarketService(base);
      const contacts = createMarketContacts({
        ...base,
        verifyMessage: async (_tx, _context, envelope) => envelope,
      });
      const a = await service.publish('seller', {
        ...testListingFields,
        requestId: 'a',
      });
      const b = await service.publish('seller', {
        ...testListingFields,
        title: '另一把椅子',
        requestId: 'b',
      });
      const first = await contacts.contact('buyer', a.id, {
        requestId: 'qa',
        expectedVersion: 1,
        envelope: { ciphertext: 'fixture' },
      });
      await contacts.resolve('seller', first.requestId!, {
        requestId: 'accept',
        action: 'accept',
      });
      await service.command('seller', a.id, 'offline', {
        requestId: 'end-a',
        expectedVersion: 1,
      });
      await service.command('seller', b.id, 'offline', {
        requestId: 'end-b',
        expectedVersion: 1,
      });
      expect((await service.detail('buyer', a.id)).title).toBe(a.title);
      expect(await service.detail('buyer', b.id)).not.toHaveProperty('title');
      await service.command('seller', b.id, 'restore-offline', {
        requestId: 'restore-b',
        expectedVersion: 2,
      });
      const body = {
        requestId: 'qb',
        expectedVersion: 3,
        envelope: { ciphertext: 'second-fixture' },
      };
      const [one, two] = await Promise.all([
        contacts.contact('buyer', b.id, body),
        contacts.contact('buyer', b.id, body),
      ]);
      expect(one).toEqual(two);
      expect(one.conversationId).toBe(first.conversationId);
      expect(one.requestId).toBeNull();
      await service.edit('seller', b.id, {
        ...testListingFields,
        title: b.title,
        price: '99.00',
        expectedVersion: 3,
        requestId: 'edit-b',
      });
      await service.command('seller', b.id, 'offline', {
        requestId: 'off-b-again',
        expectedVersion: 4,
      });
      expect(await contacts.contact('buyer', b.id, body)).toEqual(one);
      const messages = await contacts.messages('buyer', first.conversationId);
      expect(messages.items).toHaveLength(2);
      expect(messages.items[1].snapshot).toMatchObject({
        priceCents: 1001,
        updated: true,
        currentState: 'offline',
      });
      expect((await service.detail('buyer', b.id)).priceCents).toBe(9900);
      expect((await contacts.inbox('seller')).requests).toHaveLength(1);
      const associated = await contacts.associated(
        'buyer',
        first.conversationId,
      );
      expect(associated.items.map((row) => row.listingId)).toEqual([
        b.id,
        a.id,
      ]);
      expect(associated.items[0]).toMatchObject({
        messageId: one.messageId,
        sequence: 2,
        unavailable: false,
      });
      await expect(
        contacts.associated('outsider', first.conversationId),
      ).rejects.toThrow();
      await service.command('seller', b.id, 'delete', {
        requestId: 'delete-b',
        expectedVersion: 5,
      });
      expect(
        (await contacts.associated('buyer', first.conversationId)).items[0],
      ).toMatchObject({ title: '商品不可用', unavailable: true });
      await service.command('seller', a.id, 'restore-offline', {
        requestId: 'restore-a',
        expectedVersion: 2,
      });
      const repeat = await contacts.contact('buyer', a.id, {
        requestId: 'qa-again',
        expectedVersion: 3,
        envelope: { ciphertext: 'repeat-a' },
      });
      const latest = await contacts.associated('buyer', first.conversationId);
      expect(latest.items.map((row) => row.listingId)).toEqual([a.id, b.id]);
      expect(latest.items[0]).toMatchObject({
        messageId: repeat.messageId,
        sequence: 3,
      });
      await h.repository.transaction((tx) =>
        tx.run("UPDATE test_market_accounts SET park_id='Q' WHERE id='buyer'"),
      );
      expect(
        (await contacts.associated('buyer', first.conversationId)).items.every(
          (row) => row.unavailable && row.title === '商品不可用',
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 30000);
  it(`${backend}: A16/A17 serialize sale/contact and expiry/renewal races without resurrecting requests or expiring renewed content`, async () => {
    const h = await harness();
    try {
      const base = await marketServiceFixture(h.repository);
      let now = base.now();
      const deps = { ...base, now: () => now };
      const service = createMarketService(deps);
      const contacts = createMarketContacts({
        ...deps,
        verifyMessage: async (_tx, _context, envelope) => envelope,
      });
      const item = await service.publish('seller', {
        ...testListingFields,
        requestId: 'publish',
      });
      const results = await Promise.allSettled([
        contacts.contact('buyer', item.id, {
          requestId: 'question',
          expectedVersion: 1,
          envelope: { ciphertext: 'fixture' },
        }),
        service.command('seller', item.id, 'sold', {
          requestId: 'sold',
          expectedVersion: 1,
        }),
      ]);
      expect(results[1].status).toBe('fulfilled');
      expect((await service.mine('seller'))[0].state).toBe('sold');
      const requests = (await contacts.inbox('seller')).requests;
      expect(
        requests.every(
          (request) => request.state === 'ended' && !request.actionable,
        ),
      ).toBe(true);
      expect(requests.length).toBe(results[0].status === 'fulfilled' ? 1 : 0);
      const second = await service.publish('seller', {
        ...testListingFields,
        requestId: 'second',
      });
      now = second.expiresAt;
      const renewal = await Promise.allSettled([
        service.command('seller', second.id, 'confirm-active', {
          requestId: 'renew',
          expectedVersion: 1,
        }),
        runMarketJobs(deps),
      ]);
      const fresh = (await service.mine('seller')).find(
        (row) => row.id === second.id,
      )!;
      if (renewal[0].status === 'fulfilled') {
        expect(fresh.state).toBe('active');
        expect(fresh.expiresAt).toBeGreaterThan(now);
      } else expect(fresh.state).toBe('offline');
      expect(renewal[1].status).toBe('fulfilled');
    } finally {
      await h.close();
    }
  }, 30000);
}

for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: A10 concurrent reverse consultations share one conversation and one pending request`, async () => {
    const h = await harness();
    try {
      const base = await marketServiceFixture(h.repository);
      await h.repository.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO park_market_images(id,owner_id,park_id,state,bytes,created_at) VALUES ('buyer-image','buyer','P','available',100,0)",
        );
        await tx.run(
          "INSERT INTO park_market_image_refs VALUES ('buyer-image','draft','buyer-draft','buyer',?)",
          [base.now() + 86400000],
        );
      });
      const service = createMarketService(base);
      const contacts = createMarketContacts({
        ...base,
        verifyMessage: async (_tx, _context, envelope) => envelope,
      });
      const a = await service.publish('seller', {
        ...testListingFields,
        requestId: 'a',
      });
      const b = await service.publish('buyer', {
        ...testListingFields,
        imageIds: ['buyer-image'],
        requestId: 'b',
      });
      const results = await Promise.all([
        contacts.contact('buyer', a.id, {
          requestId: 'qa',
          expectedVersion: 1,
          envelope: { ciphertext: 'from-buyer' },
        }),
        contacts.contact('seller', b.id, {
          requestId: 'qb',
          expectedVersion: 1,
          envelope: { ciphertext: 'from-seller' },
        }),
      ]);
      expect(results[0].conversationId).toBe(results[1].conversationId);
      const counts = await h.repository.read(async (tx) => ({
        requests: await tx.all('SELECT * FROM park_market_contact_requests'),
        threads: await tx.all('SELECT * FROM park_market_conversations'),
      }));
      expect(counts.requests).toHaveLength(1);
      expect(counts.threads).toHaveLength(1);
      expect(counts.requests[0].state).toBe('accepted');
      expect(
        (await contacts.messages('buyer', results[0].conversationId)).items,
      ).toHaveLength(2);
    } finally {
      await h.close();
    }
  }, 30000);
}
