/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type { EncryptedFieldCipher } from '../../data_platform/index.js';
import type {
  MarketRepository,
  MarketTransaction,
} from './fleaMarketRepository.js';
import { MarketError } from './fleaMarketTypes.js';
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export function createMarketUnitOfWork(
  repository: MarketRepository,
  cipher: EncryptedFieldCipher,
  authorize?: (
    tx: MarketTransaction,
    actor: string,
    payload: unknown,
  ) => Promise<void>,
) {
  return {
    // Caller must authenticate/revalidate the actor before entering, including replays.
    execute: <T>(
      actor: string,
      requestId: string,
      payload: unknown,
      work: (tx: MarketTransaction) => Promise<T>,
    ): Promise<T> => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        return Promise.reject(new MarketError('INVALID_INPUT', 'requestId'));
      const hash = createHash('sha256')
        .update(canonical(payload))
        .digest('hex');
      const context = `park-market-operation:${actor}:${requestId}`;
      return repository.transaction(async (tx) => {
        await authorize?.(tx, actor, payload);
        const [existing] = await tx.all(
          'SELECT request_hash,result FROM park_market_operations WHERE actor_id=? AND request_id=?',
          [actor, requestId],
        );
        if (existing) {
          if (existing.request_hash !== hash)
            throw new MarketError('CONFLICT', 'requestId');
          return JSON.parse(
            cipher.decryptText(JSON.parse(String(existing.result)), context),
          ) as T;
        }
        const result = await work(tx);
        const encrypted = JSON.stringify(
          cipher.encryptText(JSON.stringify(result), context),
        );
        await tx.run(
          'INSERT INTO park_market_operations(actor_id,request_id,request_hash,result,created_at) VALUES (?,?,?,?,?)',
          [actor, requestId, hash, encrypted, Date.now()],
        );
        return result;
      });
    },
  };
}
