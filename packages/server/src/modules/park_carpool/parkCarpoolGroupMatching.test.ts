/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import {
  evaluateCarpoolGroup,
  planCarpoolDetour,
} from './parkCarpoolGroupMatching.js';
import type { ParkCarpoolIntent } from './parkCarpoolDomain.js';
import type { CarpoolGroup } from './parkCarpoolWorkflow.js';
const route = (id: string, start = 116, end = 116.1): ParkCarpoolIntent => ({
  id,
  accountId: id,
  organizationId: id,
  organizationName: '测试',
  displayName: id,
  parkId: 'park',
  travelDate: '2026-09-08',
  departureTime: '2026-09-08T10:30:00Z',
  flexibleMinutes: 30,
  travelOptions: ['rider', 'shared_taxi', 'driver'],
  origin: { label: '出发', coordinate: { longitude: start, latitude: 40 } },
  destination: { label: '到达', coordinate: { longitude: end, latitude: 40 } },
  route: {
    provider: 'synthetic',
    polyline: [
      { longitude: start, latitude: 40 },
      { longitude: end, latitude: 40 },
    ],
    distanceMeters: 8500,
    durationSeconds: 1200,
  },
  status: 'active',
  lastConfirmedAt: '2026-09-08T00:00:00Z',
  expiresAt: '2026-09-08T12:00:00Z',
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z',
});
const a = route('a');
const b = route('b');
const c = route('c');
const group: CarpoolGroup = {
  id: 'group',
  travelMode: 'shared_taxi',
  coordinatorAccountId: 'a',
  passengerCapacity: 3,
  status: 'active',
  members: [a, b].map((i) => ({
    accountId: i.accountId,
    organizationId: i.organizationId,
    displayName: i.displayName,
    intentId: i.id,
    joinedAt: i.createdAt,
  })),
  version: 1,
  conversationId: 'chat',
  createdAt: a.createdAt,
  expiresAt: a.expiresAt,
};
it('uses candidate-specific taxi average/minimum score and refuses poor member overlap or detour', () => {
  const result = evaluateCarpoolGroup(
    group,
    [a, route('b', 116, 116.08)],
    c,
    { maximumDetourSeconds: 0 },
    {},
  );
  expect(result?.overlapPercent).toBe(93);
  expect(
    evaluateCarpoolGroup(
      group,
      [a, route('b', 116.3, 116.4)],
      c,
      { maximumDetourSeconds: 0 },
      {},
    ),
  ).toBeNull();
  expect(
    evaluateCarpoolGroup(group, [a, b], c, { maximumDetourSeconds: 601 }, {}),
  ).toBeNull();
});
it('private car requires rider, live unique driver, driver overlap and capacity', () => {
  const privateGroup = {
    ...group,
    travelMode: 'private_vehicle' as const,
    driverAccountId: 'a',
  };
  expect(
    evaluateCarpoolGroup(
      privateGroup,
      [route('a', 116.3, 116.4), b],
      c,
      { maximumDetourSeconds: 0 },
      {},
    ),
  ).toBeNull();
  expect(
    evaluateCarpoolGroup(
      privateGroup,
      [a, b],
      { ...c, travelOptions: ['driver'] },
      { maximumDetourSeconds: 0 },
      {},
    ),
  ).toBeNull();
  expect(
    evaluateCarpoolGroup(
      { ...privateGroup, passengerCapacity: 1 },
      [a, b],
      c,
      { maximumDetourSeconds: 0 },
      {},
    ),
  ).toBeNull();
});
it('plans actual ordered legs with provider durations, derives each onboard detour and propagates provider failure', async () => {
  const planner = {
    configured: true,
    searchPlaces: async () => [],
    planDrivingRoute: async (
      origin: typeof a.origin.coordinate,
      destination: typeof a.origin.coordinate,
    ) => ({
      provider: 'synthetic-legs',
      polyline: [origin, destination],
      distanceMeters: 8500,
      durationSeconds: 2000,
    }),
  };
  const result = await planCarpoolDetour(group, [a, b], c, planner);
  expect(result.maximumDetourSeconds).toBe(800);
  await expect(
    planCarpoolDetour(group, [a, b], c, {
      ...planner,
      planDrivingRoute: async () => {
        throw new Error('map unavailable');
      },
    }),
  ).rejects.toThrow('map unavailable');
});

it('pauses stale group candidates and reports confirmation freshness before the pause threshold', () => {
  const policy = {
    now: new Date('2026-09-08T05:00:00Z'),
    staleMinutes: 120,
    pauseMinutes: 360,
  };
  expect(
    evaluateCarpoolGroup(group, [a, b], c, { maximumDetourSeconds: 0 }, policy)
      ?.freshness,
  ).toBe('needs_confirmation');
  expect(
    evaluateCarpoolGroup(
      group,
      [a, b],
      c,
      { maximumDetourSeconds: 0 },
      { ...policy, now: new Date('2026-09-08T07:00:00Z') },
    ),
  ).toBeNull();
});

it('exposes the shared departure window of all members and the candidate', () => {
  const result = evaluateCarpoolGroup(
    group,
    [a, { ...b, departureTime: '2026-09-08T10:50:00Z', flexibleMinutes: 10 }],
    c,
    { maximumDetourSeconds: 0 },
    { now: new Date('2026-09-08T00:12:00Z') },
  );
  expect(result).toMatchObject({
    sharedDepartureStart: '2026-09-08T10:40:00.000Z',
    sharedDepartureEnd: '2026-09-08T11:00:00.000Z',
    confirmedAgoMinutes: 12,
  });
});
