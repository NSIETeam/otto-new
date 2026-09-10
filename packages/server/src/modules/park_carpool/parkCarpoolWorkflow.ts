import { carpoolParkEnabled } from './parkCarpoolConfig.js';
import { CarpoolMaintenanceDeferred } from './parkCarpoolRetention.js';
import type { CarpoolConfig } from './parkCarpoolConfig.js';
import {
  carpoolMeasurement,
  summarizeCarpoolMeasurements,
  type CarpoolMeasurement,
} from './parkCarpoolMetrics.js';
import {
  readCarpoolConfig,
  carpoolCommunicationCapabilities,
} from './parkCarpoolConfig.js';
import {
  evaluateCarpoolGroup,
  groupMatchFingerprint,
  planCarpoolDetour,
  type CarpoolGroupMatch,
  type CarpoolGroupAssessment,
  type CarpoolGroupPolicy,
} from './parkCarpoolGroupMatching.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import {
  buildCarpoolMatches,
  type ParkCarpoolIntent,
  type ParkCarpoolPlace,
} from './parkCarpoolDomain.js';
import type { ParkCarpoolTransportState } from './parkCarpoolTransport.js';
import type {
  ParkCarpoolMapProvider,
  ParkCarpoolPrincipal,
  ParkCarpoolStore,
} from './parkCarpoolService.js';

export type CarpoolRequestKind =
  'text' | 'carpool_invite' | 'group_join' | 'group_invite';
export type CarpoolTravelMode = 'private_vehicle' | 'shared_taxi';
export interface CarpoolRequest {
  id: string;
  kind: CarpoolRequestKind;
  senderAccountId: string;
  receiverAccountId: string;
  senderName: string;
  receiverName: string;
  senderOrganizationId: string;
  receiverOrganizationId: string;
  firstMessage: string;
  status:
    | 'pending'
    | 'accepted'
    | 'ignored'
    | 'rejected'
    | 'withdrawn'
    | 'expired'
    | 'blocked';
  intentBindings: Array<{
    accountId: string;
    intentId: string;
    version: number;
    fingerprint: string;
  }>;
  summary: {
    overlapPercent: number;
    commonDistanceMeters: number;
    departureTime: string;
  };
  travelMode?: CarpoolTravelMode;
  driverAccountId?: string;
  passengerCapacity?: number;
  groupId?: string;
  groupVersion?: number;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  invalidReason?: string;
}
export interface CarpoolGroup {
  intentFingerprint?: string;
  id: string;
  travelMode: CarpoolTravelMode;
  driverAccountId?: string;
  coordinatorAccountId: string;
  passengerCapacity: number;
  status: 'active' | 'full' | 'closed_to_new_members' | 'closed' | 'expired';
  members: Array<{
    accountId: string;
    organizationId: string;
    displayName: string;
    intentId: string;
    joinedAt: string;
  }>;
  version: number;
  conversationId: string;
  createdAt: string;
  expiresAt: string;
  transfer?: { from: string; to: string; createdAt: string };
}
export interface CarpoolConversation {
  id: string;
  kind: 'direct' | 'group';
  groupId?: string;
  generation: number;
  status: 'preparing_keys' | 'active' | 'archived' | 'blocked';
  generations: Array<{
    generation: number;
    members: Array<{ accountId: string; organizationId: string }>;
    createdAt: string;
    retiredAt?: string;
  }>;
}
export interface CarpoolNotice {
  id: string;
  accountId: string;
  type: string;
  subjectId: string;
  text: string;
  createdAt: string;
  readAt?: string;
}
export interface CarpoolMeetingPoint {
  id: string;
  version: number;
  name: string;
  place: ParkCarpoolPlace;
  updatedAt: string;
  updatedBy: string;
}
export interface CarpoolWorkflowState {
  measurements?: CarpoolMeasurement[];
  meetingPoints?: CarpoolMeetingPoint[];
  transport?: ParkCarpoolTransportState;
  schemaVersion: 1;
  requests: CarpoolRequest[];
  groups: CarpoolGroup[];
  conversations: CarpoolConversation[];
  blocks: Array<{ from: string; to: string; createdAt: string }>;
  notices: CarpoolNotice[];
  reports: Array<{
    id: string;
    reporter: string;
    target: string;
    reason: string;
    requestId?: string;
    createdAt: string;
    status: 'open' | 'resolved';
    resolution?: string;
    resolvedBy?: string;
    resolvedAt?: string;
    evidence?: {
      firstMessage: string;
      kind: CarpoolRequestKind | 'chat_message';
      source?: 'reporter_submission';
      conversationId?: string;
      eventId?: string;
      ciphertext?: string;
      createdAt: string;
    };
  }>;
  availability: Array<{ accountId: string; accepting: boolean }>;
}
export interface CarpoolWorkflowContext {
  state: CarpoolWorkflowState;
  actor: ParkCarpoolPrincipal | null;
  intents: ParkCarpoolIntent[];
  stoppedIntentIds?: string[];
  devices?: Array<{
    accountId: string;
    organizationId: string;
    deviceId: string;
    identitySigningPublicKey?: string;
  }>;
}
export type CarpoolWorkflowCommand =
  | { type: 'record_open' }
  | {
      type: 'request';
      targetIntentId: string;
      kind: CarpoolRequestKind;
      firstMessage: string;
      travelMode?: CarpoolTravelMode;
      driverAccountId?: string;
      driverRole?: 'sender' | 'receiver';
      passengerCapacity?: number;
      groupId?: string;
    }
  | {
      type: 'resolve';
      requestId: string;
      action: 'accept' | 'ignore' | 'reject' | 'withdraw';
      passengerCapacity?: number;
    }
  | {
      type: 'block' | 'unblock';
      targetAccountId: string;
      leaveSharedGroup?: boolean;
    }
  | {
      type: 'report';
      targetAccountId: string;
      reason: string;
      requestId?: string;
    }
  | {
      type: 'report_message';
      conversationId: string;
      eventId: string;
      plaintext: string;
      reason: string;
    }
  | { type: 'resolve_report'; reportId: string; resolution: string }
  | { type: 'read_notice'; noticeId: string }
  | {
      type: 'save_meeting_point';
      id?: string;
      expectedVersion?: number;
      name: string;
      place: ParkCarpoolPlace;
    }
  | { type: 'delete_meeting_point'; id: string; expectedVersion: number }
  | { type: 'stop'; intentId: string }
  | { type: 'leave'; stopLooking: boolean }
  | { type: 'availability'; accepting: boolean }
  | { type: 'propose_transfer'; targetAccountId: string }
  | { type: 'accept_transfer'; passengerCapacity?: number };

