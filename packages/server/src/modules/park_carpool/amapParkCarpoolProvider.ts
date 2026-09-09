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
  tips?: unknown;
  route?: unknown;
  locations?: unknown;
  regeocode?: unknown;
}

function parseCoordinate(value: unknown): ParkCarpoolCoordinate | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2 || parts.some(part => !part.trim())) return null;
  const [longitude, latitude] = parts.map(Number);
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude! < -180 ||
    longitude! > 180 ||
    latitude! < -90 ||
    latitude! > 90
  )
    return null;
  return { longitude: longitude!, latitude: latitude! };
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function coordinateParameter(value: ParkCarpoolCoordinate): string {
  return `${value.longitude.toFixed(6)},${value.latitude.toFixed(6)}`;
}

function assertAmapSuccess(value: AmapResponse): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== '1') throw new Error('地图服务暂时不可用，请稍后重试');
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
    body = (await response.json()) as AmapResponse;
  } catch {
    throw new Error('地图服务返回了无法识别的数据');
  }
  assertAmapSuccess(body);
  return body;
}

/** Server-only deployment credential. Never ship a shared key in application code. */
export function resolveAmapWebServiceKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.OTTO_AMAP_WEB_SERVICE_KEY?.trim() ?? '';
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
  // Public POI suggestions only: bounded, memory-only, never route or account data.
  const suggestions = new Map<string, { expires: number; result: Promise<ParkCarpoolPlaceSuggestion[]> }>();

  function requireConfigured(): void {
    if (!configured) throw new Error('地图服务尚未配置');
  }

  return {
    configured,
    async reverseGeocode(coordinate, system = 'autonavi') {
      requireConfigured();
      if (system === 'gps') {
        const url = new URL(
          'https://restapi.amap.com/v3/assistant/coordinate/convert',
        );
        url.search = new URLSearchParams({
          key,
          locations: coordinateParameter(coordinate),
          coordsys: 'gps',
        }).toString();
        const converted = parseCoordinate(
          (await request(fetchImpl, url)).locations,
        );
        if (!converted) throw new Error('地图坐标转换失败');
        coordinate = converted;
      }
      const url = new URL('https://restapi.amap.com/v3/geocode/regeo');
      url.search = new URLSearchParams({
        key,
        location: coordinateParameter(coordinate),
        extensions: 'base',
        radius: '1000',
      }).toString();
      const response = await request(fetchImpl, url);
      const geo = response.regeocode as
        | {
            formatted_address?: unknown;
            addressComponent?: {
              province?: unknown;
              city?: unknown;
              district?: unknown;
              adcode?: unknown;
            };
          }
        | undefined;
      const component = geo?.addressComponent;
      const code = string(component?.adcode);
      const label = [
        ...new Set(
          [
            string(component?.province),
            string(component?.city),
            string(component?.district),
          ].filter(Boolean),
        ),
      ].join('');
      if (!/^[0-9]{6}$/.test(code) || !label)
        throw new Error('地图服务未返回标准行政区域，请重新选点');
      return {
        id: `point:${coordinateParameter(coordinate)}`,
        label: string(geo?.formatted_address) || label,
        address: '地图选定位置',
        district: string(component?.district),
        coordinate,
        publicArea: { label, code, precision: 'district' as const },
      };
    },
    async staticMap(coordinate, zoom) {
      requireConfigured();
      const url = new URL('https://restapi.amap.com/v3/staticmap');
      url.search = new URLSearchParams({
        key,
        location: coordinateParameter(coordinate),
        zoom: String(zoom),
        size: '600*400',
        scale: '1',
      }).toString();
      let response: Response;
      try {
        response = await fetchImpl(url, {signal: AbortSignal.timeout(8000)});
      } catch {
        throw new Error('地图服务连接失败，请稍后重试');
      }
      if (!response.ok) throw new Error('地图图片暂时不可用');
      const type = response.headers.get('content-type')?.split(';')[0];
      if (type !== 'image/png' && type !== 'image/jpeg')
        throw new Error('地图服务未返回有效图片');
      if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024)
        throw new Error('地图图片过大');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('地图图片为空');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 4 * 1024 * 1024) throw new Error('地图图片过大');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = Buffer.concat(chunks);
      if (!bytes.length) throw new Error('地图图片为空');
      return `data:${type};base64,${bytes.toString('base64')}`;
    },
    async searchPlaces(query, city): Promise<ParkCarpoolPlaceSuggestion[]> {
      requireConfigured();
      const cacheKey = JSON.stringify([query, city ?? '']);
      const cached = suggestions.get(cacheKey);
      if (cached && cached.expires > Date.now()) return cached.result;
      const lookup = async (): Promise<ParkCarpoolPlaceSuggestion[]> => {
        const url = new URL('https://restapi.amap.com/v3/assistant/inputtips');
        url.search = new URLSearchParams({
          key,
          keywords: query,
          datatype: 'poi',
          ...(city ? { city, citylimit: 'true' } : {}),
        }).toString();
        const response = await request(fetchImpl, url);
        const pois = Array.isArray(response.tips) ? response.tips : [];
        return pois.flatMap((raw): ParkCarpoolPlaceSuggestion[] => {
          if (!raw || typeof raw !== 'object') return [];
          const poi = raw as Record<string, unknown>;
          const id = string(poi.id);
          const label = string(poi.name);
          const coordinate = parseCoordinate(poi.location);
          if (!id || !label || !coordinate) return [];
          return [
            {
              id,
              label,
              coordinate,
              address: string(poi.address),
              district: string(poi.district),
            },
          ];
        });
      };
      const result = lookup();
      const entry = { expires: Number.POSITIVE_INFINITY, result };
      suggestions.delete(cacheKey);
      suggestions.set(cacheKey, entry);
      if (suggestions.size > 64) suggestions.delete(suggestions.keys().next().value!);
      void result.then(() => { entry.expires = Date.now() + 30_000; }, () => {
        if (suggestions.get(cacheKey) === entry) suggestions.delete(cacheKey);
      });
      return result;
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
      const route =
        response.route && typeof response.route === 'object'
          ? (response.route as Record<string, unknown>)
          : {};
      const path =
        Array.isArray(route.paths) &&
        route.paths[0] &&
        typeof route.paths[0] === 'object'
          ? (route.paths[0] as Record<string, unknown>)
          : null;
      if (!path) throw new Error('地图服务未返回可用路线');
      const points = (Array.isArray(path.steps) ? path.steps : []).flatMap(
        (raw) => {
          if (!raw || typeof raw !== 'object') return [];
          const polyline = string((raw as Record<string, unknown>).polyline);
          return polyline.split(';').flatMap((item) => {
            const parsed = parseCoordinate(item);
            return parsed ? [parsed] : [];
          });
        },
      );
      const polyline = points.filter((point, index) => {
        const previous = points[index - 1];
        return (
          !previous ||
          previous.longitude !== point.longitude ||
          previous.latitude !== point.latitude
        );
      });
      const distanceMeters = Number(path.distance);
      const durationSeconds = Number(path.duration);
      if (
        polyline.length < 2 ||
        !Number.isFinite(distanceMeters) ||
        distanceMeters <= 0 ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0
      )
        throw new Error('地图服务未返回可用于匹配的路线');
      return {
        provider: 'amap',
        distanceMeters: Math.round(distanceMeters),
        durationSeconds: Math.round(durationSeconds),
        polyline,
      };
    },
  };
}
