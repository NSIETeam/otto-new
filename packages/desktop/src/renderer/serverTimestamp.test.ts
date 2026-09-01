/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeServerTimestamp,
  parseServerTimestamp,
} from './serverTimestamp.js';

describe('server timestamp parsing', () => {
  it.each([
    ['2026-09-01 04:32:00', '2026-09-01T04:32:00.000Z'],
    ['2026-09-01T04:32:00', '2026-09-01T04:32:00.000Z'],
    ['2026-09-01 04:32:00.125', '2026-09-01T04:32:00.125Z'],
    ['2026-09-01T12:32:00+08:00', '2026-09-01T04:32:00.000Z'],
    ['2026-09-01T04:32:00Z', '2026-09-01T04:32:00.000Z'],
  ])('parses %s as the same UTC instant', (input, expected) => {
    expect(parseServerTimestamp(input).toISOString()).toBe(expected);
  });

  it('normalizes only timezone-less database timestamps as UTC', () => {
    expect(normalizeServerTimestamp('2026-09-01 04:32:00')).toBe(
      '2026-09-01T04:32:00Z',
    );
    expect(normalizeServerTimestamp('2026-09-01T12:32:00+08:00')).toBe(
      '2026-09-01T12:32:00+08:00',
    );
  });
});
