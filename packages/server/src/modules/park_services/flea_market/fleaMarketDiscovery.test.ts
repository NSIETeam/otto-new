/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
import {
  sqliteMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
it('lists same-park public items, filters free and retains favorite placeholders after deletion', async () => {
  const h = await sqliteMarketHarness();
  try {
    const service = createMarketService(
      await marketServiceFixture(h.repository),
    );
    const listing = await service.publish('seller', {
      ...testListingFields,
      requestId: 'publish',
    });
    expect((await service.discover('buyer', {})).items).toHaveLength(1);
    expect(
      (await service.discover('buyer', { free: true })).items,
    ).toHaveLength(0);
    expect((await service.discover('outsider', {})).items).toHaveLength(0);
    await service.favorite('buyer', listing.id, true);
    await service.favorite('buyer', listing.id, true);
    const offline = await service.command('seller', listing.id, 'offline', {
      requestId: 'offline',
      expectedVersion: 1,
    });
    await service.command('seller', listing.id, 'delete', {
      requestId: 'delete',
      expectedVersion: offline.version,
    });
    expect(await service.favorites('buyer')).toEqual([
      { id: listing.id, state: 'unavailable' },
    ]);
    expect(
      await h.repository.read((tx) =>
        tx.all('SELECT * FROM park_market_outbox'),
      ),
    ).toEqual([]);
  } finally {
    await h.close();
  }
});
it('requires same-item confirmation for a category change and rejects outdated edits', async () => {
  const h = await sqliteMarketHarness();
  try {
    const service = createMarketService(
      await marketServiceFixture(h.repository),
    );
    const listing = await service.publish('seller', {
      ...testListingFields,
      requestId: 'publish',
    });
    await expect(
      service.edit('seller', listing.id, {
        ...testListingFields,
        category: 'home',
        requestId: 'edit',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('INVALID_INPUT');
    const edited = await service.edit('seller', listing.id, {
      ...testListingFields,
      category: 'home',
      sameItemConfirmed: true,
      requestId: 'edit2',
      expectedVersion: 1,
    });
    expect(edited).toMatchObject({
      category: 'home',
      listedAt: listing.listedAt,
      expiresAt: listing.expiresAt,
    });
    await expect(
      service.edit('seller', listing.id, {
        ...testListingFields,
        requestId: 'edit3',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('CONFLICT');
  } finally {
    await h.close();
  }
});
it('does not use favorites as a discovery bypass while the park market is paused', async () => {
  const h = await sqliteMarketHarness();
  try {
    const deps = await marketServiceFixture(h.repository);
    const market = createMarketService(deps);
    const listing = await market.publish('seller', {
      ...testListingFields,
      requestId: 'publish',
    });
    await market.favorite('buyer', listing.id, true);
    const paused = createMarketService({
      ...deps,
      config: async (tx, park) => ({
        ...(await deps.config(tx, park)),
        enabled: false,
      }),
    });
    expect(await paused.favorites('buyer')).toEqual([
      { id: listing.id, state: 'unavailable' },
    ]);
  } finally {
    await h.close();
  }
});
