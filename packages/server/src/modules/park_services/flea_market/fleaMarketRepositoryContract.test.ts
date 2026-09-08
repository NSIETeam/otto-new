/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  sqliteMarketHarness,
  postgresMarketHarness,
  testCipher,
} from './fleaMarketTestSupport.js';
import { createMarketUnitOfWork } from './fleaMarketUnitOfWork.js';
describe.each([
  ['SQLite', sqliteMarketHarness],
  ['PostgreSQL', postgresMarketHarness],
] as const)('%s real storage contract', (_name, harness) => {
  it('serializes simultaneous retries and restores encrypted receipts after database restart', async () => {
    const h = await harness();
    try {
      const unit = createMarketUnitOfWork(h.repository, testCipher());
      let writes = 0;
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          unit.execute('seller', 'same-key', { a: 1 }, async () => ({
            id: ++writes,
          })),
        ),
      );
      expect(writes).toBe(1);
      expect(results.every((result) => result.id === 1)).toBe(true);
      await h.restart();
      expect(
        await createMarketUnitOfWork(h.repository, testCipher()).execute(
          'seller',
          'same-key',
          { a: 1 },
          async () => ({ id: 99 }),
        ),
      ).toEqual({ id: 1 });
      await expect(
        createMarketUnitOfWork(h.repository, testCipher()).execute(
          'seller',
          'same-key',
          { a: 2 },
          async () => ({}),
        ),
      ).rejects.toThrow('CONFLICT');
    } finally {
      await h.close();
    }
  });
  it('rolls back failed commands including their quota and receipt', async () => {
    const h = await harness();
    try {
      const unit = createMarketUnitOfWork(h.repository, testCipher());
      await expect(
        unit.execute('seller', 'failed-key', {}, async (tx) => {
          await tx.run(
            "INSERT INTO park_market_quota VALUES ('P','seller','2026-09-08','publish',1)",
          );
          throw new Error('injected failure');
        }),
      ).rejects.toThrow('injected failure');
      expect(
        await h.repository.read((tx) =>
          tx.all('SELECT * FROM park_market_quota'),
        ),
      ).toEqual([]);
      expect(
        await h.repository.read((tx) =>
          tx.all('SELECT * FROM park_market_operations'),
        ),
      ).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

it('PostgreSQL snapshot reads do not serialize behind unrelated market writes', async () => {
  const h = await postgresMarketHarness();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let read: Promise<unknown> | undefined;
  try {
    read = h.repository.read(async (tx) => {
      await tx.all('SELECT id FROM park_market_lock');
      entered();
      await held;
    });
    await started;
    const write = h.repository.transaction((tx) =>
      tx.run(
        "INSERT INTO park_market_quota VALUES ('P','seller','read-concurrency','publish',1)",
      ),
    );
    const completedWhileReadHeld = await Promise.race([
      write.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    release();
    await read;
    await write;
    expect(completedWhileReadHeld).toBe(true);
  } finally {
    release();
    await read;
    await h.close();
  }
}, 30000);
