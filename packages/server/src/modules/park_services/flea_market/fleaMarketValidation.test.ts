/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { parseSalePriceCents } from './fleaMarketValidation.js';
describe('sale prices', () => {
  it.each([
    ['0.01', 1],
    ['12.3', 1230],
    ['999999.99', 99999999],
  ])('%s converts exactly', (text, cents) =>
    expect(parseSalePriceCents(String(text))).toBe(cents),
  );
  it.each(['0', '-1', '1e3', '1.001', '1000000', '面议', '', '+1', 'NaN'])(
    'rejects %s',
    (text) => expect(() => parseSalePriceCents(text)).toThrow('INVALID_PRICE'),
  );
});

import { validateListing } from './fleaMarketValidation.js';
const valid = {
  title: '办公椅',
  category: 'office',
  saleMode: 'sale',
  price: '10.01',
  condition: 'used',
  functionStatus: 'working',
  description: '椅子可以正常升降',
  handoverArea: '园区南门',
  imageIds: ['image-1'],
};
describe('listing fields', () => {
  it('normalizes free price and negotiability', () =>
    expect(
      validateListing({
        ...valid,
        saleMode: 'free',
        price: '999',
        negotiable: true,
      }),
    ).toMatchObject({ priceCents: 0, negotiable: false }));
  it('counts graphemes, trims title and preserves description newlines', () =>
    expect(
      validateListing({
        ...valid,
        title: ' 👨‍👩‍👧‍👦椅 ',
        description: '第一行\n第二行',
      }),
    ).toMatchObject({ title: '👨‍👩‍👧‍👦椅', description: '第一行\n第二行' }));
  it.each(['category', 'condition', 'functionStatus'])(
    'requires explicit %s',
    (field) =>
      expect(() => validateListing({ ...valid, [field]: undefined })).toThrow(
        'INVALID_INPUT',
      ),
  );
  it('rejects a single visible character', () =>
    expect(() => validateListing({ ...valid, title: '👨‍👩‍👧‍👦' })).toThrow(
      'INVALID_INPUT',
    ));
  it.each(['', '坏', '坏'.repeat(501)])(
    'requires 2–500 fault characters',
    (faultDescription) =>
      expect(() =>
        validateListing({
          ...valid,
          functionStatus: 'faulty',
          faultDescription,
        }),
      ).toThrow('INVALID_INPUT'),
  );
  it.each([
    [],
    Array.from({ length: 10 }, (_, i) => `image-${i}`),
    ['image-1', 'image-1'],
  ])('rejects invalid images %j', (imageIds) =>
    expect(() => validateListing({ ...valid, imageIds })).toThrow(
      'INVALID_INPUT',
    ),
  );
  it('does not accept identity or private fields from public form', () => {
    const result = validateListing({
      ...valid,
      ownerId: 'other',
      parkId: 'q',
      reservationNote: 'secret',
    });
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('reservationNote');
  });
});
