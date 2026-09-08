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
  for (const NODE_ENV of [undefined, 'production'])
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
  expect(readCarpoolConfig({ NODE_ENV: 'test' }).requestsEnabled).toBe(true);
});

it('advertises only explicitly enabled production stages with their prerequisites', () => {
  try {
    vi.stubEnv('NODE_ENV', 'production');
    for (const key of ['REQUESTS', 'INVITATIONS', 'GROUPS'])
      vi.stubEnv(`OTTO_PARK_CARPOOL_${key}_ENABLED`, undefined);
    expect(carpoolCommunicationCapabilities()).toEqual([]);
    vi.stubEnv('OTTO_PARK_CARPOOL_GROUPS_ENABLED', 'true');
    expect(carpoolCommunicationCapabilities()).toEqual([]);
    vi.stubEnv('OTTO_PARK_CARPOOL_REQUESTS_ENABLED', 'true');
    expect(carpoolCommunicationCapabilities()).toEqual([
      'park_carpool_requests_v1',
      'park_carpool_mls_v1',
    ]);
    vi.stubEnv('OTTO_PARK_CARPOOL_INVITATIONS_ENABLED', 'true');
    expect(carpoolCommunicationCapabilities()).toContain(
      'park_carpool_groups_v1',
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
