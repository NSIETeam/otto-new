/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export function parseSalePriceCents(input: string): number {
  const match =
    typeof input === 'string' &&
    /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) throw new Error('INVALID_PRICE');
  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (cents < 1 || cents > 99999999) throw new Error('INVALID_PRICE');
  return cents;
}

import {
  categories,
  conditions,
  functionStatuses,
  MarketError,
  type ListingFields,
} from './fleaMarketTypes.js';
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export function visibleLength(value: string): number {
  return [...segmenter.segment(value)].length;
}
export function textField(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== 'string') throw new MarketError('INVALID_INPUT', field);
  const text = value.trim();
  if (
    visibleLength(text) < min ||
    visibleLength(text) > max ||
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    })
  )
    throw new MarketError('INVALID_INPUT', field);
  return text;
}
function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !choices.includes(value as T))
    throw new MarketError('INVALID_INPUT', field);
  return value as T;
}
export function validateListing(input: unknown): ListingFields {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new MarketError('INVALID_INPUT');
  const raw = input as Record<string, unknown>;
  const imageIds = raw.imageIds;
  if (
    !Array.isArray(imageIds) ||
    imageIds.length < 1 ||
    imageIds.length > 9 ||
    imageIds.some(
      (id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id),
    ) ||
    new Set(imageIds).size !== imageIds.length
  )
    throw new MarketError('INVALID_INPUT', 'imageIds');
  const saleMode = choice(raw.saleMode ?? 'sale', ['sale', 'free'], 'saleMode');
  let priceCents = 0;
  if (saleMode === 'sale') {
    try {
      priceCents = parseSalePriceCents(raw.price as string);
    } catch {
      throw new MarketError('INVALID_INPUT', 'price');
    }
  }
  const functionStatus = choice(
    raw.functionStatus,
    functionStatuses,
    'functionStatus',
  );
  if (raw.negotiable != null && typeof raw.negotiable !== 'boolean')
    throw new MarketError('INVALID_INPUT', 'negotiable');
  return {
    title: textField(raw.title, 'title', 2, 40),
    category: choice(raw.category, categories, 'category'),
    saleMode,
    priceCents,
    negotiable: saleMode === 'sale' && raw.negotiable === true,
    condition: choice(raw.condition, conditions, 'condition'),
    functionStatus,
    faultDescription:
      functionStatus === 'faulty'
        ? textField(raw.faultDescription, 'faultDescription', 2, 500)
        : '',
    description: textField(raw.description, 'description', 5, 2000),
    handoverArea: textField(raw.handoverArea, 'handoverArea', 2, 50),
    handoverTime: textField(raw.handoverTime ?? '', 'handoverTime', 0, 100),
    imageIds: [...imageIds] as string[],
  };
}
