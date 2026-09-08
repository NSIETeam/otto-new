/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { AttachmentObjectStore } from '../../data_platform/attachmentObjectStore.js';
import { ciphertextSha256 } from '../../data_platform/attachmentObjectStore.js';
import type { EncryptedFieldCipher } from '../../data_platform/encryptedFieldCipher.js';
export interface MarketObjectStore {
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
