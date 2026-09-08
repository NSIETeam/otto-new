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
  { longitude: 116.231, latitude: 40.22 },
  { longitude: 116.25, latitude: 40.21 },
  { longitude: 116.28, latitude: 40.19 },
  { longitude: 116.31, latitude: 40.17 },
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
    destination: {
      label: '回龙观东大街某小区 12 号楼',
      coordinate: BASE_ROUTE.at(-1)!,
    },
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
    expect(
      normalizeCarpoolIntentInput({
        travelDate: '2026-09-02',
        origin: { label: ' 园区南门 ', coordinate: BASE_ROUTE[0]! },
        destination: {
          label: ' 回龙观地铁站 ',
          coordinate: BASE_ROUTE.at(-1)!,
        },
        departureTime: '2026-09-02T18:30:00+08:00',
        flexibleMinutes: 30,
        travelOptions: ['rider', 'rider', 'shared_taxi'],
      }),
    ).toMatchObject({
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
    expect(() =>
      normalizeCarpoolIntentInput({
        ...base,
        destination: { label: '回龙观', coordinate: BASE_ROUTE.at(-1)! },
        travelOptions: ['plane'],
      }),
    ).toThrow(/出行选择/u);
    expect(() =>
      normalizeCarpoolIntentInput({
        ...base,
        travelDate: '09-02-2026',
        destination: { label: '回龙观', coordinate: BASE_ROUTE.at(-1)! },
      }),
    ).toThrow(/日期/u);
  });
});

describe('routeOverlap', () => {
  it('recognizes nearby same-direction routes and rejects the reverse direction', () => {
    const nearby = BASE_ROUTE.map((point) => ({
      longitude: point.longitude + 0.00035,
      latitude: point.latitude + 0.0002,
    }));
    expect(routeOverlap(BASE_ROUTE, nearby).overlap).toBeGreaterThan(0.8);
    expect(
      routeOverlap(BASE_ROUTE, [...BASE_ROUTE].reverse()).overlap,
    ).toBeLessThan(0.1);
  });
});

