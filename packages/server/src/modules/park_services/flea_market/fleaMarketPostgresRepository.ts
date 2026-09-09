/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { PostgresPoolLike } from '../../data_platform/postgresDatabaseLifecycle.js';
import type {
  MarketRepository,
  MarketTransaction,
  SqlRow,
} from './fleaMarketRepository.js';
export function createMarketPostgresRepository(
  pool: PostgresPoolLike,
): MarketRepository {
  const transact = async <T>(
    work: (tx: MarketTransaction) => Promise<T>,
    readOnly: boolean,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query(
        readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      );
      // Shared across processes; serializes domain writes including account quotas and idempotency.
      if (!readOnly)
        await client.query(
          'SELECT id FROM park_market_lock WHERE id=1 FOR UPDATE',
        );
      const sql = (query: string) => {
        let index = 0;
        return query.replace(/\?/g, () => `$${++index}`);
      };
      const tx: MarketTransaction = {
        async all<R extends SqlRow>(query: string, params: unknown[] = []) {
          return (await client.query(sql(query), params)).rows as R[];
        },
        async run(query, params = []) {
          return (await client.query(sql(query), params)).rowCount ?? 0;
        },
      };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    transaction: (work) => transact(work, false),
    read: (work) => transact(work, true),
  };
}
