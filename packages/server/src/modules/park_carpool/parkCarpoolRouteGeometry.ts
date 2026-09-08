/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import type { ParkCarpoolRoute } from './parkCarpoolDomain.js';

// Engineering safety limits, not product-approved road-network thresholds.
const MAX_PROVIDER_POINTS = 20_000;
const MAX_MATCHING_POINTS = 2_048;
const MAX_DEVIATION_METERS = 0.5;

/** Preserve bends rather than selecting equally spaced array indices. */
export function boundCarpoolRoute(route: ParkCarpoolRoute): ParkCarpoolRoute {
  if (
    !Array.isArray(route.polyline) ||
    route.polyline.length < 2 ||
    route.polyline.length > MAX_PROVIDER_POINTS ||
    !Number.isFinite(route.distanceMeters) ||
    route.distanceMeters <= 0 ||
    !Number.isFinite(route.durationSeconds) ||
    route.durationSeconds < 0 ||
    route.polyline.some(
      (point) =>
        !point ||
        !Number.isFinite(point.longitude) ||
        !Number.isFinite(point.latitude) ||
        Math.abs(point.longitude) > 180 ||
        Math.abs(point.latitude) > 90,
    )
  ) {
    throw new Error('地图服务返回的路线无效或超出处理范围，请重新规划');
  }
  const polyline = route.polyline.filter(
    (point, index, source) =>
      index === 0 ||
      point.longitude !== source[index - 1]!.longitude ||
      point.latitude !== source[index - 1]!.latitude,
  );
  if (polyline.length < 2)
    throw new Error('地图服务返回的路线没有有效路段，请重新规划');
  const longitudeScale =
    111_320 * Math.cos((polyline[0]!.latitude * Math.PI) / 180);
  const points = polyline.map((point) => ({
    x: point.longitude * longitudeScale,
    y: point.latitude * 111_320,
  }));
  const keep = new Set([0, points.length - 1]);
  // Distance-only simplification erases a collinear U-turn. Such turns are
  // mandatory anchors because direction is part of the matching contract.
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const c = points[index + 1]!;
    if ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0)
      keep.add(index);
  }
  if (keep.size > MAX_MATCHING_POINTS)
    throw new Error('路线过于复杂，无法保留方向，请重新规划');
  const anchors = [...keep].sort((a, b) => a - b);
  const pending: Array<[number, number]> = anchors
    .slice(1)
    .map((end, index) => [anchors[index]!, end]);
  while (pending.length) {
    const [start, end] = pending.pop()!;
    const a = points[start]!;
    const b = points[end]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let maximum = MAX_DEVIATION_METERS * MAX_DEVIATION_METERS;
    let furthest = -1;
    for (let index = start + 1; index < end; index += 1) {
      const point = points[index]!;
      const t =
        lengthSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                1,
                ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
              ),
            );
      const deviation =
        (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
      if (deviation > maximum) {
        maximum = deviation;
        furthest = index;
      }
    }
    if (furthest < 0) continue;
    keep.add(furthest);
    if (keep.size > MAX_MATCHING_POINTS) {
      throw new Error(
        '路线过于复杂，无法在保留路线形状的前提下匹配，请重新规划',
      );
    }
    pending.push([start, furthest], [furthest, end]);
  }
  return {
    ...route,
    polyline: [...keep].sort((a, b) => a - b).map((index) => polyline[index]!),
  };
}
