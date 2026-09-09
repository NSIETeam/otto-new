import { runMarketJobs } from './fleaMarketJobs.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketGovernance } from './fleaMarketGovernance.js';
import { createMarketModeration } from './fleaMarketModeration.js';
import { createMarketService } from './fleaMarketService.js';
import {
  marketServiceFixture,
  sqliteMarketHarness,
  postgresMarketHarness,
  testListingFields,
} from './fleaMarketTestSupport.js';
for (const [backend, harness] of [
  ['sqlite', sqliteMarketHarness],
  ['postgres', postgresMarketHarness],
] as const) {
  it(`${backend}: governance is scoped, versioned, persistent and never republishes restored listings`, async () => {
    const h = await harness();
    try {
      const base = await marketServiceFixture(h.repository);
      let administratorEnabled = true;
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
              marketAdminParkIds:
                administratorEnabled && id === 'stranger' ? ['P'] : [],
            }
          );
        },
      };
      const market = createMarketService(deps);
      const governance = createMarketGovernance(deps);
      const item = await market.publish('seller', {
        ...testListingFields,
        requestId: 'publish',
      });
      await expect(
        governance.restrict('buyer', 'P', 'seller', {
          requestId: 'denied',
          reason: '违规',
          permanent: true,
        }),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        governance.restrict('stranger', 'P', 'seller', {
          requestId: 'invalid',
          reason: '违规',
        }),
      ).rejects.toThrow('INVALID_INPUT');
      const restriction = await governance.restrict('stranger', 'P', 'seller', {
        requestId: 'restrict',
        reason: '重复广告',
        permanent: true,
      });
      expect((await market.mine('seller'))[0]).toMatchObject({
        state: 'offline',
        offlineReason: 'restriction-offline',
      });
      expect(
        (await governance.ownRecords('seller')).restrictions[0].reason,
      ).toBe('重复广告');
      expect(
        JSON.stringify(
          await h.repository.read((tx) =>
            tx.all('SELECT * FROM park_market_restrictions'),
          ),
        ),
      ).not.toContain('重复广告');
      administratorEnabled = false;
      await expect(
        governance.restrict('stranger', 'P', 'seller', {
          requestId: 'restrict',
          reason: '重复广告',
          permanent: true,
        }),
      ).rejects.toThrow('FORBIDDEN');
      administratorEnabled = true;

      await expect(
        market.command('seller', item.id, 'relist', {
          requestId: 'blocked',
          expectedVersion: 2,
        }),
      ).rejects.toThrow('FORBIDDEN');
      await governance.revokeRestriction('stranger', restriction.id, {
        requestId: 'revoke',
        reason: '整改完成',
      });
      expect((await market.mine('seller'))[0].state).toBe('offline');
      const relisted = await market.command('seller', item.id, 'relist', {
        requestId: 'relist',
        expectedVersion: 2,
      });
      const moderation = createMarketModeration(deps);
      const report = await moderation.report('buyer', item.id, {
        requestId: 'report',
        reason: 'misleading',
      });
      await moderation.decide('stranger', report.id, {
        requestId: 'process',
        expectedVersion: 1,
        decision: 'processing',
        reason: '核实商品描述',
      });
      const processing = (await governance.records('stranger', 'P')).reports[0];
      expect(processing).toMatchObject({
        state: 'processing',
        closed_at: null,
        version: 2,
      });
      await moderation.decide('stranger', report.id, {
        requestId: 'remove',
        expectedVersion: 2,
        decision: 'remove',
        reason: '信息不实',
      });
      administratorEnabled = false;
      await expect(
        moderation.decide('stranger', report.id, {
          requestId: 'remove',
          expectedVersion: 2,
          decision: 'remove',
          reason: '信息不实',
        }),
      ).rejects.toThrow('FORBIDDEN');
      administratorEnabled = true;
      await h.repository.transaction((tx) =>
        tx
          .run("UPDATE test_market_accounts SET park_id=NULL WHERE id='seller'")
          .then(() => undefined),
      );
      const appeal = await governance.appeal('seller', item.id, {
        requestId: 'appeal',
        description: '请求复核信息',
        evidenceIds: [],
      });
      expect(
        (
          await governance.appeal('seller', item.id, {
            requestId: 'appeal-again',
            description: '补充说明',
          })
        ).id,
      ).toBe(appeal.id);
      await expect(governance.records('buyer', 'P')).rejects.toThrow(
        'FORBIDDEN',
      );
      expect((await governance.ownRecords('seller')).appeals).toHaveLength(1);
      await governance.resolveAppeal('stranger', appeal.id, {
        requestId: 'resolve',
        expectedVersion: 1,
        decision: 'restore',
        reason: '复核通过',
      });
      expect((await market.mine('seller'))[0]).toMatchObject({
        state: 'offline',
        offlineReason: 'moderation-restored',
        listedAt: relisted.listedAt,
      });
      await expect(
        governance.resolveAppeal('stranger', appeal.id, {
          requestId: 'stale',
          expectedVersion: 1,
          decision: 'restore',
          reason: '复核通过',
        }),
      ).rejects.toThrow('CONFLICT');
      const records = await governance.records('stranger', 'P');
      expect(records.appeals[0]).toMatchObject({ state: 'closed' });
      expect(records.audit.length).toBeGreaterThanOrEqual(4);
      const cleanupTime = base.now() + 180 * 86400000;
      await runMarketJobs({ ...deps, now: () => cleanupTime });
      const afterCleanup = await governance.ownRecords('seller');
      expect(afterCleanup.appeals[0].payload).toMatchObject({
        description: '',
        evidenceIds: [],
        cleanedAt: cleanupTime,
      });
      expect(
        JSON.stringify((await governance.records('stranger', 'P')).audit),
      ).not.toContain('请求复核信息');
    } finally {
      await h.close();
    }
  }, 30000);
}
