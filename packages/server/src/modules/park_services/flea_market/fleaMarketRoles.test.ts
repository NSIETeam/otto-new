/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createMarketRoles } from './fleaMarketRoles.js';
import {
  sqliteMarketHarness,
  marketServiceFixture,
} from './fleaMarketTestSupport.js';
it('only the park authority can grant a market role, with persistent audit and revocation after target exit', async () => {
  const h = await sqliteMarketHarness();
  try {
    const base = await marketServiceFixture(h.repository);
    let authority = true;
    const roles = createMarketRoles({
      ...base,
      canAssign: async (_tx, actor, park) =>
        authority && actor === 'seller' && park === 'P',
    });
    await expect(
      roles.assign('buyer', 'P', {
        requestId: 'denied',
        accountId: 'buyer',
        enabled: true,
      }),
    ).rejects.toThrow('FORBIDDEN');
    await roles.assign('seller', 'P', {
      requestId: 'grant',
      accountId: 'buyer',
      enabled: true,
    });
    expect(
      (await roles.list('seller', 'P')).map((row) => row.account_id),
    ).toEqual(['buyer']);
    expect(
      await h.repository.read((tx) =>
        tx.all(
          "SELECT * FROM park_market_audit WHERE action='grant-market-admin'",
        ),
      ),
    ).toHaveLength(1);
    await h.repository.transaction((tx) =>
      tx.run("UPDATE test_market_accounts SET park_id=NULL WHERE id='buyer'"),
    );
    await roles.assign('seller', 'P', {
      requestId: 'revoke',
      accountId: 'buyer',
      enabled: false,
    });
    expect(await roles.list('seller', 'P')).toEqual([]);
    authority = false;
    await expect(
      roles.assign('seller', 'P', {
        requestId: 'grant',
        accountId: 'buyer',
        enabled: true,
      }),
    ).rejects.toThrow('FORBIDDEN');
  } finally {
    await h.close();
  }
});
