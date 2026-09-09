/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { MarketTransaction } from './fleaMarketRepository.js';
import { MarketError, type MarketPrincipal } from './fleaMarketTypes.js';
export const MARKET_IMAGE_CHARGE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS park_market_image_charges(image_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,bytes BIGINT NOT NULL CHECK(bytes>0));`;
export interface MarketImageQuota {
  charge(
    tx: MarketTransaction,
    actor: MarketPrincipal,
    imageId: string,
    bytes: number,
  ): Promise<void>;
  release(tx: MarketTransaction, imageId: string): Promise<void>;
}
export function createMarketPostgresImageQuota(
  defaultQuotaBytes: number,
): MarketImageQuota {
  if (!Number.isSafeInteger(defaultQuotaBytes) || defaultQuotaBytes < 1)
    throw new Error('invalid market image quota');
  return {
    async charge(tx, actor, imageId, bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 1)
        throw new MarketError('INVALID_INPUT', 'imageBytes');
      await tx.run(
        'INSERT INTO attachment_storage_quotas(organization_id,max_bytes) VALUES (?,?) ON CONFLICT DO NOTHING',
        [actor.organizationId, defaultQuotaBytes],
      );
      const changed = await tx.run(
        'UPDATE attachment_storage_quotas SET stored_bytes=stored_bytes+?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND reserved_bytes+stored_bytes+?<=max_bytes',
        [bytes, actor.organizationId, bytes],
      );
      if (!changed) throw new MarketError('LIMIT_REACHED', 'storageBytes');
      await tx.run('INSERT INTO park_market_image_charges VALUES (?,?,?)', [
        imageId,
        actor.organizationId,
        bytes,
      ]);
    },
    async release(tx, imageId) {
      const [charge] = await tx.all(
        'SELECT * FROM park_market_image_charges WHERE image_id=?',
        [imageId],
      );
      if (!charge) return;
      const changed = await tx.run(
        'UPDATE attachment_storage_quotas SET stored_bytes=stored_bytes-?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND stored_bytes>=?',
        [charge.bytes, charge.organization_id, charge.bytes],
      );
      if (!changed)
        throw new Error('market image quota accounting is inconsistent');
      await tx.run('DELETE FROM park_market_image_charges WHERE image_id=?', [
        imageId,
      ]);
    },
  };
}
