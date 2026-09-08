/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { cpus, totalmem, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { createMarketService } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketService.js';
import {
  indexMarketListing,
  marketSearchKey,
  backfillMarketSearch,
} from '../../packages/server/src/modules/park_services/flea_market/fleaMarketSearchIndex.js';
import { categories } from '../../packages/server/src/modules/park_services/flea_market/fleaMarketTypes.js';
import {
  postgresMarketHarness,
  sqliteMarketHarness,
  marketServiceFixture,
  testListingFields,
} from '../../packages/server/src/modules/park_services/flea_market/fleaMarketTestSupport.js';

it.runIf(process.env.OTTO_MARKET_CAPACITY === '1')(
  'enforces 100 concurrent reads / 100k history / 10k active with diverse indexed data',
  async () => {
    const output = resolve(
      process.env.OTTO_MARKET_CAPACITY_OUTPUT ??
        `docs/research/flea-market-evidence/repair-pass-2-capacity-${Date.now()}.json`,
    );
    if (!basename(output).startsWith('repair-pass-2-'))
      throw new Error(
        'Use a repair-pass-2- output name; historical evidence is immutable',
      );
    const results: Array<Record<string, unknown> & { p95Ms: number }> = [];
    const maintenance: unknown[] = [];
    const profiles: unknown[] = [];
    const save = () =>
      writeFileSync(
        output,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            hardware: {
              platform: platform(),
              arch: arch(),
              cpu: cpus()[0].model,
              cores: cpus().length,
              memoryBytes: totalmem(),
            },
            scope:
              'Real disposable DB service calls, 100 concurrently issued requests. No HTTP/IPC, network shaping or browser usability claim. Cold means first query after DB restart, not flushed OS disk caches.',
            results,
            maintenance,
            profiles,
          },
          null,
          2,
        ),
      );
    try {
      for (const [backend, harness] of [
        ['sqlite', sqliteMarketHarness],
        ['postgres', postgresMarketHarness],
      ] as const) {
        const h = await harness();
        try {
          const deps = await marketServiceFixture(h.repository);
          let service = createMarketService(deps);
          const template = await service.publish('seller', {
            ...testListingFields,
            requestId: 'seed',
          });
          const started = performance.now();
          await h.repository.transaction(async (tx) => {
            const key = (await marketSearchKey(tx, deps.cipher, 'P', true))!;
            await tx.run('DELETE FROM park_market_history');
            await tx.run('DELETE FROM park_market_search_terms');
            await tx.run('DELETE FROM park_market_search_documents');
            await tx.run('DELETE FROM park_market_listings');
            for (let i = 0; i < 500; i++)
              await tx.run(
                'INSERT INTO test_market_accounts VALUES (?,?,?,1)',
                [`seller-${i}`, `E${i % 20}`, 'P'],
              );
            for (let start = 0; start < 100000; start += 250) {
              const args: unknown[] = [];
              for (let i = start; i < start + 250; i++) {
                const id = `capacity-${String(i).padStart(6, '0')}`;
                const item = {
                  ...template,
                  id,
                  ownerId: `seller-${i % 500}`,
                  title: `${['办公桌', '运动鞋', '图书', '显示器', '台灯', '行李箱'][i % 6]} ${i} ${i % 97 === 0 ? '🪑稀有' : ''}`,
                  description: `个人闲置正常使用，编号${i}，${i % 5 === 0 ? '100%完好_原装' : '可园区交接'}，${['红色', '蓝色', '黑色'][i % 3]}`,
                  category: categories[i % 6],
                  state: (i < 10000
                    ? i % 4 === 0
                      ? 'reserved'
                      : 'active'
                    : ['sold', 'offline', 'deleted'][
                        i % 3
                      ]) as typeof template.state,
                  listedAt: template.listedAt - i,
                  priceCents: i % 10000,
                  endedAt: i < 10000 ? null : template.listedAt,
                };
                args.push(
                  id,
                  'P',
                  item.ownerId,
                  1,
                  item.state,
                  item.category,
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
                  await indexMarketListing(tx, deps.cipher, item, key);
              }
              await tx.run(
                `INSERT INTO park_market_listings VALUES ${Array.from({ length: 250 }, () => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
                args,
              );
            }
          });
          const buildMs = performance.now() - started;
          const profile = await h.repository.read(async (tx) => ({
            backend,
            buildMs,
            terms: await tx.all(
              'SELECT COUNT(*) AS count FROM park_market_search_terms',
            ),
            plan: await tx.all(
              `${backend === 'sqlite' ? 'EXPLAIN QUERY PLAN' : 'EXPLAIN'} SELECT id FROM park_market_listings WHERE park_id='P' AND state IN ('active','reserved') ORDER BY listed_at DESC,id LIMIT 20`,
            ),
            size:
              backend === 'sqlite'
                ? await tx.all('PRAGMA page_count')
                : await tx.all(
                    "SELECT pg_total_relation_size('park_market_search_terms') AS search_bytes",
                  ),
          }));
          profiles.push(profile);
          await h.restart();
          let decryptions = 0,
            candidates = 0;
          const cipher = {
            ...deps.cipher,
            decryptText: (
              ...args: Parameters<typeof deps.cipher.decryptText>
            ) => {
              if (String(args[1]).startsWith('park-market-listing:'))
                decryptions++;
              return deps.cipher.decryptText(...args);
            },
          };
          const repository = {
            ...h.repository,
            read: <T>(work: Parameters<typeof h.repository.read<T>>[0]) =>
              h.repository.read((tx) =>
                work({
                  ...tx,
                  all: async (...args: Parameters<typeof tx.all>) => {
                    const rows = await tx.all(...args);
                    if (
                      args[0].startsWith('SELECT * FROM park_market_listings')
                    )
                      candidates += rows.length;
                    return rows as never;
                  },
                }),
              ),
          };
          service = createMarketService({ ...deps, cipher, repository });
          for (const phase of ['cold', 'warm']) {
            for (const [scenario, filters, expected] of [
              ['latest', {}, 20],
              ['no-match', { query: '不存在的物品' }, 0],
              ['sparse', { query: '稀有' }, 20],
              ['common', { query: '个人闲置' }, 20],
              ['single', { query: '桌' }, 20],
              ['emoji', { query: '🪑' }, 20],
              ['literal', { query: '%完好_' }, 20],
              [
                'price-category',
                {
                  category: 'office',
                  minCents: 200,
                  maxCents: 9000,
                  sort: 'price-asc' as const,
                },
                20,
              ],
              ['price-desc', { sort: 'price-desc' as const }, 20],
              [
                'later-page',
                { cursor: (await service.discover('buyer', {})).nextCursor! },
                20,
              ],
            ] as const) {
              decryptions = 0;
              candidates = 0;
              const durations: number[] = [];
              await Promise.all(
                Array.from({ length: 100 }, async () => {
                  const start = performance.now();
                  const page = await service.discover('buyer', filters);
                  expect(page.items).toHaveLength(expected);
                  expect(new Set(page.items.map((x) => x.id)).size).toBe(
                    page.items.length,
                  );
                  durations.push(performance.now() - start);
                }),
              );
              durations.sort((a, b) => a - b);
              results.push({
                backend,
                phase,
                scenario,
                records: 100000,
                active: 10000,
                concurrency: 100,
                p50Ms: durations[49],
                p95Ms: durations[94],
                maxMs: durations[99],
                decryptions,
                candidates,
                targetP95Ms: 1000,
                passed: durations[94] <= 1000,
              });
              save();
            }
          }
          await h.repository.transaction(async (tx) => {
            await tx.run('DELETE FROM park_market_search_terms');
            await tx.run('DELETE FROM park_market_search_documents');
          });
          const backfillStart = performance.now();
          await expect(
            service.discover('buyer', { query: '桌' }),
          ).rejects.toMatchObject({ field: 'search-index' });
          let batches = 0,
            pending = true;
          while (pending) {
            const batch = await backfillMarketSearch(
              { ...deps, repository: h.repository },
              100,
            );
            pending = batch.pending;
            batches++;
          }
          maintenance.push({
            backend,
            batches,
            batchLimit: 100,
            buildMs: performance.now() - backfillStart,
          });
          save();
        } finally {
          await h.close();
        }
      }
    } finally {
      save();
    }
    // Persist all measurements before asserting: an over-budget run must exit nonzero.
    for (const row of results)
      expect
        .soft(row.p95Ms, `${row.backend}/${row.phase}/${row.scenario}`)
        .toBeLessThanOrEqual(1000);
  },
  600000,
);
