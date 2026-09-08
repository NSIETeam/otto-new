/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { Database } from '../../data_platform/index.js';
import { PARK_FLEA_MARKET_SCHEMA_CONTRIBUTOR } from './fleaMarketSchema.js';
import type {
  MarketRepository,
  MarketTransaction,
  SqlRow,
} from './fleaMarketRepository.js';
export function migrateMarket(db: Database): void {
  PARK_FLEA_MARKET_SCHEMA_CONTRIBUTOR.apply(db);
}
export function createMarketSqliteRepository(db: Database): MarketRepository {
  // One connection cannot interleave async transactions. The durable lock is BEGIN IMMEDIATE;
  // this queue only orders callers sharing this connection, never stores business state.
  let queue: Promise<unknown> = Promise.resolve();
  const tx: MarketTransaction = {
    async all<T extends SqlRow>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql, params = []) {
      return Number(db.prepare(sql).run(...params).changes);
    },
  };
  const transaction = <T>(
    work: (tx: MarketTransaction) => Promise<T>,
  ): Promise<T> => {
    const result = queue.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(tx);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    queue = result.catch(() => undefined);
    return result;
  };
  return { transaction, read: transaction };
}
