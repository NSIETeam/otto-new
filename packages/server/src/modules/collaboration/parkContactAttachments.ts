/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type { MarketTransaction } from '../park_services/flea_market/fleaMarketRepository.js';
import type { MarketServiceDependencies } from '../park_services/flea_market/fleaMarketService.js';
import type { MarketObjectStore } from '../park_services/flea_market/fleaMarketObjectStore.js';
import type { MarketImageQuota } from '../park_services/flea_market/fleaMarketStorageQuota.js';
import { MarketError } from '../park_services/flea_market/fleaMarketTypes.js';
import {
  requireActive,
  samePark,
} from '../park_services/flea_market/fleaMarketAccess.js';
export const PARK_CONTACT_ATTACHMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS park_contact_attachments (
 id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,owner_id TEXT NOT NULL,message_id TEXT NOT NULL,
 object_key TEXT NOT NULL,bytes BIGINT NOT NULL,sha256 TEXT NOT NULL,created_at BIGINT NOT NULL,bound_at BIGINT
);
CREATE INDEX IF NOT EXISTS park_contact_attachment_message ON park_contact_attachments(message_id);
CREATE INDEX IF NOT EXISTS park_contact_attachment_gc ON park_contact_attachments(bound_at,created_at);
`;
const identifier = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const PARK_CONTACT_UPLOAD_INTENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS park_contact_upload_intents(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,object_key TEXT NOT NULL,created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS park_contact_upload_intent_age ON park_contact_upload_intents(created_at,id);`;
export function createParkContactAttachments(
  deps: Omit<MarketServiceDependencies, 'config'> & {
    objects: MarketObjectStore;
    quota?: MarketImageQuota;
    deviceAllowed(
      tx: MarketTransaction,
      actor: string,
      device: string,
    ): Promise<boolean>;
  },
) {
  const now = deps.now ?? Date.now;
  async function authority(
    tx: MarketTransaction,
    actor: string,
    conversationId: string,
    deviceId?: string,
    write = false,
  ) {
    const principal = await deps.principal(tx, actor);
    requireActive(principal);
    const [thread] = await tx.all(
      'SELECT * FROM park_market_conversations WHERE id=? AND (account_a=? OR account_b=?)',
      [conversationId, actor, actor],
    );
    if (!thread) throw new MarketError('NOT_FOUND');
    if (!samePark(principal, String(thread.park_id)))
      throw new MarketError('FORBIDDEN');
    if (
      deviceId !== undefined &&
      !(await deps.deviceAllowed(tx, actor, deviceId))
    )
      throw new MarketError('FORBIDDEN', 'device');
    if (write) {
      const peer = String(
        thread.account_a === actor ? thread.account_b : thread.account_a,
      );
      if (
        thread.state !== 'active' ||
        !samePark(await deps.principal(tx, peer), String(thread.park_id))
      )
        throw new MarketError('FORBIDDEN');
      if (
        (
          await tx.all(
            'SELECT park_id FROM park_market_blocks WHERE park_id=? AND ((blocker_id=? AND peer_id=?) OR (blocker_id=? AND peer_id=?))',
            [thread.park_id, actor, peer, peer, actor],
          )
        ).length
      )
        throw new MarketError('FORBIDDEN');
    }
    return principal;
  }
  return {
    async upload(
      actor: string,
      input: {
        id: string;
        conversationId: string;
        messageId: string;
        deviceId: string;
        bytes: Buffer;
      },
    ) {
      if (
        ![
          input.id,
          input.conversationId,
          input.messageId,
          input.deviceId,
        ].every(identifier) ||
        !Buffer.isBuffer(input.bytes) ||
        input.bytes.length < 17 ||
        input.bytes.length > 10 * 1024 * 1024 + 160
      )
        throw new MarketError('INVALID_INPUT', 'attachment');
      const hash = createHash('sha256').update(input.bytes).digest('hex');
      // Filesystem keys can be reserved before IO. A process death immediately
      // after write therefore leaves a durable cleanup intent, not a permanent orphan.
      // Remote stores use their existing aged object sweep with market reference checks.
      const reservedKey = deps.objects.keyFor?.(
        'park-contact-attachment',
        input.id,
      );
      if (reservedKey)
        await deps.repository.transaction(async (tx) => {
          await authority(
            tx,
            actor,
            input.conversationId,
            input.deviceId,
            true,
          );
          const [count] = await tx.all(
            'SELECT COUNT(*) AS count FROM park_contact_upload_intents WHERE owner_id=?',
            [actor],
          );
          const [existing] = await tx.all(
            'SELECT id FROM park_contact_upload_intents WHERE id=?',
            [input.id],
          );
          if (!existing && Number(count.count) >= 36)
            throw new MarketError('LIMIT_REACHED', 'pendingAttachments');
          await tx.run(
            'INSERT INTO park_contact_upload_intents VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
            [input.id, actor, reservedKey, now()],
          );
        });
      return deps.repository.transaction(async (tx) => {
        const principal = await authority(
          tx,
          actor,
          input.conversationId,
          input.deviceId,
          true,
        );
        const [existing] = await tx.all(
          'SELECT * FROM park_contact_attachments WHERE id=?',
          [input.id],
        );
        if (existing) {
          if (
            existing.owner_id !== actor ||
            existing.conversation_id !== input.conversationId ||
            existing.message_id !== input.messageId ||
            existing.sha256 !== hash
          )
            throw new MarketError('CONFLICT', 'attachment');
          await tx.run('DELETE FROM park_contact_upload_intents WHERE id=?', [
            input.id,
          ]);
          return { id: input.id, bytes: Number(existing.bytes), sha256: hash };
        }
        const [count] = await tx.all(
          'SELECT COUNT(*) AS count FROM park_contact_attachments WHERE owner_id=? AND bound_at IS NULL',
          [actor],
        );
        if (Number(count.count) >= 36)
          throw new MarketError('LIMIT_REACHED', 'pendingAttachments');
        // The content is already client ciphertext. The shared encrypted store adds
        // at-rest protection, and this independent namespace cannot be a listing image.
        const object = await deps.objects.put({
          namespace: 'park-contact-attachment',
          objectId: input.id,
          content: input.bytes,
        });
        try {
          await deps.quota?.charge(
            tx,
            principal,
            `chat:${input.id}`,
            object.storedBytes ?? input.bytes.length,
          );
          await tx.run(
            'INSERT INTO park_contact_attachments VALUES (?,?,?,?,?,?,?,?,NULL)',
            [
              input.id,
              input.conversationId,
              actor,
              input.messageId,
              object.key,
              input.bytes.length,
              hash,
              now(),
            ],
          );
          await tx.run('DELETE FROM park_contact_upload_intents WHERE id=?', [
            input.id,
          ]);
        } catch (error) {
          await deps.objects.delete(object.key);
          throw error;
        }
        return { id: input.id, bytes: input.bytes.length, sha256: hash };
      });
    },
    async bind(
      tx: MarketTransaction,
      actor: string,
      conversationId: string,
      messageId: string,
      ids: string[],
    ) {
      if (
        !Array.isArray(ids) ||
        ids.length > 6 ||
        new Set(ids).size !== ids.length ||
        !ids.every(identifier)
      )
        throw new MarketError('INVALID_INPUT', 'attachments');
      if (!ids.length) return;
      await authority(tx, actor, conversationId, undefined, true);
      for (const id of ids) {
        const [row] = await tx.all(
          'SELECT * FROM park_contact_attachments WHERE id=? AND owner_id=? AND conversation_id=? AND message_id=?',
          [id, actor, conversationId, messageId],
        );
        if (
          !row ||
          (row.bound_at === null && Number(row.created_at) + 86400000 <= now())
        )
          throw new MarketError('INVALID_INPUT', 'attachment');
        await tx.run(
          'UPDATE park_contact_attachments SET bound_at=COALESCE(bound_at,?) WHERE id=?',
          [now(), id],
        );
      }
    },
    async read(actor: string, id: string, deviceId: string) {
      return deps.repository.read(async (tx) => {
        const [row] = await tx.all(
          'SELECT * FROM park_contact_attachments WHERE id=? AND bound_at IS NOT NULL',
          [id],
        );
        if (!row) throw new MarketError('NOT_FOUND');
        await authority(tx, actor, String(row.conversation_id), deviceId);
        return deps.objects.read(String(row.object_key));
      });
    },
    async cleanup() {
      return deps.repository.transaction(async (tx) => {
        for (const intent of await tx.all(
          'SELECT id,object_key FROM park_contact_upload_intents WHERE created_at<=? ORDER BY created_at,id LIMIT 100',
          [now() - 86400000],
        )) {
          const [owner] = await tx.all(
            'SELECT id FROM park_contact_attachments WHERE id=?',
            [intent.id],
          );
          if (!owner) await deps.objects.delete(String(intent.object_key));
          await tx.run('DELETE FROM park_contact_upload_intents WHERE id=?', [
            intent.id,
          ]);
        }
        const rows = await tx.all(
          'SELECT id,object_key FROM park_contact_attachments WHERE bound_at IS NULL AND created_at<=? ORDER BY created_at,id LIMIT 100',
          [now() - 86400000],
        );
        for (const row of rows) {
          await deps.objects.delete(String(row.object_key));
          await deps.quota?.release(tx, `chat:${row.id}`);
          await tx.run('DELETE FROM park_contact_attachments WHERE id=?', [
            row.id,
          ]);
        }
        return rows.length;
      });
    },
  };
}
