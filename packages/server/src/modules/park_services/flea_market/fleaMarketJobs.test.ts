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

it('prioritizes due listings without decrypting an entire history backlog and resumes its bounded scan after restart', async () => {
  const h = await sqliteMarketHarness();
  try {
    const base = await marketServiceFixture(h.repository);
    const service = createMarketService(base);
    const original = await service.publish('seller', {
      ...testListingFields,
      requestId: 'bounded',
    });
    await h.repository.transaction(async (tx) => {
      for (let i = 0; i < 301; i++) {
        const id = i === 300 ? 'zz-due' : `old-${String(i).padStart(3, '0')}`;
        const item = {
          ...original,
          id,
          state: i === 300 ? 'active' : 'offline',
          expiresAt: base.now(),
          endedAt: i === 300 ? null : base.now(),
        };
        await tx.run(
          'INSERT INTO park_market_listings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            id,
            'P',
            'seller',
            1,
            item.state,
            item.category,
            item.priceCents,
            item.listedAt,
            item.expiresAt,
            item.updatedAt,
            item.endedAt,
            JSON.stringify(
              base.cipher.encryptText(
                JSON.stringify(item),
                `park-market-listing:${id}`,
              ),
            ),
          ],
        );
      }
    });
    let decrypted = 0;
    const deps = {
      ...base,
      cipher: {
        ...base.cipher,
        decryptText: (...args: Parameters<typeof base.cipher.decryptText>) => {
          if (String(args[1]).startsWith('park-market-listing:')) decrypted++;
          return base.cipher.decryptText(...args);
        },
      },
    };
    await runMarketJobs(deps);
    expect(decrypted).toBeLessThanOrEqual(250);
    expect(
      await h.repository.read((tx) =>
        tx.all("SELECT state FROM park_market_listings WHERE id='zz-due'"),
      ),
    ).toEqual([{ state: 'offline' }]);
    const progress = await h.repository.read((tx) =>
      tx.all(
        "SELECT cursor FROM park_market_maintenance WHERE name='listings'",
      ),
    );
    expect(progress[0].cursor).not.toBe('');
    await h.restart();
    decrypted = 0;
    await runMarketJobs({ ...deps, repository: h.repository });
    expect(decrypted).toBeLessThanOrEqual(250);
    expect(
      await h.repository.read((tx) =>
        tx.all(
          "SELECT cursor FROM park_market_maintenance WHERE name='listings'",
        ),
      ),
    ).not.toEqual(progress);
  } finally {
    await h.close();
  }
});
