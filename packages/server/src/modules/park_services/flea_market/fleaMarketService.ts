import { indexMarketListing } from './fleaMarketSearchIndex.js';
import { endMarketListingRequests } from './fleaMarketContacts.js';
import { createMarketDiscovery } from './fleaMarketDiscovery.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import type { EncryptedFieldCipher } from '../../data_platform/index.js';
import type {
  MarketRepository,
  MarketTransaction,
} from './fleaMarketRepository.js';
import {
  MarketError,
  type MarketPrincipal,
  type MarketConfig,
  type Listing,
} from './fleaMarketTypes.js';
import {
  canDiscover,
  requireActive,
  canManageOwn,
  canReadHistory,
  samePark,
  publicListing,
} from './fleaMarketAccess.js';
import { validateListing } from './fleaMarketValidation.js';
import { MARKET_DAY, transitionListing } from './fleaMarketLifecycle.js';
import { createMarketUnitOfWork } from './fleaMarketUnitOfWork.js';
export interface MarketServiceDependencies {
  repository: MarketRepository;
  cipher: EncryptedFieldCipher;
  now?: () => number;
  principal(
    tx: MarketTransaction,
    accountId: string,
  ): Promise<MarketPrincipal | null>;
  config(tx: MarketTransaction, parkId: string): Promise<MarketConfig>;
}
export function createMarketService(deps: MarketServiceDependencies) {
  const now = deps.now ?? Date.now;
  const unit = createMarketUnitOfWork(
    deps.repository,
    deps.cipher,
    async (tx, actor) => {
      requireActive(await deps.principal(tx, actor));
    },
  );
  const encode = (listing: Listing) =>
    JSON.stringify(
      deps.cipher.encryptText(
        JSON.stringify(listing),
        `park-market-listing:${listing.id}`,
      ),
    );
  async function publishPermission(
    tx: MarketTransaction,
    actor: MarketPrincipal,
    parkId: string,
  ) {
    const config = await deps.config(tx, parkId);
    if (!canDiscover(actor, config, parkId)) throw new MarketError('FORBIDDEN');
    const restricted = await tx.all(
      'SELECT id FROM park_market_restrictions WHERE park_id=? AND account_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)',
      [parkId, actor.accountId, now()],
    );
    if (restricted.length) throw new MarketError('FORBIDDEN');
    return config;
  }
  async function validateImages(
    tx: MarketTransaction,
    actor: MarketPrincipal,
    parkId: string,
    ids: string[],
  ) {
    for (const id of ids) {
      const [image] = await tx.all(
        'SELECT * FROM park_market_images WHERE id=?',
        [id],
      );
      if (
        !image ||
        image.owner_id !== actor.accountId ||
        image.park_id !== parkId ||
        image.state !== 'available'
      )
        throw new MarketError('INVALID_INPUT', 'imageIds');
      // Ownership alone cannot reactivate content whose listing access was revoked.
      const refs = await tx.all(
        'SELECT kind,object_id,expires_at FROM park_market_image_refs WHERE image_id=? AND owner_id=?',
        [id, actor.accountId],
      );
      const listingRefs = refs.filter((ref) => ref.kind === 'listing');
      let reusable = false;
      for (const ref of listingRefs) {
        const [row] = await tx.all(
          'SELECT payload FROM park_market_listings WHERE id=?',
          [ref.object_id],
        );
        if (!row) continue;
        const linked: Listing = JSON.parse(
          deps.cipher.decryptText(
            JSON.parse(String(row.payload)),
            `park-market-listing:${ref.object_id}`,
          ),
        );
        if (
          !['removed', 'deleted'].includes(linked.state) &&
          linked.cleanedAt === null
        )
          reusable = true;
      }
      if (!listingRefs.length)
        reusable = refs.some(
          (ref) => ref.kind === 'draft' && Number(ref.expires_at) > now(),
        );
      if (!reusable) throw new MarketError('INVALID_INPUT', 'imageIds');
    }
  }
  async function consumeQuota(
    tx: MarketTransaction,
    actor: MarketPrincipal,
    parkId: string,
    timezone: string,
  ) {
    const [{ count }] = await tx.all(
      "SELECT COUNT(*) AS count FROM park_market_listings WHERE owner_id=? AND state IN ('active','reserved')",
      [actor.accountId],
    );
    if (Number(count) >= 20)
      throw new MarketError('LIMIT_REACHED', 'activeListings');
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now());
    await tx.run(
      "INSERT INTO park_market_quota VALUES (?,?,?,'publish',0) ON CONFLICT DO NOTHING",
      [parkId, actor.accountId, day],
    );
    const changed = await tx.run(
      "UPDATE park_market_quota SET used=used+1 WHERE park_id=? AND account_id=? AND day=? AND kind='publish' AND used<10",
      [parkId, actor.accountId, day],
    );
    if (!changed) throw new MarketError('LIMIT_REACHED', 'dailyPublications');
  }
  const decode = (row: Record<string, unknown>): Listing =>
    JSON.parse(
      deps.cipher.decryptText(
        JSON.parse(String(row.payload)),
        `park-market-listing:${row.id}`,
      ),
    );
  async function load(tx: MarketTransaction, id: string): Promise<Listing> {
    const [row] = await tx.all(
      'SELECT * FROM park_market_listings WHERE id=?',
      [id],
    );
    if (!row) throw new MarketError('NOT_FOUND');
    return decode(row);
  }
  async function save(
    tx: MarketTransaction,
    listing: Listing,
    previousVersion: number,
    actor: string,
    action: string,
  ) {
    const changed = await tx.run(
      'UPDATE park_market_listings SET version=?,state=?,category=?,price_cents=?,listed_at=?,expires_at=?,updated_at=?,ended_at=?,payload=? WHERE id=? AND version=?',
      [
        listing.version,
        listing.state,
        listing.category,
        listing.priceCents,
        listing.listedAt,
        listing.expiresAt,
        listing.updatedAt,
        listing.endedAt,
        encode(listing),
        listing.id,
        previousVersion,
      ],
    );
    if (changed !== 1) throw new MarketError('CONFLICT', 'expectedVersion');
    await indexMarketListing(tx, deps.cipher, listing);
    if (!['active', 'reserved'].includes(listing.state))
      await endMarketListingRequests(tx, listing.id);
    await tx.run('INSERT INTO park_market_history VALUES (?,?,?,?,?,?,?)', [
      randomUUID(),
      listing.id,
      listing.version,
      actor,
      action,
      now(),
      encode(listing),
    ]);
  }
  return {
    ...createMarketDiscovery(deps),
    async edit(
      accountId: string,
      id: string,
      input: Record<string, unknown>,
    ): Promise<Listing> {
      requireActive(
        await deps.repository.read((tx) => deps.principal(tx, accountId)),
      );
      return unit.execute(
        accountId,
        String(input.requestId ?? ''),
        { id, action: 'edit', input },
        async (tx) => {
          const actor = await deps.principal(tx, accountId);
          requireActive(actor);
          const previous = await load(tx, id);
          if (!canManageOwn(actor, previous))
            throw new MarketError('NOT_FOUND');
          if (
            previous.version !== input.expectedVersion ||
            !['active', 'reserved', 'offline'].includes(previous.state) ||
            previous.cleanedAt !== null
          )
            throw new MarketError('CONFLICT');
          if (!samePark(actor, previous.parkId))
            throw new MarketError('FORBIDDEN');
          const fields = validateListing(input);
          const allImagesChanged = !fields.imageIds.some((id) =>
            previous.imageIds.includes(id),
          );
          if (
            (fields.category !== previous.category || allImagesChanged) &&
            input.sameItemConfirmed !== true
          )
            throw new MarketError('INVALID_INPUT', 'sameItemConfirmed');
          await validateImages(tx, actor, previous.parkId, fields.imageIds);
          const listing = {
            ...previous,
            ...fields,
            version: previous.version + 1,
            updatedAt: now(),
          };
          await save(tx, listing, previous.version, accountId, 'edit');
          await tx.run(
            "DELETE FROM park_market_image_refs WHERE kind='listing' AND object_id=?",
            [id],
          );
          for (const imageId of fields.imageIds) {
            await tx.run(
              "INSERT INTO park_market_image_refs VALUES (?,'listing',?,?,NULL)",
              [imageId, id, accountId],
            );
            await tx.run(
              "DELETE FROM park_market_image_refs WHERE image_id=? AND kind='draft' AND owner_id=?",
              [imageId, accountId],
            );
          }
          return listing;
        },
      );
    },
    async command(
      accountId: string,
      id: string,
      action: string,
      input: Record<string, unknown>,
    ): Promise<Listing> {
      requireActive(
        await deps.repository.read((tx) => deps.principal(tx, accountId)),
      );
      return unit.execute(
        accountId,
        String(input.requestId ?? ''),
        { id, action, input },
        async (tx) => {
          const actor = await deps.principal(tx, accountId);
          requireActive(actor);
          const previous = await load(tx, id);
          if (!canManageOwn(actor, previous))
            throw new MarketError('NOT_FOUND');
          if (previous.version !== input.expectedVersion)
            throw new MarketError('CONFLICT', 'expectedVersion');
          if (
            ['expire', 'identity-offline', 'restriction-offline'].includes(
              action,
            )
          )
            throw new MarketError('FORBIDDEN');
          const next = transitionListing(previous, action, now(), input);
          if (['active', 'reserved'].includes(next.state)) {
            const config = await publishPermission(tx, actor, previous.parkId);
            await validateImages(tx, actor, previous.parkId, next.imageIds);
            if (action === 'relist')
              await consumeQuota(tx, actor, previous.parkId, config.timezone);
            else if (!['active', 'reserved'].includes(previous.state)) {
              const [{ count }] = await tx.all(
                "SELECT COUNT(*) AS count FROM park_market_listings WHERE owner_id=? AND state IN ('active','reserved')",
                [accountId],
              );
              if (Number(count) >= 20)
                throw new MarketError('LIMIT_REACHED', 'activeListings');
            }
          }
          await save(tx, next, previous.version, accountId, action);
          if (next.state === 'deleted')
            await tx.run(
              "DELETE FROM park_market_image_refs WHERE kind='listing' AND object_id=?",
              [id],
            );
          return next;
        },
      );
    },
    async hide(accountId: string, id: string) {
      return deps.repository.transaction(async (tx) => {
        requireActive(await deps.principal(tx, accountId));
        const listing = await load(tx, id);
        if (listing.ownerId !== accountId) throw new MarketError('NOT_FOUND');
        if (listing.state !== 'removed') throw new MarketError('CONFLICT');
        await tx.run(
          'INSERT INTO park_market_hidden_records VALUES (?,?,?) ON CONFLICT DO NOTHING',
          [accountId, id, now()],
        );
        return { hidden: true };
      });
    },
    async mine(
      accountId: string,
    ): Promise<Array<Listing & { pendingContacts: number }>> {
      return deps.repository.read(async (tx) => {
        const actor = await deps.principal(tx, accountId);
        requireActive(actor);
        const rows = await tx.all(
          "SELECT l.* FROM park_market_listings l WHERE owner_id=? AND NOT EXISTS (SELECT 1 FROM park_market_hidden_records h WHERE h.account_id=l.owner_id AND h.listing_id=l.id AND l.state='removed') ORDER BY updated_at DESC,id",
          [accountId],
        );
        const counts = await tx.all(
          "SELECT r.listing_id,COUNT(*) AS count FROM park_market_contact_requests r JOIN park_market_listings l ON l.id=r.listing_id WHERE l.owner_id=? AND l.state IN ('active','reserved') AND r.state='pending' AND r.expires_at>? GROUP BY r.listing_id",
          [accountId, now()],
        );
        return rows.map((row) => {
          const listing = decode(row);
          const content =
            samePark(actor, listing.parkId) &&
            !['deleted', 'removed'].includes(listing.state)
              ? listing
              : { ...listing, imageIds: [] };
          return {
            ...content,
            pendingContacts: Number(
              counts.find((count) => count.listing_id === listing.id)?.count ??
                0,
            ),
          };
        });
      });
    },
    async detail(accountId: string, id: string) {
      return deps.repository.read(async (tx) => {
        const actor = await deps.principal(tx, accountId);
        requireActive(actor);
        const listing = await load(tx, id);
        if (!samePark(actor, listing.parkId))
          throw new MarketError('NOT_FOUND');
        const owner = await deps.principal(tx, listing.ownerId);
        if (!samePark(owner, listing.parkId))
          throw new MarketError('NOT_FOUND');
        if (
          ['removed', 'deleted'].includes(listing.state) ||
          listing.cleanedAt !== null
        )
          return { id, state: 'unavailable' as const };
        const grant = await tx.all(
          'SELECT consultation_id FROM park_market_grants WHERE park_id=? AND listing_id=? AND account_id=?',
          [listing.parkId, id, accountId],
        );
        if (
          canManageOwn(actor, listing) ||
          canReadHistory(actor, listing, grant.length > 0)
        )
          return {
            ...publicListing(listing, owner),
            isOwner: actor.accountId === listing.ownerId,
          };
        const config = await deps.config(tx, listing.parkId);
        if (!canDiscover(actor, config, listing.parkId))
          throw new MarketError('NOT_FOUND');
        if (
          !['active', 'reserved'].includes(listing.state) ||
          listing.expiresAt <= now()
        )
          return {
            id,
            state: listing.expiresAt <= now() ? 'offline' : listing.state,
          };
        return {
          ...publicListing(listing, owner),
          isOwner: actor.accountId === listing.ownerId,
        };
      });
    },
    async publish(
      accountId: string,
      input: Record<string, unknown>,
    ): Promise<Listing> {
      // Authenticate before replay; revalidate again inside the write transaction.
      const initial = await deps.repository.read((tx) =>
        deps.principal(tx, accountId),
      );
      requireActive(initial);
      return unit.execute(
        accountId,
        String(input.requestId ?? ''),
        { action: 'publish', input },
        async (tx) => {
          const actor = await deps.principal(tx, accountId);
          requireActive(actor);
          if (!actor.parkId) throw new MarketError('FORBIDDEN');
          const config = await publishPermission(tx, actor, actor.parkId);
          const fields = validateListing(input);
          await validateImages(tx, actor, actor.parkId, fields.imageIds);
          await consumeQuota(tx, actor, actor.parkId, config.timezone);
          const time = now();
          const id = randomUUID();
          const listing: Listing = {
            ...fields,
            id,
            parkId: actor.parkId,
            ownerId: accountId,
            version: 1,
            state: 'active',
            createdAt: time,
            listedAt: time,
            confirmedAt: time,
            expiresAt: time + 30 * MARKET_DAY,
            updatedAt: time,
            reservation: null,
            offlineAt: null,
            offlineReason: null,
            offlineVersion: null,
            soldAt: null,
            soldFrom: null,
            lastRelistedAt: null,
            endedAt: null,
            cleanedAt: null,
          };
          await tx.run(
            'INSERT INTO park_market_listings(id,park_id,owner_id,version,state,category,price_cents,listed_at,expires_at,updated_at,ended_at,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            [
              id,
              actor.parkId,
              accountId,
              1,
              'active',
              fields.category,
              fields.priceCents,
              time,
              listing.expiresAt,
              time,
              null,
              encode(listing),
            ],
          );
          await indexMarketListing(tx, deps.cipher, listing);
          for (const imageId of fields.imageIds) {
            await tx.run(
              "INSERT INTO park_market_image_refs VALUES (?,'listing',?,?,NULL)",
              [imageId, id, accountId],
            );
            await tx.run(
              "DELETE FROM park_market_image_refs WHERE image_id=? AND kind='draft' AND owner_id=?",
              [imageId, accountId],
            );
          }
          await tx.run(
            'INSERT INTO park_market_history VALUES (?,?,?,?,?,?,?)',
            [randomUUID(), id, 1, accountId, 'publish', time, encode(listing)],
          );
          return listing;
        },
      );
    },
  };
}
