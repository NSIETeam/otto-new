/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { requestDisposition } from './fleaMarketRequestLifecycle.js';
const pending = {
  state: 'pending' as const,
  expiresAt: 2000,
  now: 1000,
  marketEnabled: true,
  participantsAllowed: true,
  listingState: 'active' as const,
};
it.each(['active', 'reserved'] as const)(
  'allows pending processing for %s',
  (listingState) =>
    expect(requestDisposition({ ...pending, listingState })).toBe('actionable'),
);
it.each(['offline', 'sold', 'removed', 'deleted'] as const)(
  'ends requests for %s even during pause',
  (listingState) =>
    expect(
      requestDisposition({ ...pending, listingState, marketEnabled: false }),
    ).toBe('ended'),
);
it('pause does not extend expiry and qualification loss ends immediately', () => {
  expect(requestDisposition({ ...pending, marketEnabled: false })).toBe(
    'paused',
  );
  expect(
    requestDisposition({ ...pending, marketEnabled: false, now: 2000 }),
  ).toBe('expired');
  expect(requestDisposition({ ...pending, participantsAllowed: false })).toBe(
    'ended',
  );
});
it.each(['withdrawn', 'expired', 'ended', 'accepted'] as const)(
  'never revives %s on restoration',
  (state) => expect(requestDisposition({ ...pending, state })).toBe(state),
);
