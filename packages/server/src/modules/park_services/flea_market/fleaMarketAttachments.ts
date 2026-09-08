import type { MarketImageQuota } from './fleaMarketStorageQuota.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { MarketObjectStore } from './fleaMarketObjectStore.js';
import type {
  MarketRepository,
  MarketTransaction,
} from './fleaMarketRepository.js';
import { MarketError, type MarketPrincipal } from './fleaMarketTypes.js';
import { samePark, requireActive } from './fleaMarketAccess.js';
import { processMarketImage } from './fleaMarketImageProcessing.js';
import { MARKET_DAY } from './fleaMarketLifecycle.js';
export function imageAccessAllowed(
  actor: MarketPrincipal | null,
  owner: string,
  park: string,
  scope: 'draft' | 'listing',
  listingReadable: boolean,
): boolean {
  return (
    samePark(actor, park) &&
    (scope === 'draft' ? actor!.accountId === owner : listingReadable)
  );
}
export interface MarketImageDependencies {
  repository: MarketRepository;
  objects: MarketObjectStore;
  principal(
    tx: MarketTransaction,
    accountId: string,
  ): Promise<MarketPrincipal | null>;
  listingReadable(
    tx: MarketTransaction,
    actor: MarketPrincipal,
    listingId: string,
  ): Promise<boolean>;
  evidenceReadable?(
    tx: MarketTransaction,
    actor: MarketPrincipal,
    evidenceId: string,
  ): Promise<boolean>;
  now?: () => number;
  imageQuota?: MarketImageQuota;
}
export function createMarketAttachments(deps: MarketImageDependencies) {
  const now = deps.now ?? Date.now;
  const ownImages = async (
    tx: MarketTransaction,
    actor: MarketPrincipal,
    ids: string[],
  ) => {
    for (const id of ids) {
      const [image] = await tx.all(
        'SELECT * FROM park_market_images WHERE id=?',
        [id],
      );
      if (
        !image ||
        image.owner_id !== actor.accountId ||
        !samePark(actor, String(image.park_id)) ||
        image.state !== 'available'
      )
        throw new MarketError('NOT_FOUND', 'imageIds');
      const listingRefs = await tx.all(
        "SELECT object_id FROM park_market_image_refs WHERE image_id=? AND kind='listing'",
        [id],
      );
      if (listingRefs.length) {
        let readable = false;
        for (const ref of listingRefs)
          if (await deps.listingReadable(tx, actor, String(ref.object_id)))
            readable = true;
        if (!readable) throw new MarketError('NOT_FOUND', 'imageIds');
      }
    }
  };
  return {
    async upload(accountId: string, draftId: string, content: Buffer) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(draftId))
        throw new MarketError('INVALID_INPUT', 'draftId');
      const actor = await deps.repository.read((tx) =>
        deps.principal(tx, accountId),
      );
      requireActive(actor);
      if (!actor.parkId || !samePark(actor, actor.parkId))
        throw new MarketError('FORBIDDEN');
      const result = await processMarketImage(content);
      const id = randomUUID();
      // Objects first; DB binding is atomic. Failed bindings are compensated here.
      const detail = await deps.objects.put({
        namespace: `park-market:${actor.parkId}`,
        objectId: id,
        content: result.detail,
      });
      let thumb: { key: string; storedBytes?: number } | undefined;
      try {
        thumb = await deps.objects.put({
          namespace: `park-market:${actor.parkId}`,
          objectId: `${id}-thumb`,
          content: result.thumbnail,
        });
        await deps.repository.transaction(async (tx) => {
          const current = await deps.principal(tx, accountId);
          requireActive(current);
          if (!samePark(current, actor.parkId!))
            throw new MarketError('FORBIDDEN');
          const [{ count }] = await tx.all(
            'SELECT COUNT(*) AS count FROM park_market_images WHERE owner_id=? AND state=?',
            [accountId, 'available'],
          );
          if (Number(count) >= 400)
            throw new MarketError('LIMIT_REACHED', 'images');
          await deps.imageQuota?.charge(
            tx,
            current,
            id,
            (detail.storedBytes ?? result.detail.length) +
              (thumb!.storedBytes ?? result.thumbnail.length),
          );
          await tx.run(
            'INSERT INTO park_market_images(id,owner_id,park_id,state,object_key,thumbnail_key,width,height,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [
              id,
              accountId,
              actor.parkId,
              'available',
              detail.key,
              thumb!.key,
              result.width,
              result.height,
              result.detail.length + result.thumbnail.length,
              now(),
            ],
          );
          await tx.run(
            'INSERT INTO park_market_image_refs(image_id,kind,object_id,owner_id,expires_at) VALUES (?,?,?,?,?)',
            [id, 'draft', draftId, accountId, now() + 30 * MARKET_DAY],
          );
        });
      } catch (error) {
        await deps.objects.delete(detail.key);
        if (thumb) await deps.objects.delete(thumb.key);
        throw error;
      }
      return {
        id,
        width: result.width,
        height: result.height,
        state: 'available' as const,
      };
    },
    async lease(accountId: string, draftId: string, ids: string[]) {
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(draftId) ||
        ids.length > 9 ||
        new Set(ids).size !== ids.length
      )
        throw new MarketError('INVALID_INPUT');
      return deps.repository.transaction(async (tx) => {
        const actor = await deps.principal(tx, accountId);
        requireActive(actor);
        await ownImages(tx, actor, ids);
        await tx.run(
          "DELETE FROM park_market_image_refs WHERE kind='draft' AND object_id=? AND owner_id=?",
          [draftId, accountId],
        );
        for (const id of ids)
          await tx.run(
            "INSERT INTO park_market_image_refs VALUES (?,'draft',?,?,?)",
            [id, draftId, accountId, now() + 30 * MARKET_DAY],
          );
      });
    },
    async read(accountId: string, id: string, thumbnail = false) {
      return deps.repository.read(async (tx) => {
        const actor = await deps.principal(tx, accountId);
        requireActive(actor);
        const [image] = await tx.all(
          'SELECT * FROM park_market_images WHERE id=?',
          [id],
        );
        if (
          !image ||
          image.state !== 'available' ||
          !samePark(actor, String(image.park_id))
        )
          throw new MarketError('NOT_FOUND');
        const refs = await tx.all(
          'SELECT * FROM park_market_image_refs WHERE image_id=?',
          [id],
        );
        let allowed = false;
        for (const ref of refs) {
          if (
            ref.kind === 'evidence' &&
            (ref.expires_at === null || Number(ref.expires_at) > now()) &&
            (await deps.evidenceReadable?.(tx, actor, String(ref.object_id)))
          )
            allowed = true;
          if (
            ref.kind === 'draft' &&
            !refs.some((candidate) => candidate.kind === 'listing') &&
            ref.owner_id === accountId &&
            Number(ref.expires_at) > now()
          )
            allowed = true;
          if (
            ref.kind === 'listing' &&
            (await deps.listingReadable(tx, actor, String(ref.object_id)))
          )
            allowed = true;
        }
        if (!allowed) throw new MarketError('NOT_FOUND');
        return {
          content: await deps.objects.read(
            String(thumbnail ? image.thumbnail_key : image.object_key),
          ),
          contentType: 'image/jpeg',
          cacheControl: 'private, no-store',
        };
      });
    },
    async cleanup() {
      return deps.repository.transaction(async (tx) => {
        await tx.run(
          "DELETE FROM park_market_image_refs WHERE kind IN ('draft','evidence') AND expires_at<=?",
          [now()],
        );
        const images = await tx.all(
          "SELECT * FROM park_market_images WHERE state='available'",
        );
        for (const image of images) {
          const refs = await tx.all(
            'SELECT image_id FROM park_market_image_refs WHERE image_id=?',
            [image.id],
          );
          if (refs.length) {
            await tx.run(
              'UPDATE park_market_images SET orphaned_at=NULL WHERE id=?',
              [image.id],
            );
            continue;
          }
          if (image.orphaned_at === null) {
            await tx.run(
              'UPDATE park_market_images SET orphaned_at=? WHERE id=?',
              [now(), image.id],
            );
            continue;
          }
          if (now() - Number(image.orphaned_at) < 7 * MARKET_DAY) continue;
          // Access is denied already because there is no live reference. Retrying deletion is safe.
          await deps.objects.delete(String(image.object_key));
          await deps.objects.delete(String(image.thumbnail_key));
          await deps.imageQuota?.release(tx, String(image.id));
          await tx.run(
            "UPDATE park_market_images SET state='cleaned',object_key=NULL,thumbnail_key=NULL WHERE id=?",
            [image.id],
          );
        }
      });
    },
    validateOwned: ownImages,
  };
}
