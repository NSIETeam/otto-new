import {
  indexMarketListing,
  marketSearchKey,
} from '../../packages/server/src/modules/park_services/flea_market/fleaMarketSearchIndex.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { createMarketService } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketService.js';
import {
  postgresMarketHarness,
  sqliteMarketHarness,
  marketServiceFixture,
  testListingFields,
} from '../../packages/server/src/modules/park_services/flea_market/fleaMarketTestSupport.js';

// Opt-in capacity experiment uses disposable databases and never a deployment DB.
it.runIf(process.env.OTTO_MARKET_CAPACITY === '1')(
  'measures 100 concurrent reads against 100k persisted records / 10k active listings',
  async () => {
    const results: unknown[] = [];
    for (const [backend, harness] of [
      ['sqlite', sqliteMarketHarness],
      ['postgres', postgresMarketHarness],
    ] as const) {
      const h = await harness();
      try {
        const deps = await marketServiceFixture(h.repository);
        const service = createMarketService(deps);
        const template = await service.publish('seller', {
          ...testListingFields,
          requestId: 'seed',
        });
        const started = performance.now();
        await h.repository.transaction(async (tx) => {
          const searchKey = (await marketSearchKey(
            tx,
            deps.cipher,
            'P',
            true,
          ))!;
          await tx.run('DELETE FROM park_market_history');
          await tx.run('DELETE FROM park_market_listings');
          for (let start = 0; start < 100_000; start += 250) {
            const args: unknown[] = [];
            for (let i = start; i < start + 250; i++) {
              const id = `capacity-${String(i).padStart(6, '0')}`;
              const item = {
                ...template,
                id,
                title: `办公椅 ${i}`,
                state: i < 10_000 ? 'active' : 'sold',
                listedAt: template.listedAt - i,
                priceCents: i % 10000,
                endedAt: i < 10000 ? null : template.listedAt,
              };
              args.push(
                id,
                'P',
                'seller',
                1,
                item.state,
                'office',
                item.priceCents,
                item.listedAt,
                item.expiresAt,
                item.updatedAt,
                item.endedAt,
                JSON.stringify(
                  deps.cipher.encryptText(
                    JSON.stringify(item),
                    `park-market-listing:${id}`,
                  ),
                ),
              );
              if (i < 10000)
                await indexMarketListing(
                  tx,
                  deps.cipher,
                  item as typeof template,
                  searchKey,
                );
            }
            await tx.run(
              `INSERT INTO park_market_listings VALUES ${Array.from({ length: 250 }, () => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
              args,
            );
          }
        });
        const seedMs = performance.now() - started;
        for (const query of ['', '不存在的物品']) {
          const durations: number[] = [];
          await Promise.all(
            Array.from({ length: 100 }, async () => {
              const start = performance.now();
              const page = await service.discover('buyer', { query });
              expect(page.items.length).toBe(query ? 0 : 20);
              durations.push(performance.now() - start);
            }),
          );
          durations.sort((a, b) => a - b);
          results.push({
            backend,
            records: 100000,
            active: 10000,
            concurrency: 100,
            scenario: query ? 'no-match-search' : 'latest-page',
            seedMs: Math.round(seedMs),
            p50Ms: Math.round(durations[49]),
            p95Ms: Math.round(durations[94]),
            maxMs: Math.round(durations[99]),
            targetP95Ms: 1000,
            passed: durations[94] <= 1000,
          });
          writeFileSync(
            resolve('docs/research/flea-market-evidence/capacity.json'),
            JSON.stringify(
              {
                at: new Date().toISOString(),
                scope:
                  'real DB service calls, local Unix socket; excludes HTTP, images, network shaping and browser usability',
                results,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        await h.close();
      }
    }
  },
  600000,
);
