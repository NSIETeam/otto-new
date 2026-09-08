/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketService } from './fleaMarketService.js';
import { createMarketGovernance } from './fleaMarketGovernance.js';
import { createMarketModeration } from './fleaMarketModeration.js';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  marketServiceFixture,
  testListingFields,
} from './fleaMarketTestSupport.js';
for (const [name, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const)
  it(`${name}: hiding a removed own record survives park exit without deleting appeal or audit`, async () => {
    const h = await harness();
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
      const market = createMarketService(deps);
      const moderation = createMarketModeration(deps);
      const governance = createMarketGovernance(deps);
      const listing = await market.publish('seller', {
        ...testListingFields,
        requestId: 'publish',
      });
      await expect(market.hide('seller', listing.id)).rejects.toThrow(
        'CONFLICT',
      );
      const report = await moderation.report('buyer', listing.id, {
        requestId: 'report',
        reason: 'misleading',
      });
      await moderation.decide('stranger', report.id, {
        requestId: 'remove',
        expectedVersion: 1,
        decision: 'remove',
        reason: '核实违规',
      });
      await expect(market.hide('buyer', listing.id)).rejects.toThrow(
        'NOT_FOUND',
      );
      await h.repository.transaction((tx) =>
        tx.run(
          "UPDATE test_market_accounts SET park_id=NULL WHERE id='seller'",
        ),
      );
      await market.hide('seller', listing.id);
      await market.hide('seller', listing.id);
      expect(await market.mine('seller')).toEqual([]);
      await governance.appeal('seller', listing.id, {
        requestId: 'appeal',
        description: '请求复核',
      });
      expect((await governance.ownRecords('seller')).appeals).toHaveLength(1);
      await h.restart();
      expect(
        await createMarketService({ ...deps, repository: h.repository }).mine(
          'seller',
        ),
      ).toEqual([]);
    } finally {
      await h.close();
    }
  }, 30000);
