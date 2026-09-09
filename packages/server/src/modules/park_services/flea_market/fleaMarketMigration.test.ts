/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from '../../../enterprise/postgresMigrations.js';
it('keeps concurrent carpool and market migration versions unique and sequential', () => {
  expect(ENTERPRISE_POSTGRES_MIGRATIONS.map((m) => m.version)).toEqual(
    ENTERPRISE_POSTGRES_MIGRATIONS.map((_, i) => i + 1),
  );
  expect(
    ENTERPRISE_POSTGRES_MIGRATIONS.filter(
      (m) => m.name === 'park-flea-market-v1',
    ),
  ).toHaveLength(1);
});
