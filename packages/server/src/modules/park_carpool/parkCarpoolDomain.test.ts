/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildCarpoolMatches,
  normalizeCarpoolIntentInput,
  routeOverlap,
  type ParkCarpoolIntent,
} from './parkCarpoolDomain.js';

const BASE_ROUTE = [
  { longitude: 116.2310, latitude: 40.2200 },
  { longitude: 116.2500, latitude: 40.2100 },
  { longitude: 116.2800, latitude: 40.1900 },
  { longitude: 116.3100, latitude: 40.1700 },
];

function intent(
  id: string,
  input: Partial<ParkCarpoolIntent> = {},
): ParkCarpoolIntent {
  return {
    id,
    accountId: `account-${id}`,
    organizationId: `org-${id}`,
    organizationName: `企业-${id}`,
    displayName: `用户-${id}`,
    parkId: 'park-a',
    travelDate: '2026-09-02',
    origin: { label: '北控宏创科技园南门', coordinate: BASE_ROUTE[0]! },
    destination: { label: '回龙观东大街某小区 12 号楼', coordinate: BASE_ROUTE.at(-1)! },
    departureTime: '2026-09-02T18:30:00.000+08:00',
    flexibleMinutes: 30,
    travelOptions: ['rider', 'shared_taxi'],
    route: {
      provider: 'amap',
      distanceMeters: 12_000,
      durationSeconds: 1_800,
      polyline: BASE_ROUTE,
    },
    status: 'active',
    lastConfirmedAt: '2026-09-02T09:00:00.000Z',
    expiresAt: '2026-09-02T11:30:00.000Z',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    ...input,
  };
}

describe('normalizeCarpoolIntentInput', () => {
  it('normalizes travel choices while retaining only a resolved route', () => {
    expect(normalizeCarpoolIntentInput({
      travelDate: '2026-09-02',
      origin: { label: ' 园区南门 ', coordinate: BASE_ROUTE[0]! },
      destination: { label: ' 回龙观地铁站 ', coordinate: BASE_ROUTE.at(-1)! },
      departureTime: '2026-09-02T18:30:00+08:00',
      flexibleMinutes: 30,
      travelOptions: ['rider', 'rider', 'shared_taxi'],
    })).toMatchObject({
      origin: { label: '园区南门' },
      destination: { label: '回龙观地铁站' },
      flexibleMinutes: 30,
      travelOptions: ['rider', 'shared_taxi'],
    });
  });

  it('rejects unknown choices, an invalid date, and the same origin/destination', () => {
    const base = {
      travelDate: '2026-09-02',
      origin: { label: '园区南门', coordinate: BASE_ROUTE[0]! },
      destination: { label: '园区南门', coordinate: BASE_ROUTE[0]! },
      departureTime: '2026-09-02T18:30:00+08:00',
      flexibleMinutes: 30,
      travelOptions: ['rider'],
    };
    expect(() => normalizeCarpoolIntentInput(base)).toThrow(/不能相同/u);
    expect(() => normalizeCarpoolIntentInput({
      ...base,
      destination: { label: '回龙观', coordinate: BASE_ROUTE.at(-1)! },
      travelOptions: ['plane'],
    })).toThrow(/出行选择/u);
    expect(() => normalizeCarpoolIntentInput({
      ...base,
      travelDate: '09-02-2026',
      destination: { label: '回龙观', coordinate: BASE_ROUTE.at(-1)! },
    })).toThrow(/日期/u);
  });
});

describe('routeOverlap', () => {
  it('recognizes nearby same-direction routes and rejects the reverse direction', () => {
    const nearby = BASE_ROUTE.map((point) => ({
      longitude: point.longitude + 0.00035,
      latitude: point.latitude + 0.0002,
    }));
    expect(routeOverlap(BASE_ROUTE, nearby).overlap).toBeGreaterThan(0.8);
    expect(routeOverlap(BASE_ROUTE, [...BASE_ROUTE].reverse()).overlap).toBeLessThan(0.1);
  });
});

describe('buildCarpoolMatches', () => {
  it('filters by park, date, time, compatible mode and route, then sorts by overlap', () => {
    const current = intent('self');
    const closeDriver = intent('close', {
      departureTime: '2026-09-02T18:40:00.000+08:00',
      travelOptions: ['driver'],
      route: {
        provider: 'amap', distanceMeters: 12_100, durationSeconds: 1_820,
        polyline: BASE_ROUTE.map((point) => ({
          longitude: point.longitude + 0.00025,
          latitude: point.latitude + 0.00015,
        })),
      },
    });
    const sharedTaxi = intent('taxi', {
      departureTime: '2026-09-02T18:20:00.000+08:00',
      travelOptions: ['shared_taxi'],
      route: {
        provider: 'amap', distanceMeters: 11_900, durationSeconds: 1_780,
        polyline: BASE_ROUTE.map((point, index) => index < 3 ? point : ({
          longitude: point.longitude + 0.02,
          latitude: point.latitude - 0.02,
        })),
      },
    });
    const incompatible = intent('incompatible', { travelOptions: ['rider'] });
    const otherPark = intent('other-park', {
      parkId: 'park-b', travelOptions: ['driver'],
    });
    const expired = intent('expired', {
      travelOptions: ['driver'], status: 'expired',
    });
    const invalidExpiry = intent('invalid-expiry', {
      travelOptions: ['driver'], expiresAt: 'invalid',
    });

    const matches = buildCarpoolMatches(current, [
      sharedTaxi, incompatible, otherPark, expired, invalidExpiry, closeDriver,
    ], { minimumOverlap: 0.35, now: new Date('2026-09-02T09:10:00.000Z') });

    expect(new Set(matches.map((item) => item.intentId))).toEqual(new Set(['close', 'taxi']));
    expect(matches[0]!.overlapPercent).toBeGreaterThanOrEqual(matches[1]!.overlapPercent);
    const close = matches.find((item) => item.intentId === 'close')!;
    expect(close).toMatchObject({
      displayName: '用***',
      organizationName: '企业-close',
      compatibleModes: ['current_rides_candidate_vehicle'],
      timeDifferenceMinutes: 10,
      verifiedParkMember: true,
    });
    expect(close.overlapPercent).toBeGreaterThan(80);
    expect(close).not.toHaveProperty('origin.coordinate');
    expect(close).not.toHaveProperty('destination.coordinate');
    expect(close.destinationArea).not.toContain('12 号楼');
    expect(JSON.stringify(close)).not.toContain('用户-close');
  });
});
