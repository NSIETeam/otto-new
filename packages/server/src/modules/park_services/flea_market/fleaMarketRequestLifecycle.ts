/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { ListingState, RequestState } from './fleaMarketTypes.js';
export function requestDisposition(input: {
  state: RequestState;
  expiresAt: number;
  now: number;
  marketEnabled: boolean;
  participantsAllowed: boolean;
  listingState: ListingState;
}): RequestState | 'paused' | 'actionable' {
  if (input.state !== 'pending') return input.state;
  if (!input.participantsAllowed) return 'ended';
  if (input.now >= input.expiresAt) return 'expired';
  if (!['active', 'reserved'].includes(input.listingState)) return 'ended';
  return input.marketEnabled ? 'actionable' : 'paused';
}
