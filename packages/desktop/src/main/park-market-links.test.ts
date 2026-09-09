/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { MarketLinkIntents, marketLink } from './park-market-links.js';
it('shares only server and opaque listing ID, rejecting credentials, unrelated schemes and duplicate parameters', () => {
  const intents = new MarketLinkIntents();
  const link = marketLink('https://park.example/base/', 'listing-1');
  expect(intents.accept(link)).toBe(true);
  expect(intents.take('https://other.example')).toEqual({
    error: '请登录分享链接所属的企业服务器后重试',
  });
  expect(intents.take('https://park.example/base')).toEqual({
    listingId: 'listing-1',
  });
  expect(intents.take('https://park.example/base')).toBeNull();
  expect(intents.accept(link + '&server=https://evil.example')).toBe(false);
  expect(
    intents.accept(
      'otto://market/listing-1?server=https://user:password@park.example',
    ),
  ).toBe(false);
  expect(intents.accept('file:///private/data')).toBe(false);
  expect(() =>
    marketLink('https://park.example?token=secret', 'listing-1'),
  ).toThrow();
});
