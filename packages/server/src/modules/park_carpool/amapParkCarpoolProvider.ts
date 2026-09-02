/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  ParkCarpoolCoordinate,
  ParkCarpoolRoute,
} from './parkCarpoolDomain.js';
import type {
  ParkCarpoolMapProvider,
  ParkCarpoolPlaceSuggestion,
} from './parkCarpoolService.js';

interface AmapResponse {
  status?: unknown;
  info?: unknown;
  pois?: unknown;
  route?: unknown;
}

function parseCoordinate(value: unknown): ParkCarpoolCoordinate | null {
  if (typeof value !== 'string') return null;
  const [longitude, latitude] = value.split(',').map(Number);
  if (
    !Number.isFinite(longitude) || !Number.isFinite(latitude)
    || longitude! < -180 || longitude! > 180
    || latitude! < -90 || latitude! > 90
  ) return null;
  return { longitude: longitude!, latitude: latitude! };
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coordinateParameter(value: ParkCarpoolCoordinate): string {
  return `${value.longitude.toFixed(6)},${value.latitude.toFixed(6)}`;
}

function assertAmapSuccess(value: AmapResponse): void {
  if (value.status !== '1') throw new Error('地图服务暂时不可用，请稍后重试');
}

async function request(
  fetchImpl: typeof fetch,
  url: URL,
): Promise<AmapResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new Error('地图服务连接失败，请稍后重试');
  }
  if (!response.ok) throw new Error('地图服务暂时不可用，请稍后重试');
  let body: AmapResponse;
  try {
    body = await response.json() as AmapResponse;
  } catch {
    throw new Error('地图服务返回了无法识别的数据');
  }
  assertAmapSuccess(body);
  return body;
}

/**
 * Server-only AMap Web Service adapter. The key never crosses IPC/renderer.
 * Route-derived caching must remain disabled until the deployment operator has
 * confirmed the map provider's licensing terms.
 */
export function createAmapParkCarpoolProvider(input: {
  key: string | null | undefined;
  fetchImpl?: typeof fetch;
}): ParkCarpoolMapProvider {
  const key = input.key?.trim() || '';
  const fetchImpl = input.fetchImpl ?? fetch;
  const configured = Boolean(key);

  function requireConfigured(): void {
    if (!configured) throw new Error('地图服务尚未配置');
  }

  return {
    configured,
    async searchPlaces(query, city): Promise<ParkCarpoolPlaceSuggestion[]> {
      requireConfigured();
      const url = new URL('https://restapi.amap.com/v3/place/text');
      url.search = new URLSearchParams({
        key,
        keywords: query,
        offset: '12',
        page: '1',
        extensions: 'base',
        ...(city ? { city, citylimit: 'true' } : {}),
      }).toString();
      const response = await request(fetchImpl, url);
      const pois = Array.isArray(response.pois) ? response.pois : [];
      return pois.flatMap((raw): ParkCarpoolPlaceSuggestion[] => {
        if (!raw || typeof raw !== 'object') return [];
        const poi = raw as Record<string, unknown>;
        const id = string(poi.id);
        const label = string(poi.name);
        const coordinate = parseCoordinate(poi.location);
        if (!id || !label || !coordinate) return [];
        return [{
          id,
          label,
          coordinate,
          address: string(poi.address),
          district: string(poi.adname),
        }];
      });
    },
    async planDrivingRoute(origin, destination): Promise<ParkCarpoolRoute> {
      requireConfigured();
      const url = new URL('https://restapi.amap.com/v3/direction/driving');
      url.search = new URLSearchParams({
        key,
        origin: coordinateParameter(origin),
        destination: coordinateParameter(destination),
        strategy: '0',
        extensions: 'base',
      }).toString();
      const response = await request(fetchImpl, url);
      const route = response.route && typeof response.route === 'object'
        ? response.route as Record<string, unknown>
        : {};
      const path = Array.isArray(route.paths) && route.paths[0]
        && typeof route.paths[0] === 'object'
        ? route.paths[0] as Record<string, unknown>
        : null;
      if (!path) throw new Error('地图服务未返回可用路线');
      const points = (Array.isArray(path.steps) ? path.steps : []).flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const polyline = string((raw as Record<string, unknown>).polyline);
        return polyline.split(';').flatMap((item) => {
          const parsed = parseCoordinate(item);
          return parsed ? [parsed] : [];
        });
      });
      const polyline = points.filter((point, index) => {
        const previous = points[index - 1];
        return !previous
          || previous.longitude !== point.longitude
          || previous.latitude !== point.latitude;
      });
      const distanceMeters = Number(path.distance);
      const durationSeconds = Number(path.duration);
      if (
        polyline.length < 2
        || !Number.isFinite(distanceMeters) || distanceMeters <= 0
        || !Number.isFinite(durationSeconds) || durationSeconds <= 0
      ) throw new Error('地图服务未返回可用于匹配的路线');
      return {
        provider: 'amap',
        distanceMeters: Math.round(distanceMeters),
        durationSeconds: Math.round(durationSeconds),
        polyline,
      };
    },
  };
}
