import { carpoolMeasurement } from './parkCarpoolMetrics.js';
import {
  createCarpoolResultPage,
  type CarpoolResultsQuery,
} from './parkCarpoolResults.js';
import {
  readCarpoolConfig,
  carpoolCommunicationCapabilities,
} from './parkCarpoolConfig.js';
import { buildCarpoolRoutePreview } from './parkCarpoolRoutePreview.js';
import {
  createParkCarpoolTransport,
  type ParkTransportCommand,
  type ParkTransportProof,
} from './parkCarpoolTransport.js';
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createCarpoolWorkflow,
  type CarpoolWorkflowCommand,
  type CarpoolWorkflowContext,
} from './parkCarpoolWorkflow.js';
import { createHash, randomUUID } from 'node:crypto';
import { boundCarpoolRoute } from './parkCarpoolRouteGeometry.js';
import {
  withPublication,
  type PublicationStore,
  type PublicationRecord,
} from './parkCarpoolPublication.js';

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
  parkAdmin?: boolean;
}

export interface ParkCarpoolStore {
  maintain?(
    input: import('./parkCarpoolRetention.js').CarpoolMaintenanceInput,
  ): Promise<import('./parkCarpoolRetention.js').CarpoolMaintenanceResult>;
  transactWorkflow?<T>(
    parkId: string,
    actorId: string,
    operation: (context: CarpoolWorkflowContext) => T,
  ): Promise<T>;
  publications?: PublicationStore;
  getPrincipal(accountId: string): Promise<ParkCarpoolPrincipal | null>;
  getIntent(
    accountId: string,
    travelDate?: string,
  ): Promise<ParkCarpoolIntent | null>;
  listActiveIntents(
    parkId: string,
    travelDate: string,
  ): Promise<ParkCarpoolIntent[]>;
  listIntentPage?(
    parkId: string,
    travelDate: string,
    afterId?: string,
    limit?: number,
  ): Promise<{
    intents: ParkCarpoolIntent[];
    nextCursor?: string;
    failedCount: number;
  }>;
  saveIntent(
    intent: ParkCarpoolIntent,
    expectedVersion?: number | null,
    publication?: { key: string; record: PublicationRecord },
  ): Promise<ParkCarpoolIntent>;
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
  reverseGeocode?(
    coordinate: ParkCarpoolCoordinate,
    system?: 'gps' | 'autonavi',
  ): Promise<ParkCarpoolPlaceSuggestion>;
  staticMap?(coordinate: ParkCarpoolCoordinate, zoom: number): Promise<string>;
  searchPlaces(
    query: string,
    city?: string,
  ): Promise<ParkCarpoolPlaceSuggestion[]>;
  planDrivingRoute(
    origin: ParkCarpoolCoordinate,
    destination: ParkCarpoolCoordinate,
  ): Promise<ParkCarpoolRoute>;
}

export interface ParkCarpoolState {
  searchStatus?:
    'searching' | 'needs_confirmation' | 'not_accepting' | 'inactive';
  capability: 'park_carpool_v1';
  mapConfigured: boolean;
  parkId: string;
  currentIntent: ParkCarpoolIntent | null;
  capabilities?: string[];
  hasGroup?: boolean;
  parkAdmin?: boolean;
  meetingPoints?: Array<import('./parkCarpoolWorkflow.js').CarpoolMeetingPoint>;
  matches: ParkCarpoolMatch[];
  groupMatches?: Array<
    import('./parkCarpoolGroupMatching.js').CarpoolGroupMatch
  >;
  generatedAt: string;
  failedCandidateCount?: number;
  resultPage?: { total: number; nextCursor?: string };
}

export interface ParkCarpoolPublishInput extends Omit<
  ParkCarpoolIntentInput,
  'travelOptions'
> {
  travelOptions: readonly ParkCarpoolTravelOption[];
  expectedVersion?: number | null;
  requestKey?: string;
}

function shanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function requirePrincipal(
  principal: ParkCarpoolPrincipal | null,
): asserts principal is ParkCarpoolPrincipal & { parkId: string } {
  if (!principal || !principal.active) throw new Error('当前账号不可用');
  if (!principal.parkServiceEnabled) throw new Error('当前企业未启用园区服务');
  if (!principal.parkId) throw new Error('当前企业尚未绑定园区');
}

