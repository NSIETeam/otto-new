/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
import {
  sqliteMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
it('serializes conflicting state commands, protects private remarks and preserves own history after exit', async () => {
  const h = await sqliteMarketHarness();
  try {
    const service = createMarketService(
      await marketServiceFixture(h.repository),
    );
    const listing = await service.publish('seller', {
      ...testListingFields,
      requestId: 'p1',
    });
    const results = await Promise.allSettled([
      service.command('seller', listing.id, 'reserve', {
        requestId: 'r1',
        expectedVersion: 1,
        note: '私人买家姓名',
      }),
      service.command('seller', listing.id, 'sold', {
        requestId: 's1',
        expectedVersion: 1,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await service.detail('buyer', listing.id)).not.toHaveProperty(
      'reservation',
    );
    await expect(service.detail('outsider', listing.id)).rejects.toThrow(
      'NOT_FOUND',
    );
    await h.repository.transaction((tx) =>
      tx.run("UPDATE test_market_accounts SET park_id=NULL WHERE id='seller'"),
    );
    expect((await service.mine('seller'))[0].id).toBe(listing.id);
    await expect(service.detail('buyer', listing.id)).rejects.toThrow(
      'NOT_FOUND',
    );
  } finally {
    await h.close();
  }
});
