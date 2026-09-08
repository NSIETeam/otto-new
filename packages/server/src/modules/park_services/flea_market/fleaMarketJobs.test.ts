/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
import { runMarketJobs } from './fleaMarketJobs.js';
import {
  sqliteMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
it('expires once across two workers, persists notification across restart and cleans content at 180 days', async () => {
  const h = await sqliteMarketHarness();
  try {
    const base = await marketServiceFixture(h.repository);
    let time = base.now();
    const deps = { ...base, now: () => time };
    const service = createMarketService(deps);
    const listing = await service.publish('seller', {
      ...testListingFields,
      requestId: 'publish',
    });
    time = listing.expiresAt;
    await Promise.all([runMarketJobs(deps), runMarketJobs(deps)]);
    expect((await service.mine('seller'))[0]).toMatchObject({
      state: 'offline',
      offlineReason: 'expired',
    });
    const notifications = await h.repository.read((tx) =>
      tx.all('SELECT * FROM park_market_notifications'),
    );
    expect(notifications).toHaveLength(1);
    await h.restart();
    expect(
      await h.repository.read((tx) =>
        tx.all('SELECT * FROM park_market_notifications'),
      ),
    ).toEqual(notifications);
    time += 180 * 86400000;
    await runMarketJobs({ ...deps, repository: h.repository });
    expect(
      (
        await createMarketService({ ...deps, repository: h.repository }).mine(
          'seller',
        )
      )[0],
    ).toMatchObject({ description: '', imageIds: [], cleanedAt: time });
  } finally {
    await h.close();
  }
});
