/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
/** Engineering defaults for local delivery; deployment values require operator review. */
export function readCarpoolConfig(env: NodeJS.ProcessEnv = process.env) {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`${key} 配置无效`);
    return value;
  };
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = number(key, fallback, min, max);
    if (!Number.isInteger(value)) throw new Error(`${key} 配置无效`);
    return value;
  };
  const flag = (key: string) => {
    const value = env[key];
    if (value === undefined) return true;
    if (!['true', 'false', '1', '0'].includes(value))
      throw new Error(`${key} 配置无效`);
    return value === 'true' || value === '1';
  };
  const staleMinutes = number('OTTO_PARK_CARPOOL_STALE_MINUTES', 120, 5, 1440);
  const pauseMinutes = number(
    'OTTO_PARK_CARPOOL_PAUSE_MINUTES',
    360,
    staleMinutes,
    1440,
  );
  return {
    requestLimitPerHour: integer(
      'OTTO_PARK_CARPOOL_REQUEST_LIMIT_PER_HOUR',
      10,
      1,
      100,
    ),
    cooldownMinutes: integer('OTTO_PARK_CARPOOL_COOLDOWN_MINUTES', 30, 1, 1440),
    maxTaxiMembers: integer('OTTO_PARK_CARPOOL_MAX_TAXI_MEMBERS', 4, 2, 4),
    staleMinutes,
    pauseMinutes,
    positionRetentionHours: number(
      'OTTO_PARK_CARPOOL_POSITION_RETENTION_HOURS',
      24,
      1,
      168,
    ),
    communicationRetentionDays: number(
      'OTTO_PARK_CARPOOL_COMMUNICATION_RETENTION_DAYS',
      30,
      1,
      90,
    ),
    minimumDriverOverlap: number(
      'OTTO_PARK_CARPOOL_DRIVER_MINIMUM_OVERLAP',
      0.35,
      0,
      1,
    ),
    minimumMemberOverlap: number(
      'OTTO_PARK_CARPOOL_TAXI_MINIMUM_OVERLAP',
      0.35,
      0,
      1,
    ),
    maximumDetourSeconds: number(
      'OTTO_PARK_CARPOOL_MAXIMUM_DETOUR_SECONDS',
      600,
      0,
      3600,
    ),
    requestsEnabled: flag('OTTO_PARK_CARPOOL_REQUESTS_ENABLED'),
    invitationsEnabled: flag('OTTO_PARK_CARPOOL_INVITATIONS_ENABLED'),
    groupsEnabled: flag('OTTO_PARK_CARPOOL_GROUPS_ENABLED'),
  };
}
export function carpoolCommunicationCapabilities(): string[] {
  const config = readCarpoolConfig();
  return [
    ...(config.requestsEnabled
      ? ['park_carpool_requests_v1', 'park_carpool_mls_v1']
      : []),
    ...(config.requestsEnabled && config.invitationsEnabled
      ? ['park_carpool_invitations_v1']
      : []),
    ...(config.requestsEnabled &&
    config.invitationsEnabled &&
    config.groupsEnabled
      ? ['park_carpool_groups_v1']
      : []),
  ];
}
