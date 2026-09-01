/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeEnterpriseServerTimestamp,
  parseEnterpriseServerTimestamp,
} from './enterprise-timestamp.js';

describe('enterprise server timestamp parsing', () => {
  it('treats timezone-less SQLite values as UTC', () => {
    expect(normalizeEnterpriseServerTimestamp('2026-09-01 04:32:00')).toBe(
      '2026-09-01T04:32:00Z',
    );
    expect(parseEnterpriseServerTimestamp('2026-09-01 04:32:00')).toBe(
      Date.parse('2026-09-01T04:32:00Z'),
    );
  });

  it('preserves explicit offsets', () => {
    expect(
      normalizeEnterpriseServerTimestamp('2026-09-01T12:32:00+08:00'),
    ).toBe('2026-09-01T12:32:00+08:00');
  });
});
