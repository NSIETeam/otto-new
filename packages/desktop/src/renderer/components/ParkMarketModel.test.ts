import { it, expect } from 'vitest';
import {
  emptyMarketForm,
  selectMarketImages,
  moveMarketImage,
  marketFormErrors,
  switchMarketSaleMode,
} from './ParkMarketModel.js';
it('requires explicit condition and function, preserves sale price and validates visible characters', () => {
  const form = {
    ...emptyMarketForm(),
    title: '办公椅',
    category: 'office',
    price: '10.20',
    description: '可升降办公椅',
    handoverArea: '园区南门',
    imageIds: ['image'],
  };
  expect(marketFormErrors(form)).toMatchObject({
    condition: '请选择成色',
    functionStatus: '请选择功能状态',
  });
  expect(
    switchMarketSaleMode(switchMarketSaleMode(form, 'free'), 'sale').price,
  ).toBe('10.20');
  expect(
    switchMarketSaleMode({ ...form, negotiable: true }, 'free'),
  ).toMatchObject({ price: '0', negotiable: false });
  expect(
    marketFormErrors({ ...form, condition: 'used', functionStatus: 'working' }),
  ).toEqual({});
  expect(
    marketFormErrors({ ...form, condition: 'used', functionStatus: 'faulty' })
      .faultDescription,
  ).toBeTruthy();
  expect(
    marketFormErrors({
      ...form,
      title: '👨‍👩‍👧‍👦',
      condition: 'used',
      functionStatus: 'working',
    }).title,
  ).toBeTruthy();
});

it('accepts remaining image slots in selection order and names only overflow files', () => {
  const files = Array.from({ length: 10 }, (_, i) => `image-${i}`);
  expect(selectMarketImages(files, 2)).toEqual({
    accepted: files.slice(0, 7),
    rejected: files.slice(7),
  });
  expect(selectMarketImages(files, 9)).toEqual({
    accepted: [],
    rejected: files,
  });
});
it('reorders a selected photo without losing or duplicating the other image references', () => {
  expect(moveMarketImage(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  expect(moveMarketImage(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  expect(moveMarketImage(['a', 'b'], 'unknown', 'a')).toEqual(['a', 'b']);
});
