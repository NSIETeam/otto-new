/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import {
  distanceMeters,
  routeOverlap,
  type ParkCarpoolCoordinate,
} from './parkCarpoolDomain.js';
export interface CarpoolRoutePreview {
  hiddenEndpointRadiusMeters: 1000;
  segments: Array<{
    route: number;
    shared: boolean;
    coverage: 'all' | 'partial' | 'solo';
    points: Array<{ x: number; y: number }>;
  }>;
  divergences: Array<{ x: number; y: number }>;
  explanation: string;
}
export function buildCarpoolRoutePreview(
  current: ParkCarpoolCoordinate[],
  others: ParkCarpoolCoordinate[][],
): CarpoolRoutePreview {
  const routes = [current, ...others];
  const endpoints = routes.flatMap((route) =>
    route.length ? [route[0]!, route.at(-1)!] : [],
  );
  const safe = (point: ParkCarpoolCoordinate) =>
    endpoints.every((endpoint) => distanceMeters(endpoint, point) > 1300);
  const pieces: Array<{
    route: number;
    shared: boolean;
    coverage: 'all' | 'partial' | 'solo';
    points: ParkCarpoolCoordinate[];
  }> = [];
  for (const [index, route] of routes.entries()) {
    const total = route
      .slice(1)
      .reduce((sum, p, i) => sum + distanceMeters(route[i]!, p), 0);
    const step = Math.max(100, total / 300);
    for (let vertex = 1; vertex < route.length; vertex++) {
      const from = route[vertex - 1]!;
      const to = route[vertex]!;
      const count = Math.max(1, Math.ceil(distanceMeters(from, to) / step));
      for (let part = 0; part < count; part++) {
        const point = (ratio: number) => ({
          longitude: from.longitude + (to.longitude - from.longitude) * ratio,
          latitude: from.latitude + (to.latitude - from.latitude) * ratio,
        });
        const a = point(part / count);
        const b = point((part + 1) / count);
        if (!safe(a) || !safe(b)) continue;
        const sharedWith = routes
          .filter((_, routeIndex) => routeIndex !== index)
          .filter(
            (other) =>
              routeOverlap([a, b], other).commonDistanceMeters >
              distanceMeters(a, b) * 0.5,
          );
        const coverage =
          sharedWith.length === routes.length - 1
            ? ('all' as const)
            : sharedWith.length
              ? ('partial' as const)
              : ('solo' as const);
        const shared = sharedWith.length > 0;
        const coarse = [a, b].map((p) => ({
          longitude: Math.round(p.longitude * 500) / 500,
          latitude: Math.round(p.latitude * 500) / 500,
        }));
        pieces.push({ route: index, shared, coverage, points: coarse });
      }
    }
  }
  const points = pieces.flatMap((p) => p.points);
  const longitudes = points.map((p) => p.longitude);
  const latitudes = points.map((p) => p.latitude);
  const minX = Math.min(...longitudes);
  const maxX = Math.max(...longitudes);
  const minY = Math.min(...latitudes);
  const maxY = Math.max(...latitudes);
  const width = Math.max(maxX - minX, 0.002);
  const height = Math.max(maxY - minY, 0.002);
  const transform = (p: ParkCarpoolCoordinate) => ({
    x: Math.round(30 + ((p.longitude - minX) / width) * 540),
    y: Math.round(370 - ((p.latitude - minY) / height) * 340),
  });
  const segments = pieces.map((p) => ({
    ...p,
    points: p.points.map(transform),
  }));
  const divergences = segments.flatMap((segment, index) => {
    const previous = segments[index - 1];
    return previous &&
      previous.route === segment.route &&
      previous.coverage !== segment.coverage &&
      Math.hypot(
        previous.points[1]!.x - segment.points[0]!.x,
        previous.points[1]!.y - segment.points[0]!.y,
      ) < 20
      ? [segment.points[0]!]
      : [];
  });
  return {
    hiddenEndpointRadiusMeters: 1000,
    segments,
    divergences,
    explanation: segments.length
      ? '深色实线为双方或全员共同方向，浅色虚线为部分成员共同方向，灰色为各自单独路段；圆点标记主要分岔。所有人的端点周围至少 1 公里已隐藏，线形已粗化，不提供住宅坐标或逐路口导航。'
      : '路线位于端点隐私保护范围内，无法安全展示图形；请参考同路里程和时间说明。',
  };
}
