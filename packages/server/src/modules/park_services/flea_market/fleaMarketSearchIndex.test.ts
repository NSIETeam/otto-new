/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
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
  it(`${backend}: persists private substring candidates atomically, updates on edit, and recovers search after restart`, async () => {
    const h = await harness();
    try {
      const deps = await marketServiceFixture(h.repository);
      let service = createMarketService(deps);
      const item = await service.publish('seller', {
        ...testListingFields,
        title: '实木学习桌🪑',
        requestId: 'publish',
      });
      const tokens = await h.repository.read((tx) =>
        tx.all('SELECT * FROM park_market_search_terms'),
      );
      expect(tokens.length).toBeGreaterThan(0);
      expect(JSON.stringify(tokens)).not.toContain('学习');
      expect(
        (await service.discover('buyer', { query: '学习' })).items.map(
          (row) => row.id,
        ),
      ).toEqual([item.id]);
      expect(
        (await service.discover('buyer', { query: '🪑' })).items,
      ).toHaveLength(1);
      await service.edit('seller', item.id, {
        ...testListingFields,
        title: '二手书架',
        expectedVersion: 1,
        requestId: 'edit',
      });
      expect(
        (await service.discover('buyer', { query: '学习' })).items,
      ).toEqual([]);
      await h.restart();
      service = createMarketService({ ...deps, repository: h.repository });
      expect(
        (await service.discover('buyer', { query: '书架' })).items,
      ).toHaveLength(1);
      // A partially backfilled index must never hide older valid records.
      await h.repository.transaction((tx) =>
        tx.run('DELETE FROM park_market_search_documents WHERE listing_id=?', [
          item.id,
        ]),
      );
      expect(
        (await service.discover('buyer', { query: '书架' })).items,
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 30000);
}