describe('buildCarpoolMatches', () => {
  it('filters by park, date, time, compatible mode and route, then sorts by overlap', () => {
    const current = intent('self');
    const closeDriver = intent('close', {
      departureTime: '2026-09-02T18:40:00.000+08:00',
      travelOptions: ['driver'],
      route: {
        provider: 'amap',
        distanceMeters: 12_100,
        durationSeconds: 1_820,
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
        provider: 'amap',
        distanceMeters: 11_900,
        durationSeconds: 1_780,
        polyline: BASE_ROUTE.map((point, index) =>
          index < 3
            ? point
            : {
                longitude: point.longitude + 0.02,
                latitude: point.latitude - 0.02,
              },
        ),
      },
    });
    const incompatible = intent('incompatible', { travelOptions: ['rider'] });
    const otherPark = intent('other-park', {
      parkId: 'park-b',
      travelOptions: ['driver'],
    });
    const expired = intent('expired', {
      travelOptions: ['driver'],
      status: 'expired',
    });
    const invalidExpiry = intent('invalid-expiry', {
      travelOptions: ['driver'],
      expiresAt: 'invalid',
    });

    const matches = buildCarpoolMatches(
      current,
      [
        sharedTaxi,
        incompatible,
        otherPark,
        expired,
        invalidExpiry,
        closeDriver,
      ],
      { minimumOverlap: 0.35, now: new Date('2026-09-02T09:10:00.000Z') },
    );

    expect(new Set(matches.map((item) => item.intentId))).toEqual(
      new Set(['close', 'taxi']),
    );
    expect(matches[0]!.overlapPercent).toBeGreaterThanOrEqual(
      matches[1]!.overlapPercent,
    );
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

describe('PRD route and input regressions', () => {
  const point = (longitude: number, latitude = 40) => ({ longitude, latitude });
  it('counts only the actual short common interval, symmetrically', () => {
    const long = [point(116), point(116.1)];
    const short = [point(116.049), point(116.051)];
    const result = routeOverlap(long, short);
    expect(result.overlap).toBeCloseTo((2 * 0.002) / 0.102, 3);
    expect(result.commonDistanceMeters).toBeLessThanOrEqual(171);
    expect(routeOverlap(short, long)).toEqual(result);
  });
  it('does not turn parallel roads or a crossing into shared travel', () => {
    expect(
      routeOverlap(
        [point(116), point(116.1)],
        [point(116, 40.001), point(116.1, 40.001)],
      ).overlap,
    ).toBe(0);
    expect(
      routeOverlap(
        [point(116), point(116.1)],
        [point(116.05, 39.99), point(116.05, 40.01)],
      ).overlap,
    ).toBe(0);
  });
  it('is independent of sample density and duplicate vertices', () => {
    const dense = Array.from({ length: 101 }, (_, i) => point(116 + i / 1000));
    expect(routeOverlap([point(116), point(116.1)], dense).overlap).toBeCloseTo(
      1,
      3,
    );
    expect(
      routeOverlap(
        dense,
        dense.flatMap((p) => [p, p]),
      ).overlap,
    ).toBeCloseTo(1, 3);
  });
  it.each([
    '测试小区十二号楼三单元二〇一室',
    '测试小区12栋A座201室',
    'Apartment 201, 12 Example Road',
  ])('never derives public areas from a private label: %s', (label) => {
    const matches = buildCarpoolMatches(
      intent('self'),
      [
        intent('other', {
          travelOptions: ['driver'],
          destination: { label, coordinate: BASE_ROUTE.at(-1)! },
        }),
      ],
      { now: new Date('2026-09-02T09:10:00Z') },
    );
    expect(matches[0]!.destinationArea).toBe('目的地区域（具体位置已隐藏）');
  });
  it('rejects calendar rollover and timezone-less departure', () => {
    const base = intent('self');
    expect(() =>
      normalizeCarpoolIntentInput({ ...base, travelDate: '2026-02-30' }),
    ).toThrow(/日期/);
    expect(() =>
      normalizeCarpoolIntentInput({
        ...base,
        departureTime: '2026-09-02T18:30:00',
      }),
    ).toThrow(/时间/);
  });
});

it('clips the near-road strip independently of diagonal sampling density', () => {
  const point = (x: number, y: number) => ({
    longitude: 116 + x / (111195 * Math.cos((40 * Math.PI) / 180)),
    latitude: 40 + y / 111195,
  });
  const denseA = Array.from({ length: 101 }, (_, i) => point(i * 10, 0));
  const denseB = Array.from({ length: 101 }, (_, i) =>
    point(i * 10, -60 + i * 1.2),
  );
  const sparse = routeOverlap(
    [denseA[0]!, denseA.at(-1)!],
    [denseB[0]!, denseB.at(-1)!],
  );
  const dense = routeOverlap(denseA, denseB);
  expect(sparse.overlap).toBeCloseTo(dense.overlap, 2);
  expect(sparse.overlap).toBeGreaterThan(0.6);
});

it('isolates structurally invalid decrypted candidates', () => {
  const bad = intent('bad', {
    travelOptions: ['driver'],
    route: { ...intent('x').route, polyline: null as never },
  });
  const errors: string[] = [];
  const result = buildCarpoolMatches(
    intent('self'),
    [bad, intent('good', { travelOptions: ['driver'] })],
    {
      now: new Date('2026-09-02T09:10:00Z'),
      onCandidateError: (id) => errors.push(id),
    },
  );
  expect(result.map((match) => match.intentId)).toEqual(['good']);
  expect(errors).toEqual(['bad']);
});

it('returns the intersection of departure windows and actual confirmation age', () => {
  const matches = buildCarpoolMatches(
    intent('a'),
    [
      intent('b', {
        departureTime: '2026-09-02T18:50:00+08:00',
        flexibleMinutes: 10,
      }),
    ],
    { now: new Date('2026-09-02T09:12:00Z') },
  );
  expect(matches[0]).toMatchObject({
    sharedDepartureStart: '2026-09-02T10:40:00.000Z',
    sharedDepartureEnd: '2026-09-02T11:00:00.000Z',
    confirmedAgoMinutes: 12,
  });
});
