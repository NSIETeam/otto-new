/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { buildCarpoolRoutePreview } from './parkCarpoolRoutePreview.js';
it('shows common/noncommon geometry without coordinates or private endpoints', () => {
  const a = [
    { longitude: 116, latitude: 40 },
    { longitude: 116.1, latitude: 40 },
  ];
  const b = [
    { longitude: 116, latitude: 40.02 },
    { longitude: 116.03, latitude: 40 },
    { longitude: 116.1, latitude: 40 },
  ];
  const preview = buildCarpoolRoutePreview(a, [b]);
  expect(preview.segments.some((s) => s.shared)).toBe(true);
  expect(preview.segments.some((s) => !s.shared)).toBe(true);
  expect(JSON.stringify(preview)).not.toContain('longitude');
  expect(preview.hiddenEndpointRadiusMeters).toBe(1000);
});
it('does not expose tiny routes when the entire route is inside endpoint privacy zones', () => {
  expect(
    buildCarpoolRoutePreview(
      [
        { longitude: 116, latitude: 40 },
        { longitude: 116.001, latitude: 40 },
      ],
      [
        [
          { longitude: 116, latitude: 40 },
          { longitude: 116.001, latitude: 40 },
        ],
      ],
    ).segments,
  ).toHaveLength(0);
});

it('distinguishes all-member, partial-member and solo geometry after privacy trimming', () => {
  const point = (longitude: number, latitude = 40) => ({ longitude, latitude });
  const current = [point(116), point(116.3)];
  const preview = buildCarpoolRoutePreview(current, [
    current,
    [point(116, 40.03), point(116.1), point(116.2), point(116.3, 40.03)],
  ]);
  const own = preview.segments.filter((segment) => segment.route === 0);
  expect(own.some((segment) => segment.coverage === 'all')).toBe(true);
  expect(own.some((segment) => segment.coverage === 'partial')).toBe(true);
  expect(
    buildCarpoolRoutePreview(current, [
      [point(116, 40.03), point(116.3, 40.03)],
    ]).segments.some(
      (segment) => segment.route === 0 && segment.coverage === 'solo',
    ),
  ).toBe(true);
});
