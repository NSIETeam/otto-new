/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export type SqlRow = Record<string, unknown>;
export interface MarketTransaction {
  all<T extends SqlRow = SqlRow>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
}
export interface MarketRepository {
  transaction<T>(work: (tx: MarketTransaction) => Promise<T>): Promise<T>;
  read<T>(work: (tx: MarketTransaction) => Promise<T>): Promise<T>;
}
