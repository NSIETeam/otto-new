/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { it, expect } from 'vitest';
import { createMarketSettings } from './fleaMarketSettings.js';
import { createMarketInbox } from './fleaMarketInbox.js';
import {
  sqliteMarketHarness,
  marketServiceFixture,
} from './fleaMarketTestSupport.js';
it('configuration requires explicit market role, valid responsible member and server readiness; inbox read state is owner scoped', async () => {
  const h = await sqliteMarketHarness();
  try {
    const base = await marketServiceFixture(h.repository);
    let authority = true;
    const deps = {
      ...base,
      principal: async (
        tx: Parameters<typeof base.principal>[0],
        id: string,
      ) => {
        const p = await base.principal(tx, id);
        return (
          p && {
            ...p,
            marketAdminParkIds: authority && id === 'stranger' ? ['P'] : [],
          }
        );
      },
    };
    const settings = createMarketSettings(deps, () => false);
    expect(await createMarketSettings(deps, () => true).read('buyer')).toMatchObject({ enabled: true, ready: true, version: 0 });
    const input = {
      requestId: 'config',
      expectedVersion: 0,
      enabled: true,
      rules: '仅限个人闲置，禁止广告',
      responsibleAccountId: 'stranger',
      contact: '园区服务台',
      timezone: 'Asia/Shanghai',
      ready: true,
    };
    await expect(settings.update('buyer', 'P', input)).rejects.toThrow(
      'FORBIDDEN',
    );
    await expect(settings.update('stranger', 'P', input)).rejects.toThrow(
      'DEPENDENCY_UNAVAILABLE',
    );
    const ready = createMarketSettings(deps, () => true);
    await expect(
      ready.update('stranger', 'P', {
        ...input,
        responsibleAccountId: 'outsider',
      }),
    ).rejects.toThrow('INVALID_INPUT');
    expect(await ready.update('stranger', 'P', input)).toMatchObject({
      version: 1,
      enabled: true,
      ready: true,
    });
    expect(await settings.read('buyer')).toMatchObject({
      enabled: true,
      ready: false,
    });
    await expect(
      ready.update('stranger', 'P', { ...input, requestId: 'conflict' }),
    ).rejects.toThrow('CONFLICT');
    await h.repository.transaction((tx) =>
      tx
        .run(
          "INSERT INTO park_market_notifications VALUES ('notice','seller','expiry','item',1,100,NULL)",
        )
        .then(() => undefined),
    );
    const inbox = createMarketInbox(deps);
    await inbox.markRead('buyer', ['notice']);
    expect((await inbox.list('seller')).unread).toBe(1);
    await inbox.markRead('seller', ['notice']);
    expect((await createMarketInbox(deps).list('seller')).unread).toBe(0);
    expect((await inbox.list('buyer')).items).toEqual([]);
    await h.repository.transaction((tx) =>
      tx
        .run("UPDATE test_market_accounts SET active=0 WHERE id='seller'")
        .then(() => undefined),
    );
    await expect(inbox.list('seller')).rejects.toThrow('UNAUTHENTICATED');
    authority = false;
    await expect(ready.update('stranger', 'P', input)).rejects.toThrow(
      'FORBIDDEN',
    );
  } finally {
    await h.close();
  }
});