export function createParkCarpoolService(input: {
  store: ParkCarpoolStore;
  mapProvider: ParkCarpoolMapProvider;
  createId(accountId: string, travelDate: string): string;
  now?(): Date;
  minimumOverlap?: number;
}) {
  const config = readCarpoolConfig();
  let maintenanceCursor = '';
  const now = input.now ?? (() => new Date());

  async function principal(accountId: string) {
    const value = await input.store.getPrincipal(accountId);
    requirePrincipal(value);
    return value;
  }

  async function measure(
    accountId: string,
    change: (row: ReturnType<typeof carpoolMeasurement>) => void,
  ) {
    if (!input.store.transactWorkflow) return;
    await createCarpoolWorkflow({ store: input.store, now })
      .withContext(accountId, (ctx) =>
        change(carpoolMeasurement(ctx.state, accountId, now().toISOString())),
      )
      .catch(() => console.warn('Carpool operational metrics unavailable'));
  }
  async function mapCall<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    let failed = false;
    try {
      return await operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await measure(accountId, (row) => {
        row.mapCalls++;
        row.mapFailures += Number(failed);
        row.mapMilliseconds += Math.max(0, performance.now() - start);
      });
    }
  }
  async function stateFor(
    actor: ParkCarpoolPrincipal & { parkId: string },
    currentIntent: ParkCarpoolIntent | null,
    query: CarpoolResultsQuery = {},
    targetIntentId?: string,
  ): Promise<ParkCarpoolState> {
    const generatedAt = now();
    const expiry = currentIntent
      ? Date.parse(currentIntent.expiresAt)
      : Number.NaN;
    const effectiveIntent =
      currentIntent?.status === 'active' &&
      (!Number.isFinite(expiry) || expiry <= generatedAt.getTime())
        ? { ...currentIntent, status: 'expired' as const }
        : currentIntent;
    const workflow = input.store.transactWorkflow
      ? await createCarpoolWorkflow({ store: input.store, now }).read(
          actor.accountId,
        )
      : null;
    const excluded = new Set([
      ...(workflow?.blockedAccountIds ?? []),
      ...(workflow?.groupedAccountIds ?? []),
      ...(workflow?.unavailableAccountIds ?? []),
    ]);
    const resultPage = createCarpoolResultPage(query, targetIntentId);
    let failedCandidateCount = 0;
    const collect = (candidates: ParkCarpoolIntent[]) => {
      if (effectiveIntent?.status !== 'active' || excluded.has(actor.accountId))
        return;
      for (const match of buildCarpoolMatches(
        effectiveIntent,
        candidates.filter((candidate) => !excluded.has(candidate.accountId)),
        {
          minimumOverlap: input.minimumOverlap,
          now: generatedAt,
          onCandidateError: () => {
            failedCandidateCount++;
          },
        },
      ))
        resultPage.add(match);
    };
    if (effectiveIntent?.status === 'active') {
      if (input.store.listIntentPage) {
        let cursor: string | undefined;
        do {
          const page = await input.store.listIntentPage(
            actor.parkId,
            effectiveIntent.travelDate,
            cursor,
            200,
          );
          collect(page.intents);
          failedCandidateCount += page.failedCount;
          if (page.nextCursor && page.nextCursor === cursor)
            throw new Error('候选分页未前进，请稍后重试');
          cursor = page.nextCursor;
          if (cursor)
            await new Promise<void>((resolve) => setImmediate(resolve));
        } while (cursor);
      } else
        collect(
          await input.store.listActiveIntents(
            actor.parkId,
            effectiveIntent.travelDate,
          ),
        );
    }
    const groups = input.store.transactWorkflow
      ? await createCarpoolWorkflow({
          store: input.store,
          now,
          mapProvider: input.mapProvider,
        }).groupMatches(actor.accountId, (match) => resultPage.add(match))
      : { failedCount: 0 };
    const page = resultPage.finish();
    for(const match of page.results){
      const pending=workflow?.requests.find(request=>['pending','ignored'].includes(request.status)&&request.intentBindings.some(binding=>binding.intentId===match.intentId));
      if(pending)match.pendingRequest=pending.senderAccountId===actor.accountId?'sent':'received';
    }
    const matches = page.results.filter((match) => !('groupId' in match));
    const groupMatches = page.results.filter(
      (
        match,
      ): match is import('./parkCarpoolGroupMatching.js').CarpoolGroupMatch =>
        'groupId' in match,
    );
    if (input.store.transactWorkflow && effectiveIntent?.status === 'active') {
      await createCarpoolWorkflow({ store: input.store, now }).withContext(
        actor.accountId,
        (ctx) => {
          if (
            !ctx.intents.some(
              (intent) =>
                intent.id === effectiveIntent.id &&
                intent.version === effectiveIntent.version,
            )
          )
            return;
          if (!query.cursor && !targetIntentId) {
            const measurement = carpoolMeasurement(
              ctx.state,
              actor.accountId,
              generatedAt.toISOString(),
            );
            measurement.candidateSamples++;
            measurement.candidateTotal += page.total;
            measurement.matched ||= page.total > 0;
          }
          const results = [
            ...matches.map((match) => ({
              id: match.intentId,
              version: match.candidateVersion,
            })),
            ...groupMatches.map((match) => ({
              id: match.groupId,
              version: match.groupVersion,
            })),
          ];
          for (const result of results) {
            const id = `new-match:${effectiveIntent.id}:${result.id}:${result.version ?? 0}`;
            if (
              !ctx.state.notices.some(
                (notice) =>
                  notice.id === id && notice.accountId === actor.accountId,
              )
            )
              ctx.state.notices.push({
                id,
                accountId: actor.accountId,
                type: 'new_match',
                subjectId: effectiveIntent.id,
                text: '发现新的同行结果，请刷新后查看最新路线与时间条件',
                createdAt: generatedAt.toISOString(),
              });
          }
        },
      );
    }
    return {
      capabilities: carpoolCommunicationCapabilities(),
      hasGroup: Boolean(workflow?.myGroup),
      parkAdmin: Boolean(actor.parkAdmin),
      meetingPoints: workflow?.meetingPoints ?? [],
      groupMatches,
      resultPage: { total: page.total, nextCursor: page.nextCursor },
      failedCandidateCount: failedCandidateCount + groups.failedCount,
      capability: 'park_carpool_v1',
      mapConfigured: input.mapProvider.configured,
      parkId: actor.parkId,
      currentIntent: effectiveIntent,
      searchStatus:
        effectiveIntent?.status !== 'active'
          ? 'inactive'
          : workflow?.unavailableAccountIds.includes(actor.accountId)
            ? 'not_accepting'
            : generatedAt.getTime() -
                  Date.parse(effectiveIntent.lastConfirmedAt) >
                config.pauseMinutes * 60_000
              ? 'needs_confirmation'
              : 'searching',
      matches,
      generatedAt: generatedAt.toISOString(),
    };
  }

  async function getState(
    accountId: string,
    query: CarpoolResultsQuery = {},
  ): Promise<ParkCarpoolState> {
    const actor = await principal(accountId);
    return stateFor(actor, await input.store.getIntent(actor.accountId), query);
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
    return mapCall(accountId, () =>
      input.mapProvider.searchPlaces(normalized, city?.trim() || undefined),
    );
  }

  async function performPublish(
    accountId: string,
    raw: ParkCarpoolPublishInput,
    publication?: { key: string; record: PublicationRecord },
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
    if (shanghaiDate(new Date(departureAt)) !== normalized.travelDate) {
      throw new Error('出发时间与出行日期不一致（北京时间）');
    }
    if (departureAt < currentTime.getTime() - 5 * 60_000) {
      throw new Error('计划出发时间不能早于当前时间');
    }
    if (!input.mapProvider.configured) throw new Error('地图服务尚未配置');
    const before = await input.store.getIntent(
      actor.accountId,
      normalized.travelDate,
    );
    const requestHash = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
    if (
      raw.requestKey !== undefined &&
      !/^[A-Za-z0-9_-]{8,100}$/u.test(raw.requestKey)
    )
      throw new Error('发布请求标识无效');
    if (raw.requestKey && before?.requestKey === raw.requestKey) {
      if (before.requestHash !== requestHash)
        throw new Error('同一发布请求标识不能用于不同内容');
      return before;
    }
    if (
      raw.expectedVersion !== undefined &&
      raw.expectedVersion !== (before?.version ?? null)
    ) {
      throw new Error('同行意向已更新，请刷新后重试');
    }
    const route = boundCarpoolRoute(
      await mapCall(accountId, () =>
        input.mapProvider.planDrivingRoute(
          normalized.origin.coordinate,
          normalized.destination.coordinate,
        ),
      ),
    );
    if (route.polyline.length < 2 || route.distanceMeters <= 0) {
      throw new Error('地图服务未返回可用于匹配的路线');
    }
    if (input.mapProvider.reverseGeocode) {
      const [origin, destination] = await Promise.all([
        mapCall(accountId, () =>
          input.mapProvider.reverseGeocode!(normalized.origin.coordinate),
        ),
        mapCall(accountId, () =>
          input.mapProvider.reverseGeocode!(normalized.destination.coordinate),
        ),
      ]);
      normalized.origin.publicArea = origin.publicArea;
      normalized.destination.publicArea = destination.publicArea;
    }
    const existing = await input.store.getIntent(
      actor.accountId,
      normalized.travelDate,
    );
    const latestActor = await principal(accountId);
    if (
      latestActor.parkId !== actor.parkId ||
      latestActor.organizationId !== actor.organizationId
    ) {
      throw new Error('园区身份已变化，请重新发布');
    }
    if (JSON.stringify(existing) !== JSON.stringify(before)) {
      throw new Error('同行意向已更新或停止，请刷新后重试');
    }
    if (
      shanghaiDate(now()) !== normalized.travelDate ||
      departureAt < now().getTime() - 5 * 60_000
    ) {
      throw new Error('计划出发时间已失效，请重新选择');
    }
    const timestamp = now().toISOString();
    const intent: ParkCarpoolIntent = {
      ...normalized,
      requestKey: raw.requestKey,
      requestHash,
      id:
        existing?.id ?? input.createId(actor.accountId, normalized.travelDate),
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
    const saved = await input.store.saveIntent(
      intent,
      before?.version ?? null,
      publication,
    );
    await measure(accountId, (row) => {
      row.published = true;
    });
    return saved;
  }

  async function publishIntent(
    accountId: string,
    raw: ParkCarpoolPublishInput,
  ): Promise<ParkCarpoolIntent> {
    const actor = await principal(accountId);
    if (!input.store.publications) return performPublish(accountId, raw);
    const requestKey = raw.requestKey ?? randomUUID();
    raw = { ...raw, requestKey };
    if (!/^[A-Za-z0-9_-]{8,100}$/u.test(requestKey))
      throw new Error('发布请求标识无效');
    const normalized = normalizeCarpoolIntentInput({
      ...raw,
      travelOptions: [...raw.travelOptions],
    });
    const hash = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
    const receipt = await withPublication(
      input.store.publications,
      accountId,
      requestKey,
      hash,
      (publication) => performPublish(accountId, raw, publication),
    );
    const latest = await principal(accountId);
    if (
      receipt.parkId !== actor.parkId ||
      receipt.organizationId !== actor.organizationId ||
      latest.parkId !== receipt.parkId ||
      latest.organizationId !== receipt.organizationId
    )
      throw new Error('园区身份已变化，请重新发布');
    return receipt;
  }

  async function stopIntent(
    accountId: string,
    intentId: string,
  ): Promise<ParkCarpoolIntent> {
    const actor = await principal(accountId);
    if (input.store.transactWorkflow) {
      await workflow.execute(accountId, {
        type: 'stop',
        intentId: intentId.trim(),
      });
      const result = await input.store.getIntent(accountId);
      if (!result) throw new Error('同行意向不可用');
      return result;
    }
    const stopped = await input.store.stopIntent(
      actor.accountId,
      intentId.trim(),
      now().toISOString(),
    );
    if (!stopped) throw new Error('无权停止该同行意向或意向不存在');
    return stopped;
  }

  async function confirmIntent(
    accountId: string,
    intentId: string,
  ): Promise<ParkCarpoolIntent> {
    const actor = await principal(accountId);
    const current = await input.store.getIntent(actor.accountId);
    if (
      !current ||
      current.id !== intentId ||
      current.parkId !== actor.parkId ||
      current.organizationId !== actor.organizationId ||
      current.status !== 'active' ||
      Date.parse(current.expiresAt) <= now().getTime()
    )
      throw new Error('没有有效的寻找意向，已停止或过期的行程请重新发布');
    const timestamp = now().toISOString();
    return input.store.saveIntent(
      { ...current, lastConfirmedAt: timestamp, updatedAt: timestamp },
      current.version,
    );
  }

  async function refreshMatches(
    accountId: string,
    query: CarpoolResultsQuery = {},
  ): Promise<ParkCarpoolState> {
    const actor = await principal(accountId);
    const current = await input.store.getIntent(actor.accountId);
    return stateFor(actor, current, query);
  }

  const workflow = createCarpoolWorkflow({
    store: input.store,
    now,
    mapProvider: input.mapProvider,
    minimumOverlap: input.minimumOverlap,
  });
  function publicWorkflow(value: Awaited<ReturnType<typeof workflow.read>>) {
    const {
      groupedAccountIds: _grouped,
      unavailableAccountIds: _unavailable,
      ...publicValue
    } = value;
    return publicValue;
  }
  return {
    maintain: async () => {
      if (!input.store.maintain) throw new Error('同行生命周期存储不可用');
      const result = await input.store.maintain({
        now: now().toISOString(),
        positionRetentionHours: config.positionRetentionHours,
      });
      let failures = 0;
      const sorted = [...result.accountIds].sort();
      const next = sorted.filter((id) => id > maintenanceCursor).slice(0, 20);
      const batch = next.length ? next : sorted.slice(0, 20);
      for (const accountId of batch)
        try {
          await getState(accountId);
        } catch {
          failures += 1;
        }
      maintenanceCursor = batch.at(-1) ?? '';
      return { ...result, failures };
    },
    deleteData: async (accountId: string) => {
      await principal(accountId);
      if (!input.store.maintain) throw new Error('同行数据删除不可用');
      await input.store.maintain({
        now: now().toISOString(),
        positionRetentionHours: config.positionRetentionHours,
        deleteAccountId: accountId,
      });
      return { deleted: true };
    },
    routePreview: async (
      accountId: string,
      targetIntentId: string,
      groupId?: string,
    ) => {
      const actor = await principal(accountId);
      if (groupId) {
        const ownPreview = await workflow.withContext(accountId, (ctx) => {
          const group = ctx.state.groups.find(
            (group) =>
              group.id === groupId &&
              !['closed', 'expired'].includes(group.status) &&
              group.members.some(
                (member) =>
                  member.accountId === accountId &&
                  member.intentId === targetIntentId,
              ),
          );
          if (!group) return null;
          const routes = group.members.map((member) =>
            ctx.intents.find(
              (intent) =>
                intent.id === member.intentId &&
                intent.accountId === member.accountId &&
                intent.organizationId === member.organizationId &&
                Date.parse(intent.expiresAt) > now().getTime(),
            ),
          );
          if (routes.some((route) => !route))
            throw new Error('本组行程已失效，请刷新同行状态');
          const mine = routes.find((route) => route!.accountId === accountId)!;
          carpoolMeasurement(ctx.state, accountId, now().toISOString())
            .routeViews++;
          return buildCarpoolRoutePreview(
            mine.route.polyline,
            routes
              .filter((route) => route!.accountId !== accountId)
              .map((route) => route!.route.polyline),
          );
        });
        if (ownPreview) return ownPreview;
      }
      const current = await stateFor(
        actor,
        await input.store.getIntent(accountId),
        {},
        targetIntentId,
      );
      const group = current.groupMatches?.find(
        (match) =>
          match.groupId === groupId && match.intentId === targetIntentId,
      );
      const personal = current.matches.find(
        (match) => match.intentId === targetIntentId,
      );
      if (!current.currentIntent || !(group || (!groupId && personal)))
        throw new Error('无权查看该路线，匹配已失效');
      return workflow.withContext(accountId, (ctx) => {
        const mine = ctx.intents.find(
          (intent) => intent.id === current.currentIntent!.id,
        );
        const target = ctx.intents.find(
          (intent) => intent.id === targetIntentId,
        );
        if (
          !mine ||
          !target ||
          mine.version !== current.currentIntent!.version ||
          target.version !== (group ?? personal)?.candidateVersion ||
          target.status !== 'active' ||
          Date.parse(target.expiresAt) <= now().getTime()
        )
          throw new Error('路线已更新，请刷新');
        const members = group
          ? ctx.state.groups.find(
              (value) =>
                value.id === group.groupId &&
                value.version === group.groupVersion,
            )?.members
          : undefined;
        if (group && !members) throw new Error('同行组已更新，请刷新');
        const identities = members?.map((member) => member.accountId) ?? [
          target.accountId,
        ];
        const candidateAccount = group?.inviteToMyGroup
          ? target.accountId
          : accountId;
        if (
          ctx.state.blocks.some(
            (block) =>
              (block.from === candidateAccount &&
                identities.includes(block.to)) ||
              (block.to === candidateAccount &&
                identities.includes(block.from)),
          ) ||
          ctx.state.availability.some(
            (entry) =>
              !entry.accepting &&
              (entry.accountId === candidateAccount ||
                entry.accountId === accountId ||
                identities.includes(entry.accountId)),
          )
        )
          throw new Error('无权查看该路线，匹配已失效');
        if (
          !group &&
          !buildCarpoolMatches(mine, [target], {
            now: now(),
            minimumOverlap: input.minimumOverlap,
          }).length
        )
          throw new Error('无权查看该路线，匹配已失效');
        const others =
          members && !group?.inviteToMyGroup
            ? members
                .map(
                  (member) =>
                    ctx.intents.find((intent) => intent.id === member.intentId)
                      ?.route.polyline,
                )
                .filter((route): route is ParkCarpoolCoordinate[] =>
                  Boolean(route),
                )
            : [target.route.polyline];
        carpoolMeasurement(ctx.state, accountId, now().toISOString())
          .routeViews++;
        return buildCarpoolRoutePreview(mine.route.polyline, others);
      });
    },
    reversePlace: async (
      accountId: string,
      coordinate: ParkCarpoolCoordinate,
      system: 'gps' | 'autonavi' = 'autonavi',
    ) => {
      await principal(accountId);
      validateMapCoordinate(coordinate);
      if (!input.mapProvider.reverseGeocode)
        throw new Error('地图服务不支持逆地理编码');
      return mapCall(accountId, () =>
        input.mapProvider.reverseGeocode!(coordinate, system),
      );
    },
    staticMap: async (
      accountId: string,
      coordinate: ParkCarpoolCoordinate,
      zoom: number,
    ) => {
      await principal(accountId);
      validateMapCoordinate(coordinate);
      if (!Number.isInteger(zoom) || zoom < 3 || zoom > 17)
        throw new Error('地图缩放无效');
      if (!input.mapProvider.staticMap)
        throw new Error('地图服务不支持选点预览');
      return mapCall(accountId, () =>
        input.mapProvider.staticMap!(coordinate, zoom),
      );
    },
    executeSignedTransport: async (
      accountId: string,
      command: ParkTransportCommand,
      proof: ParkTransportProof | undefined,
    ) => {
      if (!proof) throw new Error('无权使用加密接口，缺少设备签名');
      return createParkCarpoolTransport({ store: input.store, now }).execute(
        accountId,
        command,
        proof,
      );
    },
    executeTransport: (accountId: string, command: ParkTransportCommand) =>
      createParkCarpoolTransport({ store: input.store, now }).execute(
        accountId,
        command,
      ),
    getWorkflow: async (accountId: string) =>
      publicWorkflow(await workflow.read(accountId)),
    executeWorkflow: async (
      accountId: string,
      command: CarpoolWorkflowCommand,
    ) => publicWorkflow(await workflow.execute(accountId, command)),
    getState,
    searchPlaces,
    publishIntent,
    stopIntent,
    refreshMatches,
    confirmIntent,
  };
}

function validateMapCoordinate(coordinate: ParkCarpoolCoordinate) {
  if (
    !coordinate ||
    !Number.isFinite(coordinate.latitude) ||
    !Number.isFinite(coordinate.longitude) ||
    Math.abs(coordinate.latitude) > 85 ||
    Math.abs(coordinate.longitude) > 180
  )
    throw new Error('地点坐标无效');
}
