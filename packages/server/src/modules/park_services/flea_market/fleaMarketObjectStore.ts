/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { AttachmentObjectStore } from '../../data_platform/attachmentObjectStore.js';
import { ciphertextSha256 } from '../../data_platform/attachmentObjectStore.js';
import type { EncryptedFieldCipher } from '../../data_platform/encryptedFieldCipher.js';
/** Every committed owner, including uploads awaiting message binding, protects its object. */
export async function marketRemoteKeyReferenced(
  pool: {
    query(sql: string, args: unknown[]): Promise<{ rows: unknown[] }>;
  },
  key: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT id FROM park_market_images WHERE state='available' AND (
    CASE WHEN left(object_key,1)='{' THEN object_key::jsonb->>'key' ELSE object_key END=$1 OR
    CASE WHEN left(thumbnail_key,1)='{' THEN thumbnail_key::jsonb->>'key' ELSE thumbnail_key END=$1
  ) UNION ALL SELECT id FROM park_contact_attachments WHERE
    CASE WHEN left(object_key,1)='{' THEN object_key::jsonb->>'key' ELSE object_key END=$1 LIMIT 1`,
    [key],
  );
  return result.rows.length > 0;
}
export interface MarketObjectStore {
  keyFor?(namespace: string, objectId: string): string;
  put(input: {
    namespace: string;
    objectId: string;
    content: Buffer;
  }):
    | { key: string; storedBytes?: number }
    | Promise<{ key: string; storedBytes?: number }>;
  read(key: string): Buffer | Promise<Buffer>;
  delete(key: string): void | Promise<void>;
}
/** All downloads stay behind the authenticated market route, including S3. */
export function createMarketRemoteObjects(
  store: AttachmentObjectStore,
  cipher: EncryptedFieldCipher,
): MarketObjectStore {
  return {
    async put(input) {
      const context = `park-market-image:${input.namespace}:${input.objectId}`;
      const bytes = Buffer.from(
        JSON.stringify(
          cipher.encryptText(input.content.toString('base64'), context),
        ),
      );
      const location = await store.putCiphertext({
        ciphertext: bytes,
        ciphertextSha256: ciphertextSha256(bytes),
        encryption: 'server-envelope-v1',
      });
      return {
        key: JSON.stringify({ key: location.key, context }),
        storedBytes: bytes.length,
      };
    },
    async read(pointer) {
      const { key, context } = JSON.parse(pointer);
      return Buffer.from(
        cipher.decryptText(
          JSON.parse((await store.getCiphertext(key)).toString()),
          context,
        ),
        'base64',
      );
    },
    async delete(pointer) {
      await store.deleteObject(JSON.parse(pointer).key);
    },
  };
}