export function emptyCarpoolWorkflow(): CarpoolWorkflowState {
  return {
    schemaVersion: 1,
    requests: [],
    groups: [],
    conversations: [],
    blocks: [],
    notices: [],
    reports: [],
    availability: [],
  };
}
function fingerprint(intent: ParkCarpoolIntent) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        intent.organizationId,
        intent.parkId,
        intent.travelDate,
        intent.origin,
        intent.destination,
        intent.departureTime,
        intent.flexibleMinutes,
        [...intent.travelOptions].sort(),
        intent.route,
      ]),
    )
    .digest('hex');
}
function activeGroup(group: CarpoolGroup) {
  return !['closed', 'expired'].includes(group.status);
}
function blocked(state: CarpoolWorkflowState, a: string, b: string) {
  return state.blocks.some(
    (x) => (x.from === a && x.to === b) || (x.from === b && x.to === a),
  );
}
function text(value: unknown, label: string, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new Error(`${label}无效`);
  return value.trim();
}
function notice(
  state: CarpoolWorkflowState,
  accountId: string,
  type: string,
  subjectId: string,
  body: string,
  now: string,
) {
  const id = createHash('sha256')
    .update(JSON.stringify([accountId, type, subjectId]))
    .digest('hex');
  if (!state.notices.some((n) => n.id === id))
    state.notices.push({
      id,
      accountId,
      type,
      subjectId,
      text: body,
      createdAt: now,
    });
}
function rotate(
  conversation: CarpoolConversation,
  members: Array<{ accountId: string; organizationId: string }>,
  now: string,
) {
  const previous = conversation.generations.at(-1);
  if (previous) previous.retiredAt = now;
  conversation.generation += 1;
  conversation.status = members.length >= 2 ? 'preparing_keys' : 'archived';
  if (members.length >= 2)
    conversation.generations.push({
      generation: conversation.generation,
      members: members.map((m) => ({
        accountId: m.accountId,
        organizationId: m.organizationId,
      })),
      createdAt: now,
    });
}
function newConversation(
  state: CarpoolWorkflowState,
  kind: 'direct' | 'group',
  members: Array<{ accountId: string; organizationId: string }>,
  now: string,
  groupId?: string,
) {
  const value: CarpoolConversation = {
    id: randomUUID(),
    kind,
    groupId,
    generation: 0,
    status: 'preparing_keys',
    generations: [],
  };
  rotate(value, members, now);
  state.conversations.push(value);
  return value;
}
function groupFor(state: CarpoolWorkflowState, id: string) {
  return state.groups.find(
    (g) => activeGroup(g) && g.members.some((m) => m.accountId === id),
  );
}
function bind(intent: ParkCarpoolIntent) {
  return {
    accountId: intent.accountId,
    intentId: intent.id,
    version: intent.version ?? 1,
    fingerprint: fingerprint(intent),
  };
}
function live(
  intent: ParkCarpoolIntent | undefined,
  now: number,
): intent is ParkCarpoolIntent {
  return Boolean(
    intent && intent.status === 'active' && Date.parse(intent.expiresAt) > now,
  );
}

