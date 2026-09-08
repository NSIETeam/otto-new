/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import {
  readCarpoolConfig,
  carpoolCommunicationCapabilities,
} from './parkCarpoolConfig.js';
it('validates independent rollout flags and bounded request/capacity settings', () => {
  expect(
    readCarpoolConfig({
      OTTO_PARK_CARPOOL_GROUPS_ENABLED: 'false',
      OTTO_PARK_CARPOOL_MAX_TAXI_MEMBERS: '3',
      OTTO_PARK_CARPOOL_REQUEST_LIMIT_PER_HOUR: '6',
    }),
  ).toMatchObject({
    groupsEnabled: false,
    invitationsEnabled: false,
    maxTaxiMembers: 3,
    requestLimitPerHour: 6,
  });
  for (const env of [
    { OTTO_PARK_CARPOOL_MAX_TAXI_MEMBERS: '4.5' },
    { OTTO_PARK_CARPOOL_REQUEST_LIMIT_PER_HOUR: '0' },
    { OTTO_PARK_CARPOOL_GROUPS_ENABLED: 'yes' },
    {
      OTTO_PARK_CARPOOL_STALE_MINUTES: '120',
      OTTO_PARK_CARPOOL_PAUSE_MINUTES: '60',
    },
  ])
    expect(() => readCarpoolConfig(env)).toThrow(/配置无效/);
});

it('keeps production and unspecified environments closed unless explicitly enabled', () => {
  for (const NODE_ENV of [undefined, 'production', 'test', 'development'])
    expect(readCarpoolConfig({ NODE_ENV })).toMatchObject({
      requestsEnabled: false,
      invitationsEnabled: false,
      groupsEnabled: false,
    });
  expect(
    readCarpoolConfig({
      NODE_ENV: 'production',
      OTTO_PARK_CARPOOL_REQUESTS_ENABLED: 'true',
    }),
  ).toMatchObject({
    requestsEnabled: true,
    invitationsEnabled: false,
    groupsEnabled: false,
  });
  expect(readCarpoolConfig({ NODE_ENV: 'test' }).requestsEnabled).toBe(false);
});

it('advertises only explicitly enabled production stages with their prerequisites', () => {
  try {
    vi.stubEnv('NODE_ENV', 'production');
    for (const key of ['REQUESTS', 'INVITATIONS', 'GROUPS'])
      vi.stubEnv(`OTTO_PARK_CARPOOL_${key}_ENABLED`, undefined);
    expect(carpoolCommunicationCapabilities(readCarpoolConfig())).toEqual([]);
    vi.stubEnv('OTTO_PARK_CARPOOL_GROUPS_ENABLED', 'true');
    expect(carpoolCommunicationCapabilities(readCarpoolConfig())).toEqual([]);
    vi.stubEnv('OTTO_PARK_CARPOOL_REQUESTS_ENABLED', 'true');
    expect(carpoolCommunicationCapabilities(readCarpoolConfig())).toEqual([
      'park_carpool_requests_v1',
      'park_carpool_mls_v1',
    ]);
    vi.stubEnv('OTTO_PARK_CARPOOL_INVITATIONS_ENABLED', 'true');
    expect(carpoolCommunicationCapabilities(readCarpoolConfig())).toContain(
      'park_carpool_groups_v1',
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it('uses an immutable supplied snapshot even when the process environment changes', () => {
  const enabled = readCarpoolConfig({
    OTTO_PARK_CARPOOL_REQUESTS_ENABLED: 'true',
    OTTO_PARK_CARPOOL_INVITATIONS_ENABLED: 'true',
    OTTO_PARK_CARPOOL_GROUPS_ENABLED: 'true',
  });
  vi.stubEnv('OTTO_PARK_CARPOOL_REQUESTS_ENABLED', 'false');
  try {
    expect(Object.isFrozen(enabled)).toBe(true);
    expect(carpoolCommunicationCapabilities(enabled)).toContain('park_carpool_groups_v1');
    expect(carpoolCommunicationCapabilities(readCarpoolConfig({}))).toEqual([]);
  } finally { vi.unstubAllEnvs(); }
});

it('limits pilot capabilities to configured parks without conflating map readiness', () => {
  const pilot = readCarpoolConfig({
    OTTO_PARK_CARPOOL_REQUESTS_ENABLED: 'true',
    OTTO_PARK_CARPOOL_PILOT_PARK_IDS: 'park-a',
  });
  expect(carpoolCommunicationCapabilities(pilot, 'park-a')).toContain('park_carpool_requests_v1');
  expect(carpoolCommunicationCapabilities(pilot, 'park-b')).toEqual([]);
  expect(() => readCarpoolConfig({OTTO_PARK_CARPOOL_PILOT_PARK_IDS: 'park-a,,park-b'})).toThrow(/配置无效/);
});
