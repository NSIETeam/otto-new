import { marketSearchKey, marketQueryTokens } from './fleaMarketSearchIndex.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import { MarketError, categories, type Listing } from './fleaMarketTypes.js';
import {
  canDiscover,
  publicListing,
  requireActive,
  samePark,
} from './fleaMarketAccess.js';
import { textField } from './fleaMarketValidation.js';
import type { MarketServiceDependencies } from './fleaMarketService.js';
export interface MarketFilters {
  query?: string;
  category?: string;
  free?: boolean;
  unreserved?: boolean;
  minCents?: number;
  maxCents?: number;
  sort?: 'latest' | 'price-asc' | 'price-desc';
  cursor?: string;
}
export function createMarketDiscovery(deps: MarketServiceDependencies) {
  const decode = (row: Record<string, unknown>): Listing =>
    JSON.parse(
      deps.cipher.decryptText(
        JSON.parse(String(row.payload)),
        `park-market-listing:${row.id}`,
      ),
    );
  const now = deps.now ?? Date.now;
  return {
    async discover(accountId: string, input: MarketFilters) {
      const query = textField(
        input.query ?? '',
        'query',
        0,
        50,
      ).toLocaleLowerCase();
      if (
        input.category &&
        !categories.includes(input.category as (typeof categories)[number])
      )
        throw new MarketError('INVALID_INPUT', 'category');
      for (const value of [input.minCents, input.maxCents])
        if (
          value !== undefined &&
          (!Number.isSafeInteger(value) || value < 0 || value > 99999999)
        )
          throw new MarketError('INVALID_INPUT', 'price');
      if (!input.free && (input.minCents ?? 0) > (input.maxCents ?? 99999999))
        throw new MarketError('INVALID_INPUT', 'price');
      const sort = input.sort ?? 'latest';
      if (!['latest', 'price-asc', 'price-desc'].includes(sort))
        throw new MarketError('INVALID_INPUT', 'sort');
      return deps.repository.read(async (tx) => {
        const actor = await deps.principal(tx, accountId);
        requireActive(actor);
        if (
          !actor.parkId ||
          !canDiscover(actor, await deps.config(tx, actor.parkId), actor.parkId)
        )
          throw new MarketError('FORBIDDEN');
        const searchKey = query
          ? await marketSearchKey(tx, deps.cipher, actor.parkId)
          : null;
        const searchTokens = searchKey
          ? marketQueryTokens(searchKey, query)
          : [];
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([
              actor.parkId,
              query,
              input.category,
              input.free,
              input.unreserved,
              input.minCents,
              input.maxCents,
              sort,
            ]),
          )
          .digest('hex');
        let cursor: { id: string; price: number; time: number } | null = null;
        if (input.cursor) {
          try {
            const parsed = JSON.parse(
              Buffer.from(input.cursor, 'base64url').toString(),
            );
            if (
              parsed.fingerprint !== fingerprint ||
              typeof parsed.id !== 'string' ||
              !Number.isSafeInteger(parsed.price) ||
              !Number.isSafeInteger(parsed.time)
            )
              throw new Error();
            cursor = parsed;
          } catch {
            throw new MarketError('INVALID_INPUT', 'cursor');
          }
        }
        const items = [];
        let exhausted = false;
        // Bounded batches keep SQL sort/filter indexes useful. Text remains encrypted;
        // substring filtering happens after authorized decryption, never SQL wildcards.
        while (items.length < 20 && !exhausted) {
          const where = [
            'park_id=?',
            "state IN ('active','reserved')",
            'expires_at>?',
          ];
          const args: unknown[] = [actor.parkId, now()];
          if (searchTokens.length) {
            where.push(
              `(id IN (SELECT listing_id FROM park_market_search_terms WHERE park_id=? AND token IN (${searchTokens.map(() => '?').join(',')}) GROUP BY listing_id HAVING COUNT(*)=?) OR NOT EXISTS (SELECT 1 FROM park_market_search_documents d WHERE d.listing_id=park_market_listings.id AND d.version=park_market_listings.version))`,
            );
            args.push(actor.parkId, ...searchTokens, searchTokens.length);
          }
          if (input.category) {
            where.push('category=?');
            args.push(input.category);
          }
          if (input.unreserved) where.push("state='active'");
          if (input.free) where.push('price_cents=0');
          else {
            if (input.minCents !== undefined) {
              where.push('price_cents>=?');
              args.push(input.minCents);
            }
            if (input.maxCents !== undefined) {
              where.push('price_cents<=?');
              args.push(input.maxCents);
            }
          }
          if (cursor) {
            if (sort === 'latest') {
              where.push('(listed_at<? OR (listed_at=? AND id>?))');
              args.push(cursor.time, cursor.time, cursor.id);
            } else {
              where.push(
                `(price_cents${sort === 'price-asc' ? '>' : '<'}? OR (price_cents=? AND (listed_at<? OR (listed_at=? AND id>?))))`,
              );
              args.push(
                cursor.price,
                cursor.price,
                cursor.time,
                cursor.time,
                cursor.id,
              );
            }
          }
          const order =
            sort === 'latest'
              ? 'listed_at DESC,id'
              : `price_cents ${sort === 'price-asc' ? 'ASC' : 'DESC'},listed_at DESC,id`;
          const rows = await tx.all(
            `SELECT * FROM park_market_listings WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 100`,
            args,
          );
          exhausted = rows.length < 100;
          for (const row of rows) {
            const listing = decode(row);
            cursor = {
              id: listing.id,
              price: listing.priceCents,
              time: listing.listedAt,
            };
            if (
              query &&
              !`${listing.title}\n${listing.description}`
                .toLocaleLowerCase()
                .includes(query)
            )
              continue;
            const owner = await deps.principal(tx, listing.ownerId);
            if (!samePark(owner, actor.parkId)) continue;
            items.push(publicListing(listing, owner));
            if (items.length === 20) {
              exhausted = false;
              break;
            }
          }
        }
        return {
          items,
          nextCursor:
            !exhausted && cursor
              ? Buffer.from(
                  JSON.stringify({ ...cursor, fingerprint }),
                ).toString('base64url')
              : null,
        };
      });
    },
    async favorite(accountId: string, id: string, enabled: boolean) {
      return deps.repository.transaction(async (tx) => {
        const actor = await deps.principal(tx, accountId);
        requireActive(actor);
        if (!enabled) {
          await tx.run(
            'DELETE FROM park_market_favorites WHERE account_id=? AND listing_id=?',
            [accountId, id],
          );
          return;
        }
        const [row] = await tx.all(
          'SELECT * FROM park_market_listings WHERE id=?',
          [id],
        );
        if (!row) throw new MarketError('NOT_FOUND');
        const listing = decode(row);
        if (
          !canDiscover(
            actor,
            await deps.config(tx, listing.parkId),
            listing.parkId,
          ) ||
          !samePark(
            await deps.principal(tx, listing.ownerId),
            listing.parkId,
          ) ||
          !['active', 'reserved'].includes(listing.state) ||
          listing.expiresAt <= now()
        )
          throw new MarketError('NOT_FOUND');
        await tx.run(
          'INSERT INTO park_market_favorites VALUES (?,?,?) ON CONFLICT DO NOTHING',
          [accountId, id, now()],
        );
      });
    },
    async favorites(accountId: string) {
      return deps.repository.read(async (tx) => {
        const actor = await deps.principal(tx, accountId);
        requireActive(actor);
        const rows = await tx.all(
          'SELECT l.* FROM park_market_favorites f JOIN park_market_listings l ON l.id=f.listing_id WHERE f.account_id=? ORDER BY f.created_at DESC,l.id',
          [accountId],
        );
        const result = [];
        for (const row of rows) {
          const listing = decode(row);
          if (
            !canDiscover(
              actor,
              await deps.config(tx, listing.parkId),
              listing.parkId,
            ) ||
            !samePark(
              await deps.principal(tx, listing.ownerId),
              listing.parkId,
            ) ||
            ['removed', 'deleted'].includes(listing.state) ||
            listing.cleanedAt !== null
          )
            result.push({ id: listing.id, state: 'unavailable' });
          else if (
            !['active', 'reserved'].includes(listing.state) ||
            listing.expiresAt <= now()
          )
            result.push({
              id: listing.id,
              state: listing.expiresAt <= now() ? 'offline' : listing.state,
            });
          else result.push(publicListing(listing));
        }
        return result;
      });
    },
  };
}