export function createCarpoolWorkflow(input: {
  config?: CarpoolConfig;
  signal?: AbortSignal;
  maintenance?: boolean;
  store: ParkCarpoolStore;
  now?(): Date;
  minimumOverlap?: number;
  requestLimitPerHour?: number;
  cooldownMinutes?: number;
  maxTaxiMembers?: number;
  mapProvider?: ParkCarpoolMapProvider;
  groupPolicy?: CarpoolGroupPolicy;
}) {
  const config = input.config ?? readCarpoolConfig();
  const groupPolicy = input.groupPolicy ?? config;
  const clock = input.now ?? (() => new Date());
  const taxiLimit = input.maxTaxiMembers ?? config.maxTaxiMembers;
  if (!Number.isInteger(taxiLimit) || taxiLimit < 2 || taxiLimit > 4)
    throw new Error('同行组人数配置无效');
  function reconcile(ctx: CarpoolWorkflowContext, now: string) {
    const { state, intents } = ctx;
    const timestamp = Date.parse(now);
    for (const intent of intents) {
      if (Date.parse(intent.expiresAt) <= timestamp)
        notice(
          state,
          intent.accountId,
          'intent_expired',
          intent.id,
          '本次同行意向已到期，不再接受新匹配；已有聊天可在消息中心查看',
          now,
        );
      else if (
        intent.status === 'active' &&
        Date.parse(intent.departureTime) - timestamp <= 30 * 60_000
      )
        notice(
          state,
          intent.accountId,
          'departing_soon',
          intent.id,
          '即将到达计划出发时间，请确认同行安排',
          now,
        );
      else if (
        intent.status === 'active' &&
        timestamp - Date.parse(intent.lastConfirmedAt) >
          config.staleMinutes * 60_000
      )
        notice(
          state,
          intent.accountId,
          'confirm_search',
          `${intent.id}:${intent.lastConfirmedAt}`,
          '请确认是否仍在寻找，以保持匹配结果新鲜',
          now,
        );
    }
    for (const request of state.requests) {
      if (!['pending', 'ignored'].includes(request.status)) continue;
      const joinedElsewhere =
        request.kind === 'carpool_invite'
          ? Boolean(
              groupFor(state, request.senderAccountId) ||
              groupFor(state, request.receiverAccountId),
            )
          : request.kind === 'group_join'
            ? Boolean(groupFor(state, request.senderAccountId))
            : request.kind === 'group_invite'
              ? Boolean(groupFor(state, request.receiverAccountId))
              : false;
      const invalid =
        joinedElsewhere ||
        request.intentBindings.some((binding) => {
          const intent = intents.find(
            (i) =>
              i.id === binding.intentId && i.accountId === binding.accountId,
          );
          return (
            !live(intent, timestamp) ||
            fingerprint(intent) !== binding.fingerprint ||
            state.availability.some(
              (entry) =>
                entry.accountId === binding.accountId && !entry.accepting,
            )
          );
        });
      if (
        Date.parse(request.expiresAt) <= timestamp ||
        invalid ||
        (request.groupVersion !== undefined &&
          !state.groups.some(
            (group) =>
              group.id === request.groupId &&
              group.version === request.groupVersion &&
              group.status === 'active',
          ))
      ) {
        request.status = 'expired';
        request.invalidReason = invalid
          ? '同行意向已修改、停止或身份失效'
          : '请求已到期';
        request.resolvedAt = now;
        for (const id of [request.senderAccountId, request.receiverAccountId])
          notice(
            state,
            id,
            'request_expired',
            request.id,
            '同行请求已失效，请查看当前行程',
            now,
          );
      }
    }
    for (const group of state.groups.filter(activeGroup)) {
      const oldMembers = group.members;
      const intentFingerprint = createHash('sha256')
        .update(
          JSON.stringify(
            group.members.map((member) => {
              const intent = intents.find((i) => i.id === member.intentId);
              return intent ? fingerprint(intent) : null;
            }),
          ),
        )
        .digest('hex');
      if (
        group.intentFingerprint &&
        group.intentFingerprint !== intentFingerprint
      ) {
        group.version += 1;
        group.status = 'closed_to_new_members';
        delete group.transfer;
        for (const member of group.members)
          notice(
            state,
            member.accountId,
            'group_intent_changed',
            `${group.id}:${group.version}`,
            '成员修改了本次行程，已关闭新申请；请与组员重新确认，或退出后按新行程组队',
            now,
          );
      }
      group.intentFingerprint = intentFingerprint;
      group.members = group.members.filter((m) =>
        intents.some(
          (i) =>
            i.id === m.intentId &&
            i.accountId === m.accountId &&
            Date.parse(i.expiresAt) > timestamp,
        ),
      );
      if (Date.parse(group.expiresAt) <= timestamp) group.status = 'expired';
      else if (group.members.length < 2) group.status = 'closed';
      else if (
        !group.members.some((m) => m.accountId === group.coordinatorAccountId)
      )
        group.status = 'closed_to_new_members';
      if (group.members.length !== oldMembers.length || !activeGroup(group)) {
        group.version += 1;
        const conversation = state.conversations.find(
          (c) => c.id === group.conversationId,
        )!;
        rotate(conversation, activeGroup(group) ? group.members : [], now);
        for (const member of oldMembers)
          notice(
            state,
            member.accountId,
            'group_changed',
            `${group.id}:${group.version}`,
            '同行组状态已变化，请查看详情',
            now,
          );
      }
    }
    for (const conversation of state.conversations) {
      if (
        conversation.kind !== 'direct' ||
        ['archived', 'blocked'].includes(conversation.status)
      )
        continue;
      const members = conversation.generations.at(-1)?.members ?? [];
      if (
        members.some(
          (member) =>
            !intents.some(
              (intent) =>
                intent.accountId === member.accountId &&
                intent.organizationId === member.organizationId &&
                Date.parse(intent.expiresAt) > timestamp,
            ),
        )
      ) {
        rotate(conversation, [], now);
        for (const member of members)
          notice(
            state,
            member.accountId,
            'conversation_archived',
            conversation.id,
            '同行会话已归档，行程到期或成员身份已失效',
            now,
          );
      }
    }
    // No precise locations are duplicated in workflow records. Data retention
    // of position-bearing intent/publication records is a separate store task.
  }
  async function transact<T>(
    accountId: string,
    operation: (ctx: CarpoolWorkflowContext, now: string) => T,
  ): Promise<T> {
    input.signal?.throwIfAborted();
    const actor = await input.store.getPrincipal(accountId);
    if (!actor?.active || !actor.parkServiceEnabled || !actor.parkId)
      throw new Error('当前账号无权使用园区同行');
    if (!input.store.transactWorkflow)
      throw new Error('服务器尚未启用同行请求');
    return input.store.transactWorkflow(actor.parkId, accountId, (ctx) => {
      if (
        !ctx.actor?.active ||
        !ctx.actor.parkServiceEnabled ||
        ctx.actor.parkId !== actor.parkId ||
        ctx.actor.organizationId !== actor.organizationId
      )
        throw new Error('当前园区身份已失效');
      input.signal?.throwIfAborted();
      const now = clock().toISOString();
      reconcile(ctx, now);
      return operation(ctx, now);
    }, input.maintenance);
  }
  function view(ctx: CarpoolWorkflowContext) {
    const { state, actor } = ctx;
    const id = actor!.accountId;
    return {
      accountId: id,
      hasActiveIntent: ctx.intents.some(
        (intent) => intent.accountId === id && live(intent, clock().getTime()),
      ),
      capabilities: carpoolCommunicationCapabilities(config, actor!.parkId!),
      readiness: {
        map: Boolean(input.mapProvider?.configured),
        approvedDevice: Boolean(ctx.devices?.some(device => device.accountId === id)),
      },
      metrics: actor!.parkAdmin
        ? {
            ...summarizeCarpoolMeasurements(state.measurements),
            activeIntents: ctx.intents.filter((i) => live(i, clock().getTime()))
              .length,
            requests: state.requests.length,
            textRequests: state.requests.filter((r) => r.kind === 'text')
              .length,
            acceptedTextRequests: state.requests.filter(
              (r) => r.kind === 'text' && r.status === 'accepted',
            ).length,
            invitations: state.requests.filter((r) => r.kind !== 'text').length,
            acceptedInvitations: state.requests.filter(
              (r) => r.kind !== 'text' && r.status === 'accepted',
            ).length,
            stoppedIntents: ctx.intents.filter((i) => i.status === 'paused')
              .length,
            blockedPairs: state.blocks.length,
            reports: state.reports.length,
            acceptedRequests: state.requests.filter(
              (r) => r.status === 'accepted',
            ).length,
            activeGroups: state.groups.filter(activeGroup).length,
            ciphertextMessages: state.transport?.events.length ?? 0,
            reportsAwaitingReview: state.reports.filter(
              (r) => r.status === 'open',
            ).length,
          }
        : undefined,
      parkAdmin: Boolean(actor!.parkAdmin),
      meetingPoints: state.meetingPoints ?? [],
      acceptingNewMatches: !state.availability.some(
        (a) => a.accountId === id && !a.accepting,
      ),
      requests: state.requests
        .filter((r) => r.senderAccountId === id || r.receiverAccountId === id)
        .map((r) => ({
          ...r,
          status:
            r.senderAccountId === id && r.status === 'ignored'
              ? ('pending' as const)
              : r.status,
        })),
      myGroup: groupFor(state, id) ?? null,
      conversations: state.conversations
        .filter((c) =>
          c.generations.some((g) => g.members.some((m) => m.accountId === id)),
        )
        .map((c) => ({
          ...c,
          generations: c.generations.filter((g) =>
            g.members.some((m) => m.accountId === id),
          ),
        })),
      notices: state.notices.filter((n) => n.accountId === id),
      ownBlockedAccountIds: state.blocks
        .filter((b) => b.from === id)
        .map((b) => b.to),
      blockedAccountIds: state.blocks
        .filter((b) => b.from === id || b.to === id)
        .map((b) => (b.from === id ? b.to : b.from)),
      groupedAccountIds: state.groups
        .filter(activeGroup)
        .flatMap((g) => g.members.map((m) => m.accountId)),
      unavailableAccountIds: state.availability
        .filter((a) => !a.accepting)
        .map((a) => a.accountId),
      reports: state.reports.filter(
        (r) => r.reporter === id || actor!.parkAdmin,
      ),
    };
  }
  async function assess(
    accountId: string,
    command: CarpoolWorkflowCommand,
  ): Promise<CarpoolGroupAssessment | null> {
    const snapshot = await transact(accountId, (ctx) => {
      let group: CarpoolGroup | undefined;
      let candidate: ParkCarpoolIntent | undefined;
      if (command.type === 'request' && command.kind === 'group_join') {
        group = ctx.state.groups.find((g) =>
          g.members.some((m) => m.intentId === command.targetIntentId),
        );
        candidate = ctx.intents.find(
          (i) => i.accountId === accountId && live(i, clock().getTime()),
        );
      } else if (
        command.type === 'request' &&
        command.kind === 'group_invite'
      ) {
        group = groupFor(ctx.state, accountId);
        candidate = ctx.intents.find((i) => i.id === command.targetIntentId);
      } else if (command.type === 'resolve' && command.action === 'accept') {
        const request = ctx.state.requests.find(
          (r) =>
            r.id === command.requestId &&
            r.receiverAccountId === accountId &&
            ['pending', 'ignored'].includes(r.status),
        );
        if (
          request?.kind === 'group_join' ||
          request?.kind === 'group_invite'
        ) {
          group = ctx.state.groups.find((g) => g.id === request.groupId);
          const binding = request.intentBindings.find(
            (b) =>
              b.accountId ===
              (request.kind === 'group_join'
                ? request.senderAccountId
                : request.receiverAccountId),
          );
          candidate = ctx.intents.find(
            (i) =>
              i.id === binding?.intentId && i.accountId === binding.accountId,
          );
        }
      }
      if (!group || !candidate) return null;
      return {
        group,
        candidate,
        members: group.members
          .map((m) => ctx.intents.find((i) => i.id === m.intentId))
          .filter((i): i is ParkCarpoolIntent => Boolean(i)),
      };
    });
    if (!snapshot) return null;
    if (!input.mapProvider?.configured)
      throw new Error('地图服务未就绪，无法核验同行绕行');
    const detour = await planObserved(
      accountId,
      snapshot.group,
      snapshot.members,
      snapshot.candidate,
    );
    return {
      groupId: snapshot.group.id,
      candidateId: snapshot.candidate.accountId,
      fingerprint: groupMatchFingerprint(
        snapshot.group,
        snapshot.members,
        snapshot.candidate,
      ),
      detour,
    };
  }
  async function planObserved(
    accountId: string,
    group: CarpoolGroup,
    members: ParkCarpoolIntent[],
    candidate: ParkCarpoolIntent,
  ) {
    const start = performance.now();
    let failed = false;
    try {
      return await planCarpoolDetour(
        group,
        members,
        candidate,
        {...input.mapProvider!, planDrivingRoute: (...args) => {
          input.signal?.throwIfAborted();
          return input.mapProvider!.planDrivingRoute(...args);
        }},
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await transact(accountId, (ctx) => {
        const row = carpoolMeasurement(
          ctx.state,
          accountId,
          clock().toISOString(),
        );
        row.mapCalls++;
        row.mapFailures += Number(failed);
        row.mapMilliseconds += Math.max(0, performance.now() - start);
      }).catch(() =>
        console.warn('Carpool group planning metrics unavailable'),
      );
    }
  }
  function verifyAssessment(
    group: CarpoolGroup,
    candidate: ParkCarpoolIntent,
    ctx: CarpoolWorkflowContext,
    assessment: CarpoolGroupAssessment | null,
  ) {
    const members = group.members
      .map((m) => ctx.intents.find((i) => i.id === m.intentId))
      .filter((i): i is ParkCarpoolIntent => Boolean(i));
    if (
      !assessment ||
      assessment.groupId !== group.id ||
      assessment.candidateId !== candidate.accountId ||
      assessment.fingerprint !==
        groupMatchFingerprint(group, members, candidate)
    )
      throw new Error('同行组或行程已更新，请刷新后重试');
    if (
      ctx.state.availability.some(
        (entry) => entry.accountId === candidate.accountId && !entry.accepting,
      ) ||
      members.some(
        (m) =>
          blocked(ctx.state, m.accountId, candidate.accountId) ||
          ctx.state.availability.some(
            (a) => a.accountId === m.accountId && !a.accepting,
          ),
      ) ||
      !evaluateCarpoolGroup(group, members, candidate, assessment.detour, {
        ...groupPolicy,
        now: clock(),
      })
    )
      throw new Error('同行组路线、时间、方式、容量或绕行不符合条件');
  }
  return {
    async groupMatches(
      accountId: string,
      acceptMatch: (match: CarpoolGroupMatch) => void,
      background?: { after?: string; limit: number },
    ) {
      if (!config.requestsEnabled || !config.groupsEnabled || !config.invitationsEnabled)
        return { failedCount: 0 };
      let failedCount = 0;
      let cursor: string | undefined = background?.after;
      do {
        const page = await transact(accountId, (ctx) => {
          const mine = ctx.intents.find(
            (i) => i.accountId === accountId && live(i, clock().getTime()),
          );
          if (
            !mine || !carpoolParkEnabled(config, ctx.actor!.parkId!) ||
            ctx.state.availability.some(
              (a) => a.accountId === accountId && !a.accepting,
            )
          )
            return { snapshots: [], nextCursor: undefined };
          const own = groupFor(ctx.state, accountId);
          if (own && own.coordinatorAccountId !== accountId)
            return { snapshots: [], nextCursor: undefined };
          const pairs = own
            ? ctx.intents
                .filter(
                  (i) =>
                    live(i, clock().getTime()) &&
                    !groupFor(ctx.state, i.accountId),
                )
                .map((candidate) => ({
                  group: own,
                  candidate,
                  inviteToMyGroup: true,
                }))
            : ctx.state.groups
                .filter((g) => g.status === 'active')
                .map((group) => ({
                  group,
                  candidate: mine,
                  inviteToMyGroup: false,
                }));
          const key = (pair: (typeof pairs)[number]) =>
            `${pair.group.id}:${pair.candidate.id}`;
          const remaining = pairs
            .filter((pair) => !cursor || key(pair) > cursor)
            .sort((a, b) => key(a).localeCompare(key(b)));
          const batch = remaining.slice(0, background ? Math.max(1, Math.min(25, background.limit)) : 25);
          return {
            nextCursor:
              remaining.length > batch.length ? key(batch.at(-1)!) : undefined,
            snapshots: batch.flatMap(
              ({ group, candidate, inviteToMyGroup }) => {
                const members = group.members
                  .map((m) => ctx.intents.find((i) => i.id === m.intentId))
                  .filter((i): i is ParkCarpoolIntent => Boolean(i));
                if (
                  ctx.state.availability.some(
                    (a) => a.accountId === candidate.accountId && !a.accepting,
                  ) ||
                  members.some(
                    (m) =>
                      blocked(ctx.state, m.accountId, candidate.accountId) ||
                      ctx.state.availability.some(
                        (a) => a.accountId === m.accountId && !a.accepting,
                      ),
                  ) ||
                  !evaluateCarpoolGroup(
                    group,
                    members,
                    candidate,
                    { maximumDetourSeconds: 0 },
                    { ...groupPolicy, now: clock() },
                  )
                )
                  return [];
                return [{ group, members, candidate, inviteToMyGroup }];
              },
            ),
          };
        });
        for (const snapshot of page.snapshots)
          try {
            input.signal?.throwIfAborted();
            if (!input.mapProvider?.configured)
              throw new Error('地图服务未配置');
            const detour = await planObserved(
              accountId,
              snapshot.group,
              snapshot.members,
              snapshot.candidate,
            );
            const match = await transact(accountId, (ctx) => {
              const group = ctx.state.groups.find(
                (g) => g.id === snapshot.group.id,
              );
              const candidate = ctx.intents.find(
                (i) =>
                  i.id === snapshot.candidate.id &&
                  i.accountId === snapshot.candidate.accountId,
              );
              if (
                !group ||
                !candidate ||
                groupFor(ctx.state, candidate.accountId)
              )
                return null;
              verifyAssessment(group, candidate, ctx, {
                groupId: group.id,
                candidateId: candidate.accountId,
                fingerprint: groupMatchFingerprint(
                  snapshot.group,
                  snapshot.members,
                  snapshot.candidate,
                ),
                detour,
              });
              return evaluateCarpoolGroup(
                group,
                snapshot.members,
                candidate,
                detour,
                { ...groupPolicy, now: clock() },
              );
            });
            if (match)
              acceptMatch(
                snapshot.inviteToMyGroup
                  ? {
                      ...match,
                      inviteToMyGroup: true,
                      candidateVersion: snapshot.candidate.version,
                      intentId: snapshot.candidate.id,
                      displayName:
                        snapshot.candidate.displayName.slice(0, 1) + '同事',
                      organizationName: snapshot.candidate.organizationName,
                    }
                  : match,
              );
          } catch (error) {
            if (input.maintenance && error instanceof CarpoolMaintenanceDeferred) throw error;
            failedCount += 1;
          }
        cursor = page.nextCursor;
        if (background) break;
        if (cursor) await new Promise<void>((resolve) => setImmediate(resolve));
      } while (cursor);
      return { failedCount, nextCursor: cursor };
    },
    withContext: transact,
    read: (accountId: string) => transact(accountId, (ctx) => view(ctx)),
    execute: async (accountId: string, command: CarpoolWorkflowCommand) => {
      const assessment = await assess(accountId, command);
      return transact(accountId, (ctx, now) => {
        const { state, intents, actor } = ctx;
        const id = actor!.accountId;
        const mine = intents.find(
          (i) => i.accountId === id && live(i, Date.parse(now)),
        );
        if (
          command.type === 'save_meeting_point' ||
          command.type === 'delete_meeting_point'
        ) {
          if (!actor!.parkAdmin) throw new Error('无权维护园区公共集合点');
          const points = (state.meetingPoints ??= []);
          const existing = points.find((point) => point.id === command.id);
          if (
            command.id &&
            (!existing || existing.version !== command.expectedVersion)
          )
            throw new Error('集合点已更新，请刷新');
          if (command.type === 'delete_meeting_point')
            state.meetingPoints = points.filter(
              (point) => point.id !== command.id,
            );
          else {
            const coordinate = command.place?.coordinate;
            if (
              !coordinate ||
              !Number.isFinite(coordinate.longitude) ||
              !Number.isFinite(coordinate.latitude) ||
              Math.abs(coordinate.longitude) > 180 ||
              Math.abs(coordinate.latitude) > 85
            )
              throw new Error('请先选择标准地点');
            if (!existing && points.length >= 20)
              throw new Error('公共集合点最多 20 个');
            const point: CarpoolMeetingPoint = {
              id: existing?.id ?? randomUUID(),
              version: (existing?.version ?? 0) + 1,
              name: text(command.name, '集合点名称', 60),
              place: {
                label: text(command.place.label, '地点名称', 160),
                coordinate: {
                  longitude: coordinate.longitude,
                  latitude: coordinate.latitude,
                },
              },
              updatedAt: now,
              updatedBy: id,
            };
            if (existing) points.splice(points.indexOf(existing), 1, point);
            else points.push(point);
          }
        } else if (command.type === 'record_open') {
          carpoolMeasurement(state, id, now).opened = true;
        } else if (command.type === 'stop') {
          const intent = intents.find(
            (i) => i.accountId === id && i.id === command.intentId,
          );
          if (!intent) throw new Error('无权停止该同行意向');
          if (groupFor(state, id))
            throw new Error('请明确选择保留同行组或退出并停止');
          if (intent.status === 'active') {
            intent.status = 'paused';
            ctx.stoppedIntentIds?.push(intent.id);
            notice(
              state,
              id,
              'stopped',
              `${intent.id}:${intent.version}`,
              '已停止寻找，已有聊天会话保留',
              now,
            );
          }
        } else if (command.type === 'request') {
          if (
            !config.requestsEnabled || !carpoolParkEnabled(config, actor!.parkId!) ||
            (command.kind === 'carpool_invite' && !config.invitationsEnabled) ||
            (['group_join', 'group_invite'].includes(command.kind) &&
              (!config.invitationsEnabled || !config.groupsEnabled))
          )
            throw new Error('服务器尚未启用此阶段的同行能力');
          if (
            !['text', 'carpool_invite', 'group_join', 'group_invite'].includes(
              command.kind,
            )
          )
            throw new Error('请求类型无效');
          const target = intents.find((i) => i.id === command.targetIntentId);
          if (
            !mine ||
            !live(target, Date.parse(now)) ||
            target.accountId === id ||
            blocked(state, id, target.accountId)
          )
            throw new Error('没有有效匹配，无法联系');
          if (
            state.availability.some(
              (a) =>
                (a.accountId === id || a.accountId === target.accountId) &&
                !a.accepting,
            )
          )
            throw new Error('对方或你已停止接受新匹配');
          const match = buildCarpoolMatches(mine, [target], {
            now: new Date(now),
            minimumOverlap: input.minimumOverlap ?? 0.35,
          })[0];
          if (!match) throw new Error('没有有效匹配，无法联系');
          const otherGroup = groupFor(state, target.accountId);
          const myGroup = groupFor(state, id);
          if (command.kind === 'group_join' && !otherGroup)
            throw new Error('同行组已失效');
          if (command.kind === 'carpool_invite' && (myGroup || otherGroup))
            throw new Error('已有同行组，请使用入组申请');
          if (
            command.kind === 'group_join' &&
            (myGroup ||
              otherGroup!.coordinatorAccountId !== target.accountId ||
              otherGroup!.status !== 'active')
          )
            throw new Error('无权申请或同行组已满/关闭');
          if (command.kind === 'group_join')
            verifyAssessment(otherGroup!, mine, ctx, assessment);
          if (command.kind === 'group_invite') {
            if (!myGroup || myGroup.coordinatorAccountId !== id || otherGroup)
              throw new Error('无权邀请加入该组');
            verifyAssessment(myGroup, target, ctx, assessment);
          }
          if (
            state.requests.some(
              (r) =>
                ['pending', 'ignored'].includes(r.status) &&
                ((r.senderAccountId === id &&
                  r.receiverAccountId === target.accountId) ||
                  (r.receiverAccountId === id &&
                    r.senderAccountId === target.accountId)),
            )
          )
            throw new Error('已有待处理请求，请先处理');
          if (
            state.requests.some(
              (r) =>
                r.senderAccountId === id &&
                r.receiverAccountId === target.accountId &&
                r.status === 'rejected' &&
                Date.parse(r.resolvedAt!) +
                  (input.cooldownMinutes ?? config.cooldownMinutes) * 60_000 >
                  Date.parse(now),
            )
          )
            throw new Error('对方已拒绝，请稍后再联系');
          if (
            state.requests.filter(
              (r) =>
                r.senderAccountId === id &&
                Date.parse(r.createdAt) > Date.parse(now) - 3_600_000,
            ).length >=
            (input.requestLimitPerHour ?? config.requestLimitPerHour)
          )
            throw new Error('发送过于频繁，请稍后重试');
          const driverAccountId =
            command.driverRole === 'sender'
              ? id
              : command.driverRole === 'receiver'
                ? target.accountId
                : command.driverAccountId;
          if (command.kind === 'carpool_invite')
            validateMode(
              command.travelMode,
              driverAccountId,
              [mine, target],
              command.passengerCapacity,
              id,
            );
          const request: CarpoolRequest = {
            id: randomUUID(),
            kind: command.kind,
            senderAccountId: id,
            receiverAccountId: target.accountId,
            senderName: actor!.displayName,
            receiverName: target.displayName,
            senderOrganizationId: actor!.organizationId,
            receiverOrganizationId: target.organizationId,
            firstMessage: text(command.firstMessage, '首条消息'),
            status: 'pending',
            intentBindings: [bind(mine), bind(target)],
            summary: {
              overlapPercent: match.overlapPercent,
              commonDistanceMeters: match.commonDistanceMeters,
              departureTime: mine.departureTime,
            },
            createdAt: now,
            expiresAt: new Date(
              Math.min(
                Date.parse(mine.expiresAt),
                Date.parse(target.expiresAt),
              ),
            ).toISOString(),
          };
          if (command.kind === 'carpool_invite')
            Object.assign(request, {
              travelMode: command.travelMode,
              driverAccountId,
              passengerCapacity:
                driverAccountId === id ? command.passengerCapacity : undefined,
            });
          if (
            command.kind === 'group_join' ||
            command.kind === 'group_invite'
          ) {
            const group =
              command.kind === 'group_join' ? otherGroup! : myGroup!;
            request.groupId = group.id;
            request.groupVersion = group.version;
            request.travelMode = group.travelMode;
            request.driverAccountId = group.driverAccountId;
            request.intentBindings = [
              ...new Map(
                [
                  ...group.members.map((m) =>
                    intents.find((i) => i.id === m.intentId)!,
                  ),
                  mine,
                  target,
                ].map((i) => [i.accountId, bind(i)]),
              ).values(),
            ];
          }
          state.requests.push(request);
          notice(
            state,
            target.accountId,
            'request',
            request.id,
            command.kind === 'text'
              ? '收到消息请求'
              : command.kind === 'group_join'
                ? '收到入组申请'
                : '收到同行邀请',
            now,
          );
        } else if (command.type === 'resolve') {
          const request = state.requests.find(
            (r) => r.id === command.requestId,
          );
          if (
            !request ||
            (command.action === 'withdraw'
              ? request.senderAccountId !== id
              : request.receiverAccountId !== id)
          )
            throw new Error('无权处理该请求');
          if (request.status === 'accepted' && command.action === 'accept')
            return view(ctx);
          if (!['pending', 'ignored'].includes(request.status))
            throw new Error('请求已失效或处理');
          if (command.action === 'withdraw') {
            request.status = 'withdrawn';
            request.resolvedAt = now;
          } else if (command.action === 'ignore') {
            if (request.kind !== 'text') throw new Error('同行邀请应明确拒绝');
            request.status = 'ignored';
          } else if (command.action === 'reject') {
            if (request.kind === 'text') throw new Error('消息请求请使用忽略');
            request.status = 'rejected';
            request.resolvedAt = now;
            notice(
              state,
              request.senderAccountId,
              'rejected',
              request.id,
              '同行邀请未被接受',
              now,
            );
          } else if (command.action === 'accept') {
            if (
              !config.requestsEnabled || !carpoolParkEnabled(config, actor!.parkId!) ||
              (request.kind === 'carpool_invite' &&
                !config.invitationsEnabled) ||
              (['group_join', 'group_invite'].includes(request.kind) &&
                (!config.invitationsEnabled || !config.groupsEnabled))
            )
              throw new Error('服务器暂未启用此阶段的同行能力');
            if (
              blocked(state, request.senderAccountId, request.receiverAccountId)
            )
              throw new Error('当前无法联系');
            const members = request.intentBindings.map((b) =>
              intents.find((i) => i.id === b.intentId)!,
            );
            if (request.kind === 'text') {
              if (
                !state.conversations.some(
                  (c) =>
                    c.kind === 'direct' &&
                    c.status !== 'blocked' &&
                    c.generations.at(-1)?.members.length === 2 &&
                    c.generations
                      .at(-1)!
                      .members.every((m) =>
                        members.some((i) => i.accountId === m.accountId),
                      ),
                )
              )
                newConversation(state, 'direct', members, now);
            } else if (request.kind === 'carpool_invite') {
              if (members.some((i) => groupFor(state, i.accountId)))
                throw new Error('已有同行组，请求已失效');
              const capacity =
                request.driverAccountId === id
                  ? command.passengerCapacity
                  : request.passengerCapacity;
              validateMode(
                request.travelMode,
                request.driverAccountId,
                members,
                capacity,
                request.driverAccountId,
              );
              const groupId = randomUUID();
              const conversation = newConversation(
                state,
                'group',
                members,
                now,
                groupId,
              );
              const group: CarpoolGroup = {
                id: groupId,
                travelMode: request.travelMode!,
                driverAccountId: request.driverAccountId,
                coordinatorAccountId:
                  request.driverAccountId ?? request.senderAccountId,
                passengerCapacity:
                  request.travelMode === 'shared_taxi'
                    ? taxiLimit - 1
                    : capacity!,
                status: 'active',
                members: members.map((i) => ({
                  accountId: i.accountId,
                  organizationId: i.organizationId,
                  displayName: i.displayName,
                  intentId: i.id,
                  joinedAt: now,
                })),
                version: 1,
                conversationId: conversation.id,
                createdAt: now,
                expiresAt: request.expiresAt,
              };
              if (group.members.length >= group.passengerCapacity + 1)
                group.status = 'full';
              state.groups.push(group);
              request.groupId = group.id;
            } else {
              const group = state.groups.find(
                (g) => g.id === request.groupId && g.status === 'active',
              );
              if (
                !group ||
                (request.kind === 'group_join'
                  ? group.coordinatorAccountId !== id
                  : group.coordinatorAccountId !== request.senderAccountId) ||
                groupFor(
                  state,
                  request.kind === 'group_join' ? request.senderAccountId : id,
                ) ||
                group.members.length >= group.passengerCapacity + 1
              )
                throw new Error('同行组已满、关闭或申请失效');
              const applicant = members.find(
                (i) =>
                  i.accountId ===
                  (request.kind === 'group_join'
                    ? request.senderAccountId
                    : id),
              )!;
              verifyAssessment(group, applicant, ctx, assessment);
              if (
                !applicant.travelOptions.includes(
                  group.travelMode === 'shared_taxi' ? 'shared_taxi' : 'rider',
                )
              )
                throw new Error('同行方式不兼容');
              delete group.intentFingerprint;
              group.members.push({
                accountId: applicant.accountId,
                organizationId: applicant.organizationId,
                displayName: applicant.displayName,
                intentId: applicant.id,
                joinedAt: now,
              });
              group.version += 1;
              if (group.members.length >= group.passengerCapacity + 1)
                group.status = 'full';
              rotate(
                state.conversations.find((c) => c.id === group.conversationId)!,
                group.members,
                now,
              );
            }
            request.status = 'accepted';
            request.resolvedAt = now;
            notice(
              state,
              request.senderAccountId,
              'accepted',
              request.id,
              request.kind === 'text' ? '消息请求已接受' : '同行请求已接受',
              now,
            );
            reconcile(ctx, now);
          } else throw new Error('请求操作无效');
        } else if (command.type === 'block' || command.type === 'unblock') {
          const target = text(command.targetAccountId, '目标账号', 200);
          if (command.type === 'unblock')
            state.blocks = state.blocks.filter(
              (b) => !(b.from === id && b.to === target),
            );
          else {
            if (
              target === id ||
              (!state.requests.some(
                (r) =>
                  [r.senderAccountId, r.receiverAccountId].includes(id) &&
                  [r.senderAccountId, r.receiverAccountId].includes(target),
              ) &&
                !state.conversations.some((conversation) =>
                  conversation.generations.some(
                    (generation) =>
                      generation.members.some(
                        (member) => member.accountId === id,
                      ) &&
                      generation.members.some(
                        (member) => member.accountId === target,
                      ),
                  ),
                ))
            )
              throw new Error('无权屏蔽该对象');
            const sharedGroup = groupFor(state, id);
            if (
              sharedGroup?.members.some((member) => member.accountId === target)
            ) {
              if (!command.leaveSharedGroup)
                throw new Error('屏蔽同组成员前，请明确确认退出共同的同行组');
              sharedGroup.members = sharedGroup.members.filter(
                (member) => member.accountId !== id,
              );
              delete sharedGroup.intentFingerprint;
              delete sharedGroup.transfer;
              sharedGroup.version += 1;
              sharedGroup.status =
                sharedGroup.members.length < 2
                  ? 'closed'
                  : sharedGroup.coordinatorAccountId === id
                    ? 'closed_to_new_members'
                    : 'active';
              rotate(
                state.conversations.find(
                  (conversation) =>
                    conversation.id === sharedGroup.conversationId,
                )!,
                activeGroup(sharedGroup) ? sharedGroup.members : [],
                now,
              );
              for (const member of sharedGroup.members)
                notice(
                  state,
                  member.accountId,
                  'member_left',
                  `${sharedGroup.id}:${sharedGroup.version}`,
                  '同行组成员已退出，请查看当前组状态',
                  now,
                );
            }
            if (!state.blocks.some((b) => b.from === id && b.to === target))
              state.blocks.push({ from: id, to: target, createdAt: now });
            for (const r of state.requests)
              if (
                [r.senderAccountId, r.receiverAccountId].includes(id) &&
                [r.senderAccountId, r.receiverAccountId].includes(target) &&
                ['pending', 'ignored'].includes(r.status)
              )
                r.status = 'blocked';
            for (const c of state.conversations)
              if (
                c.kind === 'direct' &&
                c.generations.at(-1)?.members.some((m) => m.accountId === id) &&
                c.generations
                  .at(-1)
                  ?.members.some((m) => m.accountId === target)
              )
                c.status = 'blocked';
          }
        } else if (command.type === 'read_notice') {
          const n = state.notices.find(
            (n) => n.id === command.noticeId && n.accountId === id,
          );
          if (!n) throw new Error('无权读取通知');
          n.readAt ??= now;
        } else if (command.type === 'availability') {
          if (typeof command.accepting !== 'boolean')
            throw new Error('状态无效');
          const value = state.availability.find((a) => a.accountId === id);
          if (value) value.accepting = command.accepting;
          else
            state.availability.push({
              accountId: id,
              accepting: command.accepting,
            });
        } else if (command.type === 'leave') {
          const group = groupFor(state, id);
          if (!group) throw new Error('没有有效同行组');
          delete group.intentFingerprint;
          group.members = group.members.filter((m) => m.accountId !== id);
          group.version += 1;
          group.status =
            group.members.length < 2
              ? 'closed'
              : group.coordinatorAccountId === id
                ? 'closed_to_new_members'
                : group.members.length >= group.passengerCapacity + 1
                  ? 'full'
                  : 'active';
          rotate(
            state.conversations.find((c) => c.id === group.conversationId)!,
            activeGroup(group) ? group.members : [],
            now,
          );
          if (command.stopLooking && mine) {
            mine.status = 'paused';
            ctx.stoppedIntentIds?.push(mine.id);
          }
          const availability = state.availability.find(
            (a) => a.accountId === id,
          );
          if (availability) availability.accepting = !command.stopLooking;
          else
            state.availability.push({
              accountId: id,
              accepting: !command.stopLooking,
            });
          for (const m of group.members)
            notice(
              state,
              m.accountId,
              'member_left',
              `${group.id}:${group.version}`,
              '成员已退出，请查看当前同行组状态',
              now,
            );
        } else if (
          command.type === 'propose_transfer' ||
          command.type === 'accept_transfer'
        ) {
          const group = groupFor(state, id);
          if (!group) throw new Error('没有有效同行组');
          if (command.type === 'propose_transfer') {
            const target = group.members.find(
              (m) =>
                m.accountId === command.targetAccountId && m.accountId !== id,
            );
            if (group.coordinatorAccountId !== id || !target)
              throw new Error('无权转交该角色');
            if (
              group.travelMode === 'private_vehicle' &&
              !intents
                .find((i) => i.accountId === target.accountId)
                ?.travelOptions.includes('driver')
            )
              throw new Error('接任者未选择我有车');
            group.transfer = { from: id, to: target.accountId, createdAt: now };
            notice(
              state,
              target.accountId,
              'transfer',
              `${group.id}:${group.version}`,
              '请确认是否接任同行组管理角色',
              now,
            );
          } else {
            if (group.transfer?.to !== id) throw new Error('无权接受转交');
            if (
              group.travelMode === 'private_vehicle' &&
              !mine?.travelOptions.includes('driver')
            )
              throw new Error('接任者未选择我有车');
            if (group.travelMode === 'private_vehicle') {
              if (
                ![1, 2, 3].includes(command.passengerCapacity!) ||
                command.passengerCapacity! < group.members.length - 1
              )
                throw new Error('请确认能容纳现有成员的乘客容量');
              group.passengerCapacity = command.passengerCapacity!;
            }
            group.coordinatorAccountId = id;
            if (group.travelMode === 'private_vehicle')
              group.driverAccountId = id;
            delete group.transfer;
            group.version += 1;
            group.status =
              group.members.length >= group.passengerCapacity + 1
                ? 'full'
                : 'active';
            for (const member of group.members)
              notice(
                state,
                member.accountId,
                'transfer_accepted',
                `${group.id}:${group.version}`,
                '司机/协调人转交已获本人同意，请查看本次同行方式与容量',
                now,
              );
          }
        } else if (command.type === 'report_message') {
          const event = state.transport?.events.find(
            (event) =>
              event.id === command.eventId &&
              event.conversationId === command.conversationId,
          );
          const generation = state.conversations
            .find((conversation) => conversation.id === command.conversationId)
            ?.generations.find(
              (generation) => generation.generation === event?.generation,
            );
          const target = event?.sender.split('/')[2];
          if (
            !event ||
            !target ||
            target === id ||
            !generation?.members.some((member) => member.accountId === id) ||
            !generation.members.some((member) => member.accountId === target)
          )
            throw new Error('无权举报该消息');
          if (
            !state.reports.some(
              (report) =>
                report.reporter === id && report.evidence?.eventId === event.id,
            )
          )
            state.reports.push({
              id: randomUUID(),
              reporter: id,
              target,
              reason: text(command.reason, '举报原因'),
              createdAt: now,
              status: 'open',
              evidence: {
                firstMessage: text(command.plaintext, '提交的消息内容', 4000),
                kind: 'chat_message',
                source: 'reporter_submission',
                conversationId: command.conversationId,
                eventId: event.id,
                ciphertext: event.ciphertext,
                createdAt: event.createdAt,
              },
            });
        } else if (command.type === 'report') {
          const request = state.requests.find(
            (r) =>
              r.id === command.requestId &&
              [r.senderAccountId, r.receiverAccountId].includes(id) &&
              [r.senderAccountId, r.receiverAccountId].includes(
                command.targetAccountId,
              ),
          );
          if (!request || command.targetAccountId === id)
            throw new Error('无权举报该请求');
          state.reports.push({
            id: randomUUID(),
            reporter: id,
            target: command.targetAccountId,
            requestId: request.id,
            reason: text(command.reason, '举报原因'),
            createdAt: now,
            status: 'open',
            evidence: {
              firstMessage: request.firstMessage,
              kind: request.kind,
              createdAt: request.createdAt,
            },
          });
        } else if (command.type === 'resolve_report') {
          if (!actor!.parkAdmin) throw new Error('无权处理园区举报');
          const report = state.reports.find((r) => r.id === command.reportId);
          if (!report) throw new Error('举报不存在');
          report.status = 'resolved';
          report.resolvedAt = now;
          report.resolvedBy = id;
          report.resolution = text(command.resolution, '处理说明');
          notice(
            state,
            report.reporter,
            'report_resolved',
            report.id,
            '举报已处理，请查看处理结果',
            now,
          );
        } else throw new Error('同行操作无效');
        reconcile(ctx, now);
        for (const group of state.groups.filter(activeGroup))
          for (const member of group.members) {
            const row = carpoolMeasurement(state, member.accountId, now);
            row.maximumGroupSize = Math.max(
              row.maximumGroupSize,
              group.members.length,
            );
          }
        return view(ctx);
      });
    },
  };
}
function validateMode(
  mode: CarpoolTravelMode | undefined,
  driver: string | undefined,
  members: ParkCarpoolIntent[],
  capacity: number | undefined,
  capacityActor?: string,
) {
  if (mode === 'shared_taxi') {
    if (
      driver ||
      !members.every((i) => i.travelOptions.includes('shared_taxi'))
    )
      throw new Error('同行方式不兼容');
  } else if (mode === 'private_vehicle') {
    if (
      !driver ||
      !members.some(
        (i) => i.accountId === driver && i.travelOptions.includes('driver'),
      ) ||
      !members
        .filter((i) => i.accountId !== driver)
        .every((i) => i.travelOptions.includes('rider'))
    )
      throw new Error('同行方式或司机无效');
    if (capacityActor === driver && ![1, 2, 3].includes(capacity!))
      throw new Error('司机必须确认本次乘客容量1/2/3');
  } else throw new Error('请明确选择本次同行方式和司机');
}

export type CarpoolWorkflowView = Omit<
  Awaited<ReturnType<ReturnType<typeof createCarpoolWorkflow>['read']>>,
  'groupedAccountIds' | 'unavailableAccountIds'
>;
