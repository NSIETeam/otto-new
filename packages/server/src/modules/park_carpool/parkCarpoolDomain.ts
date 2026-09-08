import { readCarpoolConfig } from './parkCarpoolConfig.js';
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const PARK_CARPOOL_TRAVEL_OPTIONS = [
  'driver',
  'rider',
  'shared_taxi',
] as const;

export type ParkCarpoolTravelOption =
  (typeof PARK_CARPOOL_TRAVEL_OPTIONS)[number];
export type ParkCarpoolIntentStatus =
  'active' | 'paused' | 'grouped' | 'expired';
export type ParkCarpoolCompatibleMode =
  | 'current_rides_candidate_vehicle'
  | 'candidate_rides_current_vehicle'
  | 'shared_taxi';

export interface ParkCarpoolCoordinate {
  longitude: number;
  latitude: number;
}

export interface ParkCarpoolPlace {
  publicArea?: { label: string; code: string; precision: 'district' };
  label: string;
  coordinate: ParkCarpoolCoordinate;
}

export interface ParkCarpoolRoute {
  provider: string;
  distanceMeters: number;
  durationSeconds: number;
  polyline: ParkCarpoolCoordinate[];
}

export interface ParkCarpoolIntentInput {
  travelDate: string;
  origin: ParkCarpoolPlace;
  destination: ParkCarpoolPlace;
  departureTime: string;
  flexibleMinutes: number;
  travelOptions: ParkCarpoolTravelOption[];
}

export interface ParkCarpoolIntent extends ParkCarpoolIntentInput {
  version?: number;
  requestKey?: string;
  requestHash?: string;
  id: string;
  accountId: string;
  organizationId: string;
  organizationName: string;
  displayName: string;
  parkId: string;
  route: ParkCarpoolRoute;
  status: ParkCarpoolIntentStatus;
  lastConfirmedAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ParkCarpoolMatch {
  pendingRequest?: 'sent' | 'received';
  sharedDepartureStart?: string;
  sharedDepartureEnd?: string;
  confirmedAgoMinutes?: number;
  candidateVersion?: number;
  intentId: string;
  displayName: string;
  organizationName: string;
  verifiedParkMember: true;
  departureTime: string;
  timeDifferenceMinutes: number;
  overlapPercent: number;
  commonDistanceMeters: number;
  compatibleModes: ParkCarpoolCompatibleMode[];
  originArea: string;
  destinationArea: string;
  freshness:
    'just_updated' | 'recent' | 'departing_soon' | 'needs_confirmation';
  explanation: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const TRAVEL_OPTION_SET = new Set<string>(PARK_CARPOOL_TRAVEL_OPTIONS);
const EARTH_RADIUS_METERS = 6_371_000;

function text(value: unknown, label: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maximum)
    throw new Error(`${label}不能超过 ${maximum} 个字符`);
  return normalized;
}

function coordinate(value: unknown, label: string): ParkCarpoolCoordinate {
  if (!value || typeof value !== 'object') throw new Error(`${label}坐标无效`);
  const candidate = value as Partial<ParkCarpoolCoordinate>;
  const longitude = Number(candidate.longitude);
  const latitude = Number(candidate.latitude);
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  )
    throw new Error(`${label}坐标无效`);
  return { longitude, latitude };
}

