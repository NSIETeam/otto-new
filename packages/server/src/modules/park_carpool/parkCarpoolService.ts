/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  buildCarpoolMatches,
  normalizeCarpoolIntentInput,
  type ParkCarpoolCoordinate,
  type ParkCarpoolIntent,
  type ParkCarpoolIntentInput,
  type ParkCarpoolMatch,
  type ParkCarpoolPlace,
  type ParkCarpoolRoute,
  type ParkCarpoolTravelOption,
} from './parkCarpoolDomain.js';

export interface ParkCarpoolPrincipal {
  accountId: string;
  organizationId: string;
  organizationName: string;
  displayName: string;
  parkId: string | null;
  active: boolean;
  parkServiceEnabled: boolean;
}

export interface ParkCarpoolStore {
  getPrincipal(accountId: string): Promise<ParkCarpoolPrincipal | null>;
  getIntent(accountId: string, travelDate?: string): Promise<ParkCarpoolIntent | null>;
  listActiveIntents(parkId: string, travelDate: string): Promise<ParkCarpoolIntent[]>;
  saveIntent(intent: ParkCarpoolIntent): Promise<ParkCarpoolIntent>;
  stopIntent(
    accountId: string,
    intentId: string,
    stoppedAt: string,
  ): Promise<ParkCarpoolIntent | null>;
}

export interface ParkCarpoolPlaceSuggestion extends ParkCarpoolPlace {
  id: string;
  address: string;
  district: string;
}

export interface ParkCarpoolMapProvider {
  readonly configured: boolean;
  searchPlaces(query: string, city?: string): Promise<ParkCarpoolPlaceSuggestion[]>;
  planDrivingRoute(
    origin: ParkCarpoolCoordinate,
    destination: ParkCarpoolCoordinate,
  ): Promise<ParkCarpoolRoute>;
}

export interface ParkCarpoolState {
  capability: 'park_carpool_v1';
  mapConfigured: boolean;
  parkId: string;
  currentIntent: ParkCarpoolIntent | null;
  matches: ParkCarpoolMatch[];
  generatedAt: string;
}

export interface ParkCarpoolPublishInput
  extends Omit<ParkCarpoolIntentInput, 'travelOptions'> {
  travelOptions: readonly ParkCarpoolTravelOption[];
}

function shanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function requirePrincipal(principal: ParkCarpoolPrincipal | null): asserts principal is ParkCarpoolPrincipal & { parkId: string } {
  if (!principal || !principal.active) throw new Error('当前账号不可用');
  if (!principal.parkServiceEnabled) throw new Error('当前企业未启用园区服务');
  if (!principal.parkId) throw new Error('当前企业尚未绑定园区');
}

function boundedRoute(route: ParkCarpoolRoute, maximumPoints = 128): ParkCarpoolRoute {
  if (route.polyline.length <= maximumPoints) return route;
  const lastIndex = route.polyline.length - 1;
  return {
    ...route,
    polyline: Array.from({ length: maximumPoints }, (_, index) => (
      route.polyline[Math.round(index * lastIndex / (maximumPoints - 1))]!
    )),
  };
}

