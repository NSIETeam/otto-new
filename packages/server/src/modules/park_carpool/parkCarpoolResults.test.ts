/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { createCarpoolResultPage } from './parkCarpoolResults.js';
import type { ParkCarpoolMatch } from './parkCarpoolDomain.js';
const match = (n: number, overlap = n): ParkCarpoolMatch => ({
  intentId: `candidate-${n}`,
  candidateVersion: 1,
  displayName: '同事',
  organizationName: '企业',
  verifiedParkMember: true,
  departureTime: '2026-09-08T10:30:00Z',
  timeDifferenceMinutes: 0,
  overlapPercent: overlap,
  commonDistanceMeters: 1000,
  compatibleModes:
    n % 2 ? ['shared_taxi'] : ['current_rides_candidate_vehicle'],
  originArea: '区域',
  destinationArea: '区域',
  freshness: 'recent',
  explanation: '几何近似',
});
it('globally ranks before bounded paging and filters before taking results', () => {
  const first = createCarpoolResultPage({ filter: 'shared_taxi' });
  for (let i = 0; i < 301; i++) first.add(match(i, i / 4));
  const page = first.finish();
  expect(page.total).toBe(150);
  expect(page.results).toHaveLength(50);
  expect(page.results[0]?.intentId).toBe('candidate-299');
  expect(page.nextCursor).toBeTruthy();
  const next = createCarpoolResultPage({
    filter: 'shared_taxi',
    cursor: page.nextCursor,
  });
  for (let i = 0; i < 301; i++) next.add(match(i, i / 4));
  const second = next.finish();
  expect(second.results).toHaveLength(50);
  expect(
    second.results.some((item) =>
      page.results.some((old) => old.intentId === item.intentId),
    ),
  ).toBe(false);
  const changed = createCarpoolResultPage({
    filter: 'shared_taxi',
    cursor: page.nextCursor,
  });
  for (let i = 0; i < 299; i++) changed.add(match(i, i / 4));
  expect(() => changed.finish()).toThrow(/更新/);
});
