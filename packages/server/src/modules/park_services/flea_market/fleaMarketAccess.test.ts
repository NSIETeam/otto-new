/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  canDiscover,
  canManageOwn,
  canModerate,
  canReadHistory,
} from './fleaMarketAccess.js';
import type { Listing, MarketPrincipal } from './fleaMarketTypes.js';
const actor: MarketPrincipal = {
  accountId: 'buyer',
  organizationId: 'E2',
  active: true,
  parkId: 'P',
  parkActive: true,
  enterpriseEnabled: true,
  marketAdminParkIds: [],
};
const config = {
  enabled: true,
  ready: true,
  timezone: 'Asia/Shanghai',
  rules: '个人闲置',
  responsibleAccountId: 'admin',
  contact: '运营',
};
const listing = {
  ownerId: 'seller',
  parkId: 'P',
  state: 'offline',
  cleanedAt: null,
} as Listing;
it('allows cross-enterprise same-park discovery only', () => {
  expect(canDiscover(actor, config, 'P')).toBe(true);
  expect(canDiscover(actor, config, 'Q')).toBe(false);
  expect(canDiscover({ ...actor, active: false }, config, 'P')).toBe(false);
  expect(canDiscover(actor, { ...config, ready: false }, 'P')).toBe(false);
});
it('preserves own management during closure or exit but denies disabled accounts and other owners', () => {
  expect(canManageOwn({ ...actor, parkId: null }, { ownerId: 'buyer' })).toBe(
    true,
  );
  expect(canManageOwn({ ...actor, active: false }, { ownerId: 'buyer' })).toBe(
    false,
  );
  expect(canManageOwn(actor, { ownerId: 'seller' })).toBe(false);
});
it('requires explicit market role in the current park', () => {
  expect(canModerate(actor, 'P')).toBe(false);
  expect(canModerate({ ...actor, marketAdminParkIds: ['P'] }, 'P')).toBe(true);
  expect(canModerate({ ...actor, marketAdminParkIds: ['Q'] }, 'Q')).toBe(false);
});
it('requires per-listing grant and revokes history detail on membership loss, removal or cleanup', () => {
  expect(canReadHistory(actor, listing, true)).toBe(true);
  expect(canReadHistory(actor, listing, false)).toBe(false);
  expect(canReadHistory({ ...actor, parkId: 'Q' }, listing, true)).toBe(false);
  expect(canReadHistory(actor, { ...listing, state: 'removed' }, true)).toBe(
    false,
  );
  expect(canReadHistory(actor, { ...listing, cleanedAt: 1 }, true)).toBe(false);
});

it('allows an unconfigured module without weakening membership or explicit pause checks', () => {
  const defaults = { ...config, rules: '', responsibleAccountId: '', contact: '' };
  expect(canDiscover(actor, defaults, 'P')).toBe(true);
  expect(canDiscover(actor, { ...defaults, enabled: false }, 'P')).toBe(false);
  expect(canDiscover({ ...actor, enterpriseEnabled: false }, defaults, 'P')).toBe(false);
  expect(canDiscover({ ...actor, parkActive: false }, defaults, 'P')).toBe(false);
});
