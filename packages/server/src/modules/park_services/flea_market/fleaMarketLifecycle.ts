/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import {
  MarketError,
  type Listing,
  type ListingState,
} from './fleaMarketTypes.js';
import { textField } from './fleaMarketValidation.js';
export const MARKET_DAY = 86_400_000;
const live = (state: ListingState) =>
  state === 'active' || state === 'reserved';
// Pure state changes only. Authorization, quotas and valid image references are checked
// by the service in the same transaction that saves this result.
export function transitionListing(
  listing: Listing,
  action: string,
  now: number,
  options: Record<string, unknown> = {},
): Listing {
  const next = structuredClone(listing);
  const requireState = (...states: ListingState[]) => {
    if (!states.includes(next.state))
      throw new MarketError('CONFLICT', 'state');
  };
  const requireContent = () => {
    if (next.cleanedAt !== null) throw new MarketError('CONFLICT', 'cleanedAt');
  };
  const renew = () => {
    next.confirmedAt = now;
    next.expiresAt = now + 30 * MARKET_DAY;
  };
  const offline = (reason: string) => {
    next.state = 'offline';
    next.offlineReason = reason;
    next.offlineAt = now;
    next.offlineVersion = listing.version + 1;
  };
  switch (action) {
    case 'reserve':
    case 'reservation': {
      requireState(action === 'reserve' ? 'active' : 'reserved');
      requireContent();
      if (now >= next.expiresAt && options.renew !== true)
        throw new MarketError('CONFLICT', 'expiresAt');
      if (options.renew === true) renew();
      const previous = next.reservation;
      const changedTime =
        action === 'reserve' || Object.hasOwn(options, 'expectedAt');
      const expectedAt = changedTime
        ? (options.expectedAt ?? null)
        : (previous?.expectedAt ?? null);
      if (
        expectedAt !== null &&
        (typeof expectedAt !== 'number' ||
          !Number.isSafeInteger(expectedAt) ||
          expectedAt <= now ||
          expectedAt > now + 30 * MARKET_DAY ||
          expectedAt >= next.expiresAt)
      )
        throw new MarketError('INVALID_INPUT', 'expectedAt');
      next.state = 'reserved';
      next.reservation = {
        expectedAt: expectedAt as number | null,
        note: textField(options.note ?? previous?.note ?? '', 'note', 0, 200),
        cycle: previous?.cycle ?? listing.version + 1,
        reminderVersion: changedTime
          ? (previous?.reminderVersion ?? 0) + 1
          : previous!.reminderVersion,
        remindAt: changedTime
          ? ((expectedAt as number | null) ?? now + 3 * MARKET_DAY)
          : previous!.remindAt,
      };
      break;
    }
    case 'cancel-reservation':
      requireState('reserved');
      if (now >= next.expiresAt) offline('expired');
      else next.state = 'active';
      break;
    case 'offline':
      requireState('active', 'reserved');
      offline('owner');
      break;
    case 'expire':
      requireState('active', 'reserved');
      if (now < next.expiresAt) throw new MarketError('CONFLICT', 'expiresAt');
      offline('expired');
      break;
    case 'identity-offline':
    case 'restriction-offline':
      requireState('active', 'reserved');
      offline(action);
      break;
    case 'restore-offline':
      requireState('offline');
      requireContent();
      if (
        next.offlineReason !== 'owner' ||
        next.offlineAt === null ||
        now - next.offlineAt >= MARKET_DAY ||
        next.offlineVersion !== next.version ||
        now >= next.expiresAt
      )
        throw new MarketError('CONFLICT');
      next.state = 'active';
      break;
    case 'sold':
      requireState('active', 'reserved', 'offline');
      next.soldFrom = next.state;
      next.soldAt = now;
      next.state = 'sold';
      break;
    case 'undo-sold':
      requireState('sold');
      requireContent();
      if (next.soldAt === null || now - next.soldAt >= MARKET_DAY)
        throw new MarketError('CONFLICT', 'soldAt');
      if (
        next.soldFrom === 'offline' ||
        now >= next.expiresAt ||
        options.asOffline === true
      )
        offline('undo-sold');
      else next.state = 'active';
      next.soldAt = null;
      break;
    case 'relist':
      requireState('offline');
      requireContent();
      if (
        next.lastRelistedAt !== null &&
        now - next.lastRelistedAt < MARKET_DAY
      )
        throw new MarketError(
          'LIMIT_REACHED',
          'lastRelistedAt',
          next.lastRelistedAt + MARKET_DAY,
        );
      next.lastRelistedAt = now;
      next.listedAt = now;
      next.state = 'active';
      renew();
      break;
    case 'confirm-active':
      requireState('active', 'reserved');
      requireContent();
      renew();
      break;
    case 'delete':
      requireState('offline', 'sold');
      next.state = 'deleted';
      break;
    default:
      throw new MarketError('INVALID_INPUT', 'action');
  }
  if (next.state !== 'reserved') next.reservation = null;
  if (live(next.state)) next.endedAt = null;
  else next.endedAt = listing.endedAt ?? now;
  next.version++;
  next.updatedAt = now;
  return next;
}
