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
export type ParkCarpoolIntentStatus = 'active' | 'paused' | 'grouped' | 'expired';
export type ParkCarpoolCompatibleMode =
  | 'current_rides_candidate_vehicle'
  | 'candidate_rides_current_vehicle'
  | 'shared_taxi';

export interface ParkCarpoolCoordinate {
  longitude: number;
  latitude: number;
}

export interface ParkCarpoolPlace {
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
  freshness: 'just_updated' | 'recent' | 'departing_soon';
  explanation: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const TRAVEL_OPTION_SET = new Set<string>(PARK_CARPOOL_TRAVEL_OPTIONS);
const EARTH_RADIUS_METERS = 6_371_000;

function text(value: unknown, label: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符`);
  return normalized;
}

function coordinate(value: unknown, label: string): ParkCarpoolCoordinate {
  if (!value || typeof value !== 'object') throw new Error(`${label}坐标无效`);
  const candidate = value as Partial<ParkCarpoolCoordinate>;
  const longitude = Number(candidate.longitude);
  const latitude = Number(candidate.latitude);
  if (
    !Number.isFinite(longitude) || !Number.isFinite(latitude)
    || longitude < -180 || longitude > 180
    || latitude < -90 || latitude > 90
  ) throw new Error(`${label}坐标无效`);
  return { longitude, latitude };
}

export function distanceMeters(
  left: ParkCarpoolCoordinate,
  right: ParkCarpoolCoordinate,
): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const lat1 = toRadians(left.latitude);
  const lat2 = toRadians(right.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(right.longitude - left.longitude);
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function normalizeCarpoolIntentInput(
  value: ParkCarpoolIntentInput,
): ParkCarpoolIntentInput {
  const travelDate = text(value?.travelDate, '出行日期', 10);
  if (!DATE_RE.test(travelDate) || Number.isNaN(Date.parse(`${travelDate}T00:00:00Z`))) {
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
  const parsedDeparture = Date.parse(value?.departureTime);
  if (!Number.isFinite(parsedDeparture)) throw new Error('计划出发时间无效');
  const flexibleMinutes = Math.floor(Number(value?.flexibleMinutes));
  if (!Number.isFinite(flexibleMinutes) || flexibleMinutes < 0 || flexibleMinutes > 120) {
    throw new Error('可接受时间范围应在 0 至 120 分钟之间');
  }
  const rawOptions = Array.isArray(value?.travelOptions) ? value.travelOptions : [];
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
  const segments: Segment[] = [];
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1]!;
    const end = route[index]!;
    const length = distanceMeters(start, end);
    if (length < 1) continue;
    const meanLatitude = (start.latitude + end.latitude) / 2 * Math.PI / 180;
    const x = (end.longitude - start.longitude) * Math.cos(meanLatitude);
    const y = end.latitude - start.latitude;
    const bearing = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
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

function pointToSegmentMeters(point: ParkCarpoolCoordinate, segment: Segment): number {
  const referenceLatitude = point.latitude * Math.PI / 180;
  const scaleX = Math.cos(referenceLatitude) * Math.PI / 180 * EARTH_RADIUS_METERS;
  const scaleY = Math.PI / 180 * EARTH_RADIUS_METERS;
  const ax = (segment.start.longitude - point.longitude) * scaleX;
  const ay = (segment.start.latitude - point.latitude) * scaleY;
  const bx = (segment.end.longitude - point.longitude) * scaleX;
  const by = (segment.end.latitude - point.latitude) * scaleY;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const ratio = denominator > 0
    ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator))
    : 0;
  return Math.hypot(ax + ratio * dx, ay + ratio * dy);
}

function matchedLength(source: readonly Segment[], target: readonly Segment[]): number {
  return source.reduce((sum, segment) => {
    const matched = target.some((candidate) => (
      bearingDifference(segment.bearing, candidate.bearing) <= 50
      && pointToSegmentMeters(segment.midpoint, candidate) <= 350
    ));
    return sum + (matched ? segment.length : 0);
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
  if (!leftLength || !rightLength) return { overlap: 0, commonDistanceMeters: 0 };
  const matchedLeft = matchedLength(left, right);
  const matchedRight = matchedLength(right, left);
  const commonDistanceMeters = (matchedLeft + matchedRight) / 2;
  return {
    overlap: Math.max(0, Math.min(1, (matchedLeft + matchedRight) / (leftLength + rightLength))),
    commonDistanceMeters: Math.round(commonDistanceMeters),
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
      ? ['current_rides_candidate_vehicle' as const] : []),
    ...(currentSet.has('driver') && candidateSet.has('rider')
      ? ['candidate_rides_current_vehicle' as const] : []),
    ...(currentSet.has('shared_taxi') && candidateSet.has('shared_taxi')
      ? ['shared_taxi' as const] : []),
  ];
}

function approximateArea(label: string): string {
  const compact = label
    .replace(/\s*\d+[\s号#-]*(?:号楼|楼|栋|单元|室|门牌)?/gu, '')
    .replace(/[（(][^）)]*(?:门牌|楼|室)[^）)]*[）)]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(compact || '目的地区域').slice(0, 32).join('');
}

function maskedDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '园区用户';
  const characters = Array.from(normalized);
  if (/^[\p{Script=Han}]+$/u.test(normalized)) return `${characters[0]}某`;
  return `${characters[0]}${'*'.repeat(Math.min(3, Math.max(1, characters.length - 1)))}`;
}

function freshness(intent: ParkCarpoolIntent, now: Date): ParkCarpoolMatch['freshness'] {
  const untilDeparture = Date.parse(intent.departureTime) - now.getTime();
  if (untilDeparture >= 0 && untilDeparture <= 30 * 60_000) return 'departing_soon';
  const age = now.getTime() - Date.parse(intent.lastConfirmedAt);
  return age <= 5 * 60_000 ? 'just_updated' : 'recent';
}

export function buildCarpoolMatches(
  current: ParkCarpoolIntent,
  candidates: readonly ParkCarpoolIntent[],
  options: { minimumOverlap?: number; now?: Date } = {},
): ParkCarpoolMatch[] {
  const configuredMinimum = options.minimumOverlap ?? 0.35;
  const minimumOverlap = Number.isFinite(configuredMinimum)
    ? Math.max(0, Math.min(1, configuredMinimum))
    : 0.35;
  const now = options.now ?? new Date();
  return candidates.flatMap((candidate): ParkCarpoolMatch[] => {
    const expiresAt = Date.parse(candidate.expiresAt);
    if (
      candidate.accountId === current.accountId
      || candidate.parkId !== current.parkId
      || candidate.travelDate !== current.travelDate
      || candidate.status !== 'active'
      || !Number.isFinite(expiresAt)
      || expiresAt <= now.getTime()
    ) return [];
    const timeDifferenceMinutes = Math.round(Math.abs(
      Date.parse(candidate.departureTime) - Date.parse(current.departureTime),
    ) / 60_000);
    if (timeDifferenceMinutes > current.flexibleMinutes + candidate.flexibleMinutes) return [];
    const compatibleModes = compatibleCarpoolModes(
      current.travelOptions,
      candidate.travelOptions,
    );
    if (!compatibleModes.length) return [];
    const overlap = routeOverlap(current.route.polyline, candidate.route.polyline);
    if (overlap.overlap < minimumOverlap) return [];
    const overlapPercent = Math.round(overlap.overlap * 100);
    return [{
      intentId: candidate.id,
      displayName: maskedDisplayName(candidate.displayName),
      organizationName: candidate.organizationName,
      verifiedParkMember: true,
      departureTime: candidate.departureTime,
      timeDifferenceMinutes,
      overlapPercent,
      commonDistanceMeters: overlap.commonDistanceMeters,
      compatibleModes,
      originArea: approximateArea(candidate.origin.label),
      destinationArea: approximateArea(candidate.destination.label),
      freshness: freshness(candidate, now),
      explanation: `路线同向共同路段约 ${(overlap.commonDistanceMeters / 1_000).toFixed(1)} 公里，路线重合度约 ${overlapPercent}%，出发时间相差 ${timeDifferenceMinutes} 分钟。`,
    }];
  }).sort((left, right) => (
    right.overlapPercent - left.overlapPercent
    || left.timeDifferenceMinutes - right.timeDifferenceMinutes
    || right.commonDistanceMeters - left.commonDistanceMeters
    || left.intentId.localeCompare(right.intentId)
  ));
}