export function distanceMeters(
  left: ParkCarpoolCoordinate,
  right: ParkCarpoolCoordinate,
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const lat1 = toRadians(left.latitude);
  const lat2 = toRadians(right.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(right.longitude - left.longitude);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function normalizeCarpoolIntentInput(
  value: ParkCarpoolIntentInput,
): ParkCarpoolIntentInput {
  const travelDate = text(value?.travelDate, '出行日期', 10);
  if (
    !DATE_RE.test(travelDate) ||
    Number.isNaN(Date.parse(`${travelDate}T00:00:00Z`)) ||
    new Date(`${travelDate}T00:00:00Z`).toISOString().slice(0, 10) !==
      travelDate
  ) {
    throw new Error('出行日期格式无效');
  }
  const origin = {
    label: text(value?.origin?.label, '出发地', 160),
    coordinate: coordinate(value?.origin?.coordinate, '出发地'),
  };
  const destination = {
    label: text(value?.destination?.label, '目的地', 160),
    coordinate: coordinate(value?.destination?.coordinate, '目的地'),
  };
  if (distanceMeters(origin.coordinate, destination.coordinate) < 30) {
    throw new Error('出发地和目的地不能相同');
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value?.departureTime ?? '',
    )
  ) {
    throw new Error('计划出发时间必须包含时区');
  }
  const parsedDeparture = Date.parse(value?.departureTime);
  if (!Number.isFinite(parsedDeparture)) throw new Error('计划出发时间无效');
  const flexibleMinutes = Math.floor(Number(value?.flexibleMinutes));
  if (
    !Number.isFinite(flexibleMinutes) ||
    flexibleMinutes < 0 ||
    flexibleMinutes > 120
  ) {
    throw new Error('可接受时间范围应在 0 至 120 分钟之间');
  }
  const rawOptions = Array.isArray(value?.travelOptions)
    ? value.travelOptions
    : [];
  if (rawOptions.some((item) => !TRAVEL_OPTION_SET.has(item))) {
    throw new Error('出行选择包含未知值');
  }
  const travelOptions = [...new Set(rawOptions)] as ParkCarpoolTravelOption[];
  if (travelOptions.length === 0) throw new Error('请至少选择一种出行选择');
  return {
    travelDate,
    origin,
    destination,
    departureTime: new Date(parsedDeparture).toISOString(),
    flexibleMinutes,
    travelOptions,
  };
}

interface Segment {
  start: ParkCarpoolCoordinate;
  end: ParkCarpoolCoordinate;
  midpoint: ParkCarpoolCoordinate;
  length: number;
  bearing: number;
}

function routeSegments(route: readonly ParkCarpoolCoordinate[]): Segment[] {
  if (
    !Array.isArray(route) ||
    route.some(
      (point) =>
        !point ||
        !Number.isFinite(point.longitude) ||
        !Number.isFinite(point.latitude),
    )
  )
    throw new Error('路线数据无效');
  const segments: Segment[] = [];
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1]!;
    const end = route[index]!;
    const length = distanceMeters(start, end);
    if (length < 1) continue;
    const meanLatitude =
      (((start.latitude + end.latitude) / 2) * Math.PI) / 180;
    const x = (end.longitude - start.longitude) * Math.cos(meanLatitude);
    const y = end.latitude - start.latitude;
    const bearing = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
    segments.push({
      start,
      end,
      midpoint: {
        longitude: (start.longitude + end.longitude) / 2,
        latitude: (start.latitude + end.latitude) / 2,
      },
      length,
      bearing,
    });
  }
  return segments;
}

function bearingDifference(left: number, right: number): number {
  const difference = Math.abs(left - right) % 360;
  return Math.min(difference, 360 - difference);
}

/** Geometric approximation only: no road IDs or grade separation are available.
 * Intersect directed projected intervals, union overlaps before counting, and
 * clip to the 40m proximity strip without expanding segment endpoints. Never count a whole long
 * segment merely because its midpoint is near a short one.
 */
