/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { createMarketContacts } from './fleaMarketContacts.js';
import { createMarketService } from './fleaMarketService.js';
import { hasParkContactPrivateAuthority } from '../../collaboration/parkContactPrivateAuthority.js';
import {
  sqliteMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
it('reuses an independently authorized enterprise conversation while market blocks remain separate', async () => {
  const h = await sqliteMarketHarness();
  try {
    const base = await marketServiceFixture(h.repository);
    await h.repository.transaction(async (tx) => {
      await tx.run(
        'CREATE TABLE organization_features(organization_id TEXT,direct_messages INTEGER)',
      );
      await tx.run(
        'CREATE TABLE direct_messages(id TEXT,organization_id TEXT,sender_account_id TEXT,recipient_account_id TEXT)',
      );
      await tx.run("INSERT INTO organization_features VALUES ('E1',1)");
      await tx.run(
        "INSERT INTO direct_messages VALUES ('prior-private','E1','seller','buyer')",
      );
      await tx.run(
        "UPDATE test_market_accounts SET organization_id='E1' WHERE id='buyer'",
      );
    });
    const contacts = createMarketContacts({
      ...base,
      privateConversation: async (tx, a, b) =>
        hasParkContactPrivateAuthority(
          tx,
          (await base.principal(tx, a))!,
          (await base.principal(tx, b))!,
        ),
      verifyMessage: async () => ({ ciphertext: 'transport fixture' }),
    });
    const item = await createMarketService(base).publish('seller', {
      ...testListingFields,
      requestId: 'publish',
    });
    const result = await contacts.contact('buyer', item.id, {
      requestId: 'question',
      expectedVersion: 1,
    });
    expect(result.requestId).toBeNull();
    expect((await contacts.inbox('seller')).requests).toEqual([]);
    expect((await contacts.inbox('seller')).conversations[0]).toMatchObject({
      privatePeerId: 'buyer',
    });
    await contacts.block('buyer', 'seller', {
      requestId: 'block',
      enabled: true,
    });
    await expect(
      contacts.contact('buyer', item.id, {
        requestId: 'again',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('NOT_FOUND');
    expect(
      await h.repository.read((tx) => tx.all('SELECT * FROM direct_messages')),
    ).toHaveLength(1);
    expect(
      await h.repository.read((tx) =>
        hasParkContactPrivateAuthority(
          tx,
          { accountId: 'seller', organizationId: 'E1' },
          { accountId: 'outsider', organizationId: 'E3' },
        ),
      ),
    ).toBe(false);
  } finally {
    await h.close();
  }
});
