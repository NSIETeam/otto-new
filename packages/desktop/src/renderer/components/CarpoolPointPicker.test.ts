/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { mapPixelCoordinate } from './CarpoolPointPicker.js';
it('maps static-map pixels consistently at the center, east and north', () => {
  const center = { longitude: 116, latitude: 40 };
  expect(mapPixelCoordinate(center, 15, 0, 0).longitude).toBeCloseTo(116, 8);
  expect(mapPixelCoordinate(center, 15, 0, 0).latitude).toBeCloseTo(40, 8);
  expect(mapPixelCoordinate(center, 15, 100, 0).longitude).toBeGreaterThan(116);
  expect(mapPixelCoordinate(center, 15, 0, -100).latitude).toBeGreaterThan(40);
});