function matchedLength(
  source: readonly Segment[],
  target: readonly Segment[],
): number {
  return source.reduce((sum, segment) => {
    const scaleY = (Math.PI / 180) * EARTH_RADIUS_METERS;
    const scaleX =
      Math.cos(
        (((segment.start.latitude + segment.end.latitude) / 2) * Math.PI) / 180,
      ) * scaleY;
    const dx = (segment.end.longitude - segment.start.longitude) * scaleX;
    const dy = (segment.end.latitude - segment.start.latitude) * scaleY;
    const length = Math.hypot(dx, dy);
    const intervals: Array<[number, number]> = [];
    for (const candidate of target) {
      if (bearingDifference(segment.bearing, candidate.bearing) > 15) continue;
      const project = (point: ParkCarpoolCoordinate) => {
        const x = (point.longitude - segment.start.longitude) * scaleX;
        const y = (point.latitude - segment.start.latitude) * scaleY;
        return {
          along: (x * dx + y * dy) / length,
          offset: (x * dy - y * dx) / length,
        };
      };
      const start = project(candidate.start);
      const end = project(candidate.end);
      const slope = end.offset - start.offset;
      let enter = 0;
      let leave = 1;
      if (Math.abs(slope) < 1e-9) {
        if (Math.abs(start.offset) > 40) continue;
      } else {
        const t1 = (-40 - start.offset) / slope;
        const t2 = (40 - start.offset) / slope;
        enter = Math.max(0, Math.min(t1, t2));
        leave = Math.min(1, Math.max(t1, t2));
        if (enter >= leave) continue;
      }
      const from = Math.max(0, start.along + enter * (end.along - start.along));
      const to = Math.min(
        length,
        start.along + leave * (end.along - start.along),
      );
      if (to > from) intervals.push([from, to]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = 0;
    for (const [from, to] of intervals) {
      covered += Math.max(0, to - Math.max(from, end));
      end = Math.max(end, to);
    }
    return sum + (covered / length) * segment.length;
  }, 0);
}

export function routeOverlap(
  leftRoute: readonly ParkCarpoolCoordinate[],
  rightRoute: readonly ParkCarpoolCoordinate[],
): { overlap: number; commonDistanceMeters: number } {
  const left = routeSegments(leftRoute);
  const right = routeSegments(rightRoute);
  const leftLength = left.reduce((sum, segment) => sum + segment.length, 0);
  const rightLength = right.reduce((sum, segment) => sum + segment.length, 0);
  if (!leftLength || !rightLength)
    return { overlap: 0, commonDistanceMeters: 0 };
  const matchedLeft = matchedLength(left, right);
  const matchedRight = matchedLength(right, left);
  const commonDistanceMeters = Math.min(
    matchedLeft,
    matchedRight,
    leftLength,
    rightLength,
  );
  return {
    overlap: Math.max(
      0,
      Math.min(1, (2 * commonDistanceMeters) / (leftLength + rightLength)),
    ),
    commonDistanceMeters: Math.floor(commonDistanceMeters),
  };
}

export function compatibleCarpoolModes(
  current: readonly ParkCarpoolTravelOption[],
  candidate: readonly ParkCarpoolTravelOption[],
): ParkCarpoolCompatibleMode[] {
  const currentSet = new Set(current);
  const candidateSet = new Set(candidate);
  return [
    ...(currentSet.has('rider') && candidateSet.has('driver')
      ? ['current_rides_candidate_vehicle' as const]
      : []),
    ...(currentSet.has('driver') && candidateSet.has('rider')
      ? ['candidate_rides_current_vehicle' as const]
      : []),
    ...(currentSet.has('shared_taxi') && candidateSet.has('shared_taxi')
      ? ['shared_taxi' as const]
      : []),
  ];
}

function maskedDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '园区用户';
  const characters = Array.from(normalized);
  if (/^[\p{Script=Han}]+$/u.test(normalized)) return `${characters[0]}某`;
  return `${characters[0]}${'*'.repeat(Math.min(3, Math.max(1, characters.length - 1)))}`;
}

function freshness(
  intent: ParkCarpoolIntent,
  now: Date,
): ParkCarpoolMatch['freshness'] {
  const untilDeparture = Date.parse(intent.departureTime) - now.getTime();
  if (untilDeparture >= 0 && untilDeparture <= 30 * 60_000)
    return 'departing_soon';
  const age = now.getTime() - Date.parse(intent.lastConfirmedAt);
  return age > readCarpoolConfig().staleMinutes * 60_000
    ? 'needs_confirmation'
    : age <= 5 * 60_000
      ? 'just_updated'
      : 'recent';
}

export function buildCarpoolMatches(
  current: ParkCarpoolIntent,
  candidates: readonly ParkCarpoolIntent[],
  options: {
    minimumOverlap?: number;
    now?: Date;
    onCandidateError?(intentId: string): void;
  } = {},
): ParkCarpoolMatch[] {
  const configuredMinimum = options.minimumOverlap ?? 0.35;
  const minimumOverlap = Number.isFinite(configuredMinimum)
    ? Math.max(0, Math.min(1, configuredMinimum))
    : 0.35;
  const now = options.now ?? new Date();
  return candidates
    .flatMap((candidate): ParkCarpoolMatch[] => {
      try {
        const expiresAt = Date.parse(candidate.expiresAt);
        if (
          candidate.accountId === current.accountId ||
          candidate.parkId !== current.parkId ||
          candidate.travelDate !== current.travelDate ||
          candidate.status !== 'active' ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= now.getTime()
        )
          return [];
        if (
          now.getTime() - Date.parse(candidate.lastConfirmedAt) >
          readCarpoolConfig().pauseMinutes * 60_000
        )
          return [];
        const timeDifferenceMinutes = Math.round(
          Math.abs(
            Date.parse(candidate.departureTime) -
              Date.parse(current.departureTime),
          ) / 60_000,
        );
        if (
          timeDifferenceMinutes >
          current.flexibleMinutes + candidate.flexibleMinutes
        )
          return [];
        const compatibleModes = compatibleCarpoolModes(
          current.travelOptions,
          candidate.travelOptions,
        );
        if (!compatibleModes.length) return [];
        const overlap = routeOverlap(
          current.route.polyline,
          candidate.route.polyline,
        );
        if (overlap.overlap < minimumOverlap) return [];
        const overlapPercent = Math.round(overlap.overlap * 100);
        return [
          {
            candidateVersion: candidate.version,
            intentId: candidate.id,
            displayName: maskedDisplayName(candidate.displayName),
            organizationName: candidate.organizationName,
            verifiedParkMember: true,
            departureTime: candidate.departureTime,
            sharedDepartureStart: new Date(
              Math.max(
                Date.parse(current.departureTime) -
                  current.flexibleMinutes * 60_000,
                Date.parse(candidate.departureTime) -
                  candidate.flexibleMinutes * 60_000,
              ),
            ).toISOString(),
            sharedDepartureEnd: new Date(
              Math.min(
                Date.parse(current.departureTime) +
                  current.flexibleMinutes * 60_000,
                Date.parse(candidate.departureTime) +
                  candidate.flexibleMinutes * 60_000,
              ),
            ).toISOString(),
            confirmedAgoMinutes: Math.max(
              0,
              Math.floor(
                (now.getTime() - Date.parse(candidate.lastConfirmedAt)) /
                  60_000,
              ),
            ),
            timeDifferenceMinutes,
            overlapPercent,
            commonDistanceMeters: overlap.commonDistanceMeters,
            compatibleModes,
            originArea:
              candidate.origin.publicArea?.label ||
              '出发地区域（具体位置已隐藏）',
            destinationArea:
              candidate.destination.publicArea?.label ||
              '目的地区域（具体位置已隐藏）',
            freshness: freshness(candidate, now),
            explanation: `按路线几何近似估算（无法区分相邻道路或立交），同向共同路段约 ${(overlap.commonDistanceMeters / 1_000).toFixed(1)} 公里，路线重合度约 ${overlapPercent}%，出发时间相差 ${timeDifferenceMinutes} 分钟。`,
          },
        ];
      } catch {
        options.onCandidateError?.(candidate?.id ?? 'unknown');
        return [];
      }
    })
    .sort(
      (left, right) =>
        Number(left.freshness === 'needs_confirmation') -
          Number(right.freshness === 'needs_confirmation') ||
        right.overlapPercent - left.overlapPercent ||
        left.timeDifferenceMinutes - right.timeDifferenceMinutes ||
        right.commonDistanceMeters - left.commonDistanceMeters ||
        left.intentId.localeCompare(right.intentId),
    );
}
