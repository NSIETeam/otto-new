/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  sqliteMarketHarness,
  testCipher,
  testListingFields,
} from './fleaMarketTestSupport.js';
import { createMarketService } from './fleaMarketService.js';
it('publishes an image-bound listing exactly once into a real database', async () => {
  const h = await sqliteMarketHarness();
  try {
    await h.repository.transaction((tx) =>
      tx.run(
        "INSERT INTO park_market_images(id,owner_id,park_id,state,bytes,created_at) VALUES ('image-1','seller','P','available',100,0)",
      ),
    );
    await h.repository.transaction((tx) =>
      tx.run(
        "INSERT INTO park_market_image_refs VALUES ('image-1','draft','fixture','seller',?)",
        [Date.parse('2026-10-08T00:00:00Z')],
      ),
    );
    const service = createMarketService({
      repository: h.repository,
      cipher: testCipher(),
      now: () => Date.parse('2026-09-08T00:00:00Z'),
      principal: async () => ({
        accountId: 'seller',
        organizationId: 'E1',
        active: true,
        parkId: 'P',
        parkActive: true,
        enterpriseEnabled: true,
        marketAdminParkIds: [],
      }),
      config: async () => ({
        enabled: true,
        ready: true,
        timezone: 'Asia/Shanghai',
        rules: '规则',
        responsibleAccountId: 'admin',
        contact: '运营',
      }),
    });
    const first = await service.publish('seller', {
      ...testListingFields,
      requestId: 'publish-1',
    });
    expect(first).toMatchObject({
      state: 'active',
      version: 1,
      priceCents: 1001,
    });
    expect(
      await service.publish('seller', {
        ...testListingFields,
        requestId: 'publish-1',
      }),
    ).toEqual(first);
    expect(
      (
        await h.repository.read((tx) =>
          tx.all('SELECT * FROM park_market_listings'),
        )
      ).length,
    ).toBe(1);
  } finally {
    await h.close();
  }
});

import { marketServiceFixture } from './fleaMarketTestSupport.js';
it('rechecks account inside the receipt transaction after a concurrent disable', async () => {
  const h = await sqliteMarketHarness();
  try {
    const base = await marketServiceFixture(h.repository);
    let disableAfterRead = false;
    const service = createMarketService({
      ...base,
      principal: async (tx, id) => {
        const actor = await base.principal(tx, id);
        if (disableAfterRead) {
          disableAfterRead = false;
          await tx.run(
            "UPDATE test_market_accounts SET active=0 WHERE id='seller'",
          );
        }
        return actor;
      },
    });
    await service.publish('seller', {
      ...testListingFields,
      requestId: 'idempotent',
    });
    disableAfterRead = true;
    await expect(
      service.publish('seller', {
        ...testListingFields,
        requestId: 'idempotent',
      }),
    ).rejects.toThrow('UNAUTHENTICATED');
  } finally {
    await h.close();
  }
});
