/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
import { runMarketJobs } from './fleaMarketJobs.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
describe.each([
  ['SQLite', sqliteMarketHarness],
  ['PostgreSQL', postgresMarketHarness],
] as const)('%s business contract', (_name, harness) => {
  it('enforces the last daily quota under parallel requests and atomically binds every successful image', async () => {
    const h = await harness();
    try {
      const deps = await marketServiceFixture(h.repository);
      const service = createMarketService(deps);
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          service.publish('seller', {
            ...testListingFields,
            requestId: `publish-${i}`,
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .every(
            (r) => r.status === 'rejected' && r.reason.code === 'LIMIT_REACHED',
          ),
      ).toBe(true);
      const counts = await h.repository.read(async (tx) => ({
        listings: (await tx.all('SELECT id FROM park_market_listings')).length,
        refs: (
          await tx.all(
            "SELECT * FROM park_market_image_refs WHERE kind='listing'",
          )
        ).length,
        operations: (await tx.all('SELECT * FROM park_market_operations'))
          .length,
      }));
      expect(counts).toEqual({ listings: 10, refs: 10, operations: 10 });
    } finally {
      await h.close();
    }
  });
  it('preserves state/version/privacy on conflicting writes, market pause and database restart', async () => {
    const h = await harness();
    try {
      const base = await marketServiceFixture(h.repository);
      let enabled = true;
      let time = base.now();
      const deps = {
        ...base,
        now: () => time,
        config: async () => ({ ...(await base.config()), enabled }),
      };
      const service = createMarketService(deps);
      const listing = await service.publish('seller', {
        ...testListingFields,
        requestId: 'publish',
      });
      const results = await Promise.allSettled([
        service.command('seller', listing.id, 'reserve', {
          requestId: 'reserve',
          expectedVersion: 1,
          note: '只能本人可见',
        }),
        service.command('seller', listing.id, 'sold', {
          requestId: 'sold',
          expectedVersion: 1,
        }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await expect(service.detail('outsider', listing.id)).rejects.toThrow(
        'NOT_FOUND',
      );
      expect(
        JSON.stringify(await service.detail('buyer', listing.id)),
      ).not.toContain('只能本人可见');
      enabled = false;
      await expect(service.discover('buyer', {})).rejects.toThrow('FORBIDDEN');
      const owned = (await service.mine('seller'))[0];
      if (owned.state === 'reserved')
        await service.command('seller', listing.id, 'offline', {
          requestId: 'offline',
          expectedVersion: owned.version,
        });
      await h.restart();
      const resumed = createMarketService({
        ...deps,
        repository: h.repository,
      });
      expect((await resumed.mine('seller'))[0].id).toBe(listing.id);
      time = listing.expiresAt + 1;
      await runMarketJobs({ ...deps, repository: h.repository });
    } finally {
      await h.close();
    }
  });
});
