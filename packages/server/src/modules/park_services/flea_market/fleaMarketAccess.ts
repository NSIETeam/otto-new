/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import {
  MarketError,
  type MarketPrincipal,
  type MarketConfig,
  type Listing,
  type PublicListing,
} from './fleaMarketTypes.js';
export function samePark(
  actor: MarketPrincipal | null,
  parkId: string,
): boolean {
  return (
    !!actor?.active &&
    actor.parkActive &&
    actor.enterpriseEnabled &&
    actor.parkId === parkId
  );
}
export function canDiscover(
  actor: MarketPrincipal | null,
  config: MarketConfig,
  parkId: string,
): boolean {
  return (
    samePark(actor, parkId) &&
    config.enabled &&
    config.ready &&
    !!config.rules &&
    !!config.responsibleAccountId &&
    !!config.contact
  );
}
export function canManageOwn(
  actor: MarketPrincipal | null,
  listing: Pick<Listing, 'ownerId'>,
): boolean {
  return !!actor?.active && actor.accountId === listing.ownerId;
}
export function canModerate(
  actor: MarketPrincipal | null,
  parkId: string,
): boolean {
  return (
    samePark(actor, parkId) && !!actor?.marketAdminParkIds.includes(parkId)
  );
}
export function canReadHistory(
  actor: MarketPrincipal | null,
  listing: Listing,
  hasGrant: boolean,
): boolean {
  return (
    samePark(actor, listing.parkId) &&
    hasGrant &&
    !['removed', 'deleted'].includes(listing.state) &&
    listing.cleanedAt === null
  );
}
export function requireActive(
  actor: MarketPrincipal | null,
): asserts actor is MarketPrincipal {
  if (!actor?.active) throw new MarketError('UNAUTHENTICATED');
}
export function publicListing(
  listing: Listing,
  owner?: MarketPrincipal | null,
): PublicListing {
  return {
    ...(owner ? { seller: { nickname: owner.nickname || '园区成员' } } : {}),
    id: listing.id,
    version: listing.version,
    state: listing.state,
    title: listing.title,
    category: listing.category,
    saleMode: listing.saleMode,
    priceCents: listing.priceCents,
    negotiable: listing.negotiable,
    condition: listing.condition,
    functionStatus: listing.functionStatus,
    faultDescription: listing.faultDescription,
    description: listing.description,
    handoverArea: listing.handoverArea,
    handoverTime: listing.handoverTime,
    imageIds: [...listing.imageIds],
    listedAt: listing.listedAt,
    confirmedAt: listing.confirmedAt,
    expiresAt: listing.expiresAt,
  };
}
