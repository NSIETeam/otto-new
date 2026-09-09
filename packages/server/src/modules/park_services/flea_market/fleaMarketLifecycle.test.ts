/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import type { Listing } from './fleaMarketTypes.js';
import { transitionListing } from './fleaMarketLifecycle.js';
const day = 86400000;
const item = (): Listing => ({
  id: 'a',
  ownerId: 'seller',
  parkId: 'P',
  version: 1,
  state: 'active',
  title: '椅子',
  category: 'office',
  saleMode: 'sale',
  priceCents: 100,
  negotiable: false,
  condition: 'used',
  functionStatus: 'working',
  faultDescription: '',
  description: '可以升降的椅子',
  handoverArea: '园区门口',
  handoverTime: '',
  imageIds: ['i'],
  createdAt: 0,
  listedAt: 0,
  confirmedAt: 0,
  expiresAt: 30 * day,
  updatedAt: 0,
  reservation: null,
  offlineAt: null,
  offlineReason: null,
  offlineVersion: null,
  soldAt: null,
  soldFrom: null,
  lastRelistedAt: null,
  endedAt: null,
  cleanedAt: null,
});
it('restores accidental offline without refreshing ranking or expiry', () => {
  const offline = transitionListing(item(), 'offline', day);
  const restored = transitionListing(offline, 'restore-offline', day + 1);
  expect(restored).toMatchObject({
    state: 'active',
    listedAt: 0,
    expiresAt: 30 * day,
    version: 3,
  });
});
it('does not restore non-voluntary, expired, changed or late offline', () => {
  const offline = transitionListing(item(), 'offline', day);
  for (const record of [
    { ...offline, offlineReason: 'expired' },
    { ...offline, version: offline.version + 1 },
    { ...offline, expiresAt: day },
  ])
    expect(() => transitionListing(record, 'restore-offline', day + 1)).toThrow(
      'CONFLICT',
    );
  expect(() => transitionListing(offline, 'restore-offline', 2 * day)).toThrow(
    'CONFLICT',
  );
});
it('undo sold after expiry becomes offline, never restores reservation', () => {
  const reserved = {
    ...item(),
    state: 'reserved' as const,
    reservation: {
      expectedAt: null,
      note: 'private',
      cycle: 1,
      reminderVersion: 1,
      remindAt: day,
    },
  };
  const sold = transitionListing(reserved, 'sold', 30 * day - 100);
  expect(transitionListing(sold, 'undo-sold', 30 * day + 1)).toMatchObject({
    state: 'offline',
    reservation: null,
    listedAt: 0,
    expiresAt: 30 * day,
  });
});
it('permits selling offline and keeps ended retention time', () => {
  const offline = transitionListing(item(), 'offline', day);
  const sold = transitionListing(offline, 'sold', 2 * day);
  expect(sold).toMatchObject({ state: 'sold', endedAt: day });
  expect(transitionListing(sold, 'undo-sold', 2 * day + 1).state).toBe(
    'offline',
  );
});
it('enforces rolling relist cooldown across midnight', () => {
  const offline = {
    ...item(),
    state: 'offline' as const,
    lastRelistedAt: day - 60000,
  };
  expect(() => transitionListing(offline, 'relist', day + 60000)).toThrow(
    'LIMIT_REACHED',
  );
});
it('requires explicit renewal for a reservation crossing expiry', () => {
  const listing = { ...item(), expiresAt: 2 * day };
  expect(() =>
    transitionListing(listing, 'reserve', day, { expectedAt: 3 * day }),
  ).toThrow('INVALID_INPUT');
  expect(
    transitionListing(listing, 'reserve', day, {
      expectedAt: 3 * day,
      renew: true,
    }),
  ).toMatchObject({ state: 'reserved', expiresAt: 31 * day, listedAt: 0 });
});
it('reservation note edit keeps reminder; time changes invalidate it; expiry cancellation goes offline', () => {
  const reserved = transitionListing(item(), 'reserve', day, {
    note: '买家周五来',
  });
  expect(reserved.reservation?.note).toBe('买家周五来');
  const changed = transitionListing(reserved, 'reservation', 2 * day, {
    note: '改为周六',
  });
  expect(changed.reservation?.reminderVersion).toBe(
    reserved.reservation?.reminderVersion,
  );
  const cleared = transitionListing(changed, 'reservation', 3 * day, {
    expectedAt: null,
  });
  expect(cleared.reservation?.remindAt).toBe(6 * day);
  expect(cleared.reservation?.reminderVersion).toBe(2);
  expect(
    transitionListing(cleared, 'cancel-reservation', 30 * day),
  ).toMatchObject({ state: 'offline', reservation: null });
});
it('never lets sellers restore removed or deleted listings', () => {
  for (const state of ['removed', 'deleted'] as const)
    for (const action of ['relist', 'restore-offline', 'undo-sold', 'reserve'])
      expect(() =>
        transitionListing({ ...item(), state }, action, day),
      ).toThrow('CONFLICT');
});