export function createParkCarpoolService(input: {
  store: ParkCarpoolStore;
  mapProvider: ParkCarpoolMapProvider;
  createId(accountId: string, travelDate: string): string;
  now?(): Date;
  minimumOverlap?: number;
}) {
  const now = input.now ?? (() => new Date());

  async function principal(accountId: string) {
    const value = await input.store.getPrincipal(accountId);
    requirePrincipal(value);
    return value;
  }

  async function stateFor(
    actor: ParkCarpoolPrincipal & { parkId: string },
    currentIntent: ParkCarpoolIntent | null,
  ): Promise<ParkCarpoolState> {
    const generatedAt = now();
    const expiry = currentIntent ? Date.parse(currentIntent.expiresAt) : Number.NaN;
    const effectiveIntent = currentIntent?.status === 'active'
      && (!Number.isFinite(expiry) || expiry <= generatedAt.getTime())
      ? { ...currentIntent, status: 'expired' as const }
      : currentIntent;
    const candidates = effectiveIntent?.status === 'active'
      ? await input.store.listActiveIntents(actor.parkId, effectiveIntent.travelDate)
      : [];
    return {
      capability: 'park_carpool_v1',
      mapConfigured: input.mapProvider.configured,
      parkId: actor.parkId,
      currentIntent: effectiveIntent,
      matches: effectiveIntent?.status === 'active'
        ? buildCarpoolMatches(effectiveIntent, candidates, {
            minimumOverlap: input.minimumOverlap,
            now: generatedAt,
          })
        : [],
      generatedAt: generatedAt.toISOString(),
    };
  }

  async function getState(accountId: string): Promise<ParkCarpoolState> {
    const actor = await principal(accountId);
    return stateFor(actor, await input.store.getIntent(actor.accountId));
  }

  async function searchPlaces(
    accountId: string,
    query: string,
    city?: string,
  ): Promise<ParkCarpoolPlaceSuggestion[]> {
    await principal(accountId);
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 80) {
      throw new Error('地点关键词应为 2 至 80 个字符');
    }
    if (!input.mapProvider.configured) throw new Error('地图服务尚未配置');
    return input.mapProvider.searchPlaces(normalized, city?.trim() || undefined);
  }

  async function publishIntent(
    accountId: string,
    raw: ParkCarpoolPublishInput,
  ): Promise<ParkCarpoolIntent> {
    const actor = await principal(accountId);
    const currentTime = now();
    const normalized = normalizeCarpoolIntentInput({
      ...raw,
      travelOptions: [...raw.travelOptions],
    });
    if (normalized.travelDate !== shanghaiDate(currentTime)) {
      throw new Error('首发版本只支持发布当天的同行意向');
    }
    const departureAt = Date.parse(normalized.departureTime);
    if (departureAt < currentTime.getTime() - 5 * 60_000) {
      throw new Error('计划出发时间不能早于当前时间');
    }
    if (!input.mapProvider.configured) throw new Error('地图服务尚未配置');
    const route = boundedRoute(await input.mapProvider.planDrivingRoute(
      normalized.origin.coordinate,
      normalized.destination.coordinate,
    ));
    if (route.polyline.length < 2 || route.distanceMeters <= 0) {
      throw new Error('地图服务未返回可用于匹配的路线');
    }
    const existing = await input.store.getIntent(actor.accountId, normalized.travelDate);
    const timestamp = currentTime.toISOString();
    const intent: ParkCarpoolIntent = {
      ...normalized,
      id: existing?.id ?? input.createId(actor.accountId, normalized.travelDate),
      accountId: actor.accountId,
      organizationId: actor.organizationId,
      organizationName: actor.organizationName,
      displayName: actor.displayName,
      parkId: actor.parkId,
      route,
      status: 'active',
      lastConfirmedAt: timestamp,
      expiresAt: new Date(
        departureAt + normalized.flexibleMinutes * 60_000,
      ).toISOString(),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    return input.store.saveIntent(intent);
  }

  async function stopIntent(
    accountId: string,
    intentId: string,
  ): Promise<ParkCarpoolIntent> {
    const actor = await principal(accountId);
    const stopped = await input.store.stopIntent(
      actor.accountId,
      intentId.trim(),
      now().toISOString(),
    );
    if (!stopped) throw new Error('无权停止该同行意向或意向不存在');
    return stopped;
  }

  async function refreshMatches(accountId: string): Promise<ParkCarpoolState> {
    const actor = await principal(accountId);
    const current = await input.store.getIntent(actor.accountId);
    return stateFor(actor, current);
  }

  return {
    getState,
    searchPlaces,
    publishIntent,
    stopIntent,
    refreshMatches,
  };
}
