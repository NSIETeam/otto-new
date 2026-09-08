/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect, vi } from 'vitest';
import {
  backfillMarketSearch,
  rotateMarketSearchKey,
  marketSearchKey,
} from './fleaMarketSearchIndex.js';
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
      await expect(
        service.discover('buyer', { query: '书架' }),
      ).rejects.toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
        field: 'search-index',
      });
      expect(
        await backfillMarketSearch({ ...deps, repository: h.repository }, 1),
      ).toMatchObject({ indexed: 1 });
      expect(
        (await service.discover('buyer', { query: '书架' })).items,
      ).toHaveLength(1);
      const before = await h.repository.read((tx) =>
        marketSearchKey(tx, deps.cipher, 'P'),
      );
      await rotateMarketSearchKey({ ...deps, repository: h.repository }, 'P');
      const after = await h.repository.read((tx) =>
        marketSearchKey(tx, deps.cipher, 'P'),
      );
      expect(after).not.toEqual(before);
      await expect(
        service.discover('buyer', { query: '书架' }),
      ).rejects.toMatchObject({ field: 'search-index' });
      await h.restart();
      await backfillMarketSearch({ ...deps, repository: h.repository }, 1);
      service = createMarketService({ ...deps, repository: h.repository });
      expect(
        (await service.discover('buyer', { query: '书架' })).items,
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 30000);
}

for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: preserves literal substring semantics and caches sellers only within one request`, async () => {
    const h = await harness();
    try {
      const deps = await marketServiceFixture(h.repository);
      const principal = vi.fn(deps.principal);
      const service = createMarketService({ ...deps, principal });
      await service.publish('seller', {
        ...testListingFields,
        title: 'AbC桌🪑',
        description: '描述里有100%和_以及\\符号',
        requestId: 'first',
      });
      await service.publish('seller', {
        ...testListingFields,
        title: 'abc桌🪑',
        description: '描述里有100%和_以及\\符号',
        requestId: 'second',
      });
      for (const query of [' AbC ', '桌', '🪑', '%', '_', '\\', '描述里']) {
        principal.mockClear();
        expect((await service.discover('buyer', { query })).items).toHaveLength(
          2,
        );
        expect(
          principal.mock.calls.filter(([, id]) => id === 'seller'),
        ).toHaveLength(1);
      }
      await h.repository.transaction((tx) =>
        tx.run("UPDATE test_market_accounts SET active=0 WHERE id='seller'"),
      );
      expect((await service.discover('buyer', { query: 'abc' })).items).toEqual(
        [],
      );
    } finally {
      await h.close();
    }
  }, 30000);
  it(`${backend}: backfill is bounded, restartable and rollback-safe`, async () => {
    const h = await harness();
    try {
      const deps = await marketServiceFixture(h.repository);
      const service = createMarketService(deps);
      for (let i = 0; i < 3; i++)
        await service.publish('seller', {
          ...testListingFields,
          requestId: `item-${i}`,
        });
      await h.repository.transaction(async (tx) => {
        await tx.run('DELETE FROM park_market_search_terms');
        await tx.run('DELETE FROM park_market_search_documents');
      });
      const decrypt = vi.spyOn(deps.cipher, 'decryptText');
      await expect(
        service.discover('buyer', { query: '不存在' }),
      ).rejects.toMatchObject({ field: 'search-index' });
      expect(
        decrypt.mock.calls.filter(([, context]) =>
          String(context).startsWith('park-market-listing:'),
        ),
      ).toHaveLength(0);
      expect(await backfillMarketSearch(deps, 1)).toMatchObject({
        indexed: 1,
        pending: true,
      });
      await h.restart();
      expect(
        await backfillMarketSearch({ ...deps, repository: h.repository }, 1),
      ).toMatchObject({ indexed: 1, pending: true });
      expect(
        await backfillMarketSearch({ ...deps, repository: h.repository }, 1),
      ).toMatchObject({ indexed: 1, pending: false });
      expect(
        await backfillMarketSearch({ ...deps, repository: h.repository }, 1),
      ).toMatchObject({ indexed: 0, pending: false });
      expect(
        (
          await createMarketService({
            ...deps,
            repository: h.repository,
          }).discover('buyer', { query: '办公' })
        ).items,
      ).toHaveLength(3);
      await expect(
        h.repository.transaction(async (tx) => {
          await tx.run('DELETE FROM park_market_search_documents');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        await backfillMarketSearch({ ...deps, repository: h.repository }, 1),
      ).toMatchObject({ indexed: 0 });
    } finally {
      await h.close();
    }
  }, 30000);
}
