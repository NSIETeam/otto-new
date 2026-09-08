/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { Database } from '../../data_platform/index.js';
import { migrateMarket } from './fleaMarketSqliteRepository.js';
it('migrates twice without changing existing enterprise rows', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      "CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('existing');",
    );
    migrateMarket(db);
    migrateMarket(db);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='park_market_listings'",
        )
        .get(),
    ).toBeTruthy();
    expect(db.prepare('SELECT * FROM accounts').all()).toEqual([
      { id: 'existing' },
    ]);
  } finally {
    db.close();
  }
});

import { createEncryptedFieldCipher } from '../../data_platform/index.js';
import { createMarketSqliteRepository } from './fleaMarketSqliteRepository.js';
import { createMarketUnitOfWork } from './fleaMarketUnitOfWork.js';
it('commits an idempotent result once and rejects a changed request', async () => {
  const db = new Database(':memory:');
  try {
    migrateMarket(db);
    const unit = createMarketUnitOfWork(
      createMarketSqliteRepository(db),
      createEncryptedFieldCipher({
        keyProvider: { getKey: () => Buffer.alloc(32, 7), clear() {} },
      }),
    );
    let calls = 0;
    const write = async () => ({ id: `listing-${++calls}` });
    expect(
      await unit.execute('seller', 'operation-1', { title: '椅子' }, write),
    ).toEqual({ id: 'listing-1' });
    expect(
      await unit.execute('seller', 'operation-1', { title: '椅子' }, write),
    ).toEqual({ id: 'listing-1' });
    await expect(
      unit.execute('seller', 'operation-1', { title: '不同物品' }, write),
    ).rejects.toThrow('CONFLICT');
    expect(calls).toBe(1);
  } finally {
    db.close();
  }
});
it('rolls back quota and events when transaction fails', async () => {
  const db = new Database(':memory:');
  try {
    migrateMarket(db);
    const repo = createMarketSqliteRepository(db);
    await expect(
      repo.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO park_market_quota VALUES ('p','a','2026-09-08','publish',1)",
        );
        throw new Error('injected');
      }),
    ).rejects.toThrow('injected');
    expect(db.prepare('SELECT * FROM park_market_quota').all()).toEqual([]);
  } finally {
    db.close();
  }
});
