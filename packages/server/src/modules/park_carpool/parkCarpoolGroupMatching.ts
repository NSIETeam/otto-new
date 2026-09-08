/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import {
  distanceMeters,
  routeOverlap,
  type ParkCarpoolIntent,
  type ParkCarpoolCoordinate,
  type ParkCarpoolMatch,
} from './parkCarpoolDomain.js';
import type { ParkCarpoolMapProvider } from './parkCarpoolService.js';
import type { CarpoolGroup } from './parkCarpoolWorkflow.js';
export interface CarpoolGroupPolicy {
  now?: Date;
  staleMinutes?: number;
  pauseMinutes?: number;
  minimumDriverOverlap?: number;
  minimumMemberOverlap?: number;
  maximumDetourSeconds?: number;
}
export interface CarpoolDetour {
  maximumDetourSeconds: number;
  perMember: Array<{ accountId: string; detourSeconds: number }>;
}
export interface CarpoolGroupMatch extends ParkCarpoolMatch {
  inviteToMyGroup?: boolean;
  coordinatorName: string;
  driverName?: string;
  groupId: string;
  groupVersion: number;
  memberCount: number;
  remainingPlaces: number;
  travelMode: CarpoolGroup['travelMode'];
  averageOverlapPercent: number;
  lowestOverlapPercent: number;
  maximumDetourSeconds: number;
  memberOverlaps: Array<{
    displayName: string;
    overlapPercent: number;
    driver: boolean;
  }>;
}
export interface CarpoolGroupAssessment {
  groupId: string;
  candidateId: string;
  fingerprint: string;
  detour: CarpoolDetour;
}
export function groupMatchFingerprint(
  group: CarpoolGroup,
  members: ParkCarpoolIntent[],
  candidate: ParkCarpoolIntent,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        group.id,
        group.version,
        group.driverAccountId,
        group.status,
        group.passengerCapacity,
        ...[...members, candidate].map((i) => [
          i.accountId,
          i.version,
          i.status,
          i.organizationId,
          i.parkId,
          i.travelDate,
          i.departureTime,
          i.flexibleMinutes,
          i.travelOptions,
          i.route,
          i.lastConfirmedAt,
        ]),
      ]),
    )
    .digest('hex');
}
/** Conservative explicit stop order; every leg is planned by the configured road provider. */
export async function planCarpoolDetour(
  group: CarpoolGroup,
  members: ParkCarpoolIntent[],
  candidate: ParkCarpoolIntent,
  provider: ParkCarpoolMapProvider,
): Promise<CarpoolDetour> {
  const all = [...members, candidate];
  const driver = all.find(
    (i) =>
      i.accountId === (group.driverAccountId ?? group.coordinatorAccountId),
  );
  if (!driver) throw new Error('同行司机/协调人失效');
  type Stop = {
    accountId: string;
    kind: 'pickup' | 'dropoff';
    coordinate: ParkCarpoolCoordinate;
  };
  const pending: Stop[] = all.flatMap((i) => [
    {
      accountId: i.accountId,
      kind: 'pickup' as const,
      coordinate: i.origin.coordinate,
    },
    {
      accountId: i.accountId,
      kind: 'dropoff' as const,
      coordinate: i.destination.coordinate,
    },
  ]);
  let cursor = driver.origin.coordinate;
  const picked = new Map<string, number>();
  const dropped = new Map<string, number>();
  let elapsed = 0;
  while (pending.length) {
    const eligible = pending
      .filter((stop) => stop.kind === 'pickup' || picked.has(stop.accountId))
      .filter(
        (stop) =>
          !(
            group.travelMode === 'private_vehicle' &&
            stop.kind === 'dropoff' &&
            stop.accountId === driver.accountId &&
            pending.length > 1
          ),
      );
    eligible.sort(
      (a, b) =>
        distanceMeters(cursor, a.coordinate) -
          distanceMeters(cursor, b.coordinate) ||
        (a.kind === b.kind ? 0 : a.kind === 'pickup' ? -1 : 1) ||
        a.accountId.localeCompare(b.accountId),
    );
    const next = eligible[0];
    if (!next) throw new Error('无法构造同行上下车顺序');
    if (distanceMeters(cursor, next.coordinate) > 1) {
      const leg = await provider.planDrivingRoute(cursor, next.coordinate);
      if (!Number.isFinite(leg.durationSeconds) || leg.durationSeconds <= 0)
        throw new Error('地图服务未返回有效绕行时间');
      elapsed += leg.durationSeconds;
    }
    if (next.kind === 'pickup') picked.set(next.accountId, elapsed);
    else dropped.set(next.accountId, elapsed);
    cursor = next.coordinate;
    pending.splice(pending.indexOf(next), 1);
  }
  const perMember = all.map((i) => ({
    accountId: i.accountId,
    detourSeconds: Math.max(
      0,
      dropped.get(i.accountId)! -
        picked.get(i.accountId)! -
        i.route.durationSeconds,
    ),
  }));
  return {
    perMember,
    maximumDetourSeconds: Math.max(
      0,
      ...perMember
        .filter(
          (i) =>
            group.travelMode === 'shared_taxi' ||
            i.accountId === driver.accountId,
        )
        .map((i) => i.detourSeconds),
    ),
  };
}
export function evaluateCarpoolGroup(
  group: CarpoolGroup,
  members: ParkCarpoolIntent[],
  candidate: ParkCarpoolIntent,
  detour: Pick<CarpoolDetour, 'maximumDetourSeconds'>,
  policy: CarpoolGroupPolicy,
): CarpoolGroupMatch | null {
  if (
    group.status !== 'active' ||
    group.members.length >= group.passengerCapacity + 1 ||
    members.length !== group.members.length ||
    members.some((i) => i.accountId === candidate.accountId) ||
    !Number.isFinite(detour.maximumDetourSeconds) ||
    detour.maximumDetourSeconds > (policy.maximumDetourSeconds ?? 600)
  )
    return null;
  if (
    !candidate.travelOptions.includes(
      group.travelMode === 'shared_taxi' ? 'shared_taxi' : 'rider',
    )
  )
    return null;
  const all = [...members, candidate];
  const oldest = Math.max(
    ...all.map(
      (intent) =>
        (policy.now?.getTime() ?? Date.parse(intent.lastConfirmedAt)) -
        Date.parse(intent.lastConfirmedAt),
    ),
  );
  if (oldest > (policy.pauseMinutes ?? 360) * 60_000) return null;
  if (
    all.some(
      (i) =>
        i.parkId !== candidate.parkId ||
        i.travelDate !== candidate.travelDate ||
        i.status !== 'active',
    )
  )
    return null;
  const windowStart = Math.max(
    ...all.map((i) => Date.parse(i.departureTime) - i.flexibleMinutes * 60_000),
  );
  const windowEnd = Math.min(
    ...all.map((i) => Date.parse(i.departureTime) + i.flexibleMinutes * 60_000),
  );
  if (windowStart > windowEnd) return null;
  const overlaps = members.map((i) => ({
    intent: i,
    ...routeOverlap(candidate.route.polyline, i.route.polyline),
  }));
  const average =
    overlaps.reduce((sum, x) => sum + x.overlap, 0) / overlaps.length;
  const lowest = Math.min(...overlaps.map((x) => x.overlap));
  const coordinator = members.find(
    (i) => i.accountId === group.coordinatorAccountId,
  );
  if (!coordinator) return null;
  const driver = overlaps.find(
    (x) => x.intent.accountId === group.driverAccountId,
  );
  if (
    group.travelMode === 'private_vehicle' &&
    (!driver ||
      !driver.intent.travelOptions.includes('driver') ||
      driver.overlap < (policy.minimumDriverOverlap ?? 0.35))
  )
    return null;
  if (
    group.travelMode === 'shared_taxi' &&
    (lowest < (policy.minimumMemberOverlap ?? 0.35) ||
      members.some((i) => !i.travelOptions.includes('shared_taxi')))
  )
    return null;
  const score =
    group.travelMode === 'private_vehicle'
      ? driver!.overlap
      : average * 0.75 + lowest * 0.25;
  return {
    coordinatorName: coordinator.displayName.slice(0, 1) + '同事',
    driverName: driver?.intent.displayName.slice(0, 1)
      ? driver.intent.displayName.slice(0, 1) + '同事'
      : undefined,
    candidateVersion: coordinator.version,
    intentId: coordinator.id,
    groupId: group.id,
    groupVersion: group.version,
    memberCount: members.length,
    remainingPlaces: group.passengerCapacity + 1 - members.length,
    travelMode: group.travelMode,
    displayName: `${members.length} 人同行组`,
    organizationName: '同园区已认证成员',
    verifiedParkMember: true,
    departureTime: new Date(
      Math.max(
        windowStart,
        Math.min(Date.parse(candidate.departureTime), windowEnd),
      ),
    ).toISOString(),
    sharedDepartureStart: new Date(windowStart).toISOString(),
    sharedDepartureEnd: new Date(windowEnd).toISOString(),
    confirmedAgoMinutes: Math.max(0, Math.floor(oldest / 60_000)),
    timeDifferenceMinutes: Math.round(
      Math.abs(
        Date.parse(candidate.departureTime) -
          Date.parse(coordinator.departureTime),
      ) / 60_000,
    ),
    overlapPercent: Math.round(score * 100),
    commonDistanceMeters: Math.round(
      group.travelMode === 'private_vehicle'
        ? driver!.commonDistanceMeters
        : overlaps.reduce((sum, x) => sum + x.commonDistanceMeters, 0) /
            overlaps.length,
    ),
    compatibleModes: [
      group.travelMode === 'private_vehicle'
        ? 'current_rides_candidate_vehicle'
        : 'shared_taxi',
    ],
    originArea: '出发区域（具体位置已隐藏）',
    destinationArea: '目的地区域（具体位置已隐藏）',
    freshness:
      oldest > (policy.staleMinutes ?? 120) * 60_000
        ? 'needs_confirmation'
        : 'recent',
    averageOverlapPercent: Math.round(average * 100),
    lowestOverlapPercent: Math.round(lowest * 100),
    maximumDetourSeconds: detour.maximumDetourSeconds,
    memberOverlaps: overlaps.map((x) => ({
      displayName: x.intent.displayName.slice(0, 1) + '同事',
      overlapPercent: Math.round(x.overlap * 100),
      driver: x.intent.accountId === group.driverAccountId,
    })),
    explanation: `${group.travelMode === 'private_vehicle' ? '与你的司机路线重合' : '全组平均 × 75% ＋ 最低成员 × 25%'}约 ${Math.round(score * 100)}%；按地图规划的上下车顺序，预计最大增加 ${Math.ceil(detour.maximumDetourSeconds / 60)} 分钟。路线重合为几何近似，绕行是本次规划估算，非实时交通保证。`,
  };
}
