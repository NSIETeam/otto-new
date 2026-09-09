/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
import { createMarketModeration } from './fleaMarketModeration.js';
import {
  sqliteMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
it('deduplicates reports, forbids ordinary administrators and removes with audit and result event', async () => {
  const h = await sqliteMarketHarness();
  try {
    const base = await marketServiceFixture(h.repository);
    const deps = {
      ...base,
      principal: async (
        tx: Parameters<typeof base.principal>[0],
        id: string,
      ) => {
        const actor = await base.principal(tx, id);
        return (
          actor && {
            ...actor,
            marketAdminParkIds: id === 'stranger' ? ['P'] : [],
          }
        );
      },
    };
    const service = createMarketService(deps);
    const listing = await service.publish('seller', {
      ...testListingFields,
      requestId: 'publish',
    });
    const moderation = createMarketModeration(deps);
    const report = await moderation.report('buyer', listing.id, {
      requestId: 'report',
      reason: 'misleading',
      description: '商品描述不符',
    });
    expect(
      (
        await moderation.report('buyer', listing.id, {
          requestId: 'report2',
          reason: 'misleading',
          description: '商品描述不符',
        })
      ).id,
    ).toBe(report.id);
    await expect(
      moderation.decide('seller', report.id, {
        requestId: 'unauthorized',
        expectedVersion: 1,
        decision: 'remove',
        reason: '违规',
      }),
    ).rejects.toThrow('FORBIDDEN');
    await moderation.decide('stranger', report.id, {
      requestId: 'remove',
      expectedVersion: 1,
      decision: 'remove',
      reason: '商品信息不实',
    });
    const refs = await h.repository.read((tx) =>
      tx.all(
        "SELECT expires_at FROM park_market_image_refs WHERE kind='evidence'",
      ),
    );
    expect(
      refs.every(
        (ref) => Number(ref.expires_at) === base.now() + 180 * 86400000,
      ),
    ).toBe(true);
    expect((await service.mine('seller'))[0].state).toBe('removed');
    await expect(
      service.command('seller', listing.id, 'relist', {
        requestId: 'bypass',
        expectedVersion: 2,
      }),
    ).rejects.toThrow('CONFLICT');
    expect(await service.detail('buyer', listing.id)).toEqual({
      id: listing.id,
      state: 'unavailable',
    });
    expect(
      (
        await h.repository.read((tx) =>
          tx.all(
            "SELECT * FROM park_market_outbox WHERE kind='moderation-result'",
          ),
        )
      ).length,
    ).toBe(1);
  } finally {
    await h.close();
  }
});
