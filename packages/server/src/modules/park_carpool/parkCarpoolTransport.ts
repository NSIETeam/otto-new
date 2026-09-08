import { readCarpoolConfig } from './parkCarpoolConfig.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID, verify } from 'node:crypto';
import {
  createCarpoolWorkflow,
  type CarpoolConversation,
  type CarpoolWorkflowContext,
} from './parkCarpoolWorkflow.js';
import type { ParkCarpoolStore } from './parkCarpoolService.js';

export interface ParkTransportProof {
  timestamp: string;
  signature: string;
}
export interface ParkCryptoAuthority {
  park_id: string;
  conversation_id: string;
  generation: number;
  members: string[];
}
interface Package {
  device_scope: string;
  reference: string;
  key_package: string;
  claimedBy?: string;
  createdAt: string;
}
interface CryptoSession {
  conversationId: string;
  generation: number;
  authority: ParkCryptoAuthority;
  initializer: string;
  leaseId: string;
  leaseUntil: number;
  packages: Package[];
  groupId?: string;
  welcome?: string;
  status: 'preparing' | 'active' | 'retired';
}
export interface ParkCipherEvent {
  id: string;
  sequence: number;
  conversationId: string;
  generation: number;
  sender: string;
  groupId: string;
  epoch: number;
  ciphertext: string;
  createdAt: string;
}
export interface ParkCarpoolTransportState {
  packages: Package[];
  sessions: CryptoSession[];
  events: ParkCipherEvent[];
  reads: Array<{ accountId: string; conversationId: string; sequence: number }>;
}
export type ParkTransportCommand =
  | {
      type: 'publish_key';
      deviceId: string;
      deviceScope: string;
      reference: string;
      keyPackage: string;
      expired?: boolean;
    }
  | {
      type: 'rekey';
      deviceId: string;
      conversationId: string;
      expectedGeneration: number;
      availableReferences: string[];
    }
  | { type: 'state'; deviceId: string; conversationId: string }
  | {
      type: 'activate';
      deviceId: string;
      conversationId: string;
      generation: number;
      leaseId: string;
      groupId: string;
      welcome: string;
    }
  | {
      type: 'append';
      deviceId: string;
      conversationId: string;
      generation: number;
      eventId: string;
      groupId: string;
      epoch: number;
      ciphertext: string;
    }
  | {
      type: 'read';
      deviceId: string;
      conversationId: string;
      sequence: number;
    };
function base64(value: unknown, max: number) {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > max ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error('加密数据格式或大小无效');
  return value;
}
function identifier(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
  )
    throw new Error('加密对象标识无效');
  return value;
}
function currentGeneration(conversation: CarpoolConversation) {
  return conversation.generations.find(
    (g) => g.generation === conversation.generation,
  );
}
function rotateForDevices(conversation: CarpoolConversation, now: string) {
  const last = currentGeneration(conversation);
  if (!last) throw new Error('会话已归档');
  last.retiredAt = now;
  conversation.generation += 1;
  conversation.status = 'preparing_keys';
  conversation.generations.push({
    generation: conversation.generation,
    members: last.members.map((m) => ({ ...m })),
    createdAt: now,
  });
}
export function createParkCarpoolTransport(input: {
  store: ParkCarpoolStore;
  now?(): Date;
}) {
  const workflow = createCarpoolWorkflow(input);
  return {
    execute: (
      accountId: string,
      command: ParkTransportCommand,
      proof?: ParkTransportProof,
    ) =>
      workflow.withContext(accountId, (ctx, now) => {
        const { state, actor } = ctx;
        const deviceId = identifier(command.deviceId);
        const device = ctx.devices?.find(
          (d) =>
            d.accountId === accountId &&
            d.organizationId === actor!.organizationId &&
            d.deviceId === deviceId,
        );
        if (!device) throw new Error('无权使用该加密设备，设备未批准或已撤销');
        if (proof) {
          try {
            const timestamp = Date.parse(proof.timestamp);
            if (
              !Number.isFinite(timestamp) ||
              Math.abs(timestamp - Date.parse(now)) > 60_000 ||
              !device.identitySigningPublicKey ||
              typeof proof.signature !== 'string' ||
              proof.signature.length > 100
            )
              throw new Error();
            const bytes = Buffer.from(
              JSON.stringify([
                'otto:park-carpool-device:v1',
                accountId,
                proof.timestamp,
                command,
              ]),
            );
            if (
              !verify(
                null,
                bytes,
                device.identitySigningPublicKey,
                Buffer.from(proof.signature, 'base64'),
              )
            )
              throw new Error();
          } catch {
            throw new Error('无权使用该加密设备，签名无效或已过期');
          }
        }
        const transport = (state.transport ??= {
          packages: [],
          sessions: [],
          events: [],
          reads: [],
        });
        if (command.type === 'publish_key') {
          const parts = command.deviceScope?.split('/');
          if (
            parts?.length !== 4 ||
            !/^[0-9a-f]{64}$/.test(parts[0]!) ||
            parts[1] !== device.organizationId ||
            parts[2] !== accountId ||
            parts[3] !== deviceId
          )
            throw new Error('设备密钥身份绑定无效');
          if (!/^[0-9a-f]{64}$/.test(command.reference))
            throw new Error('密钥引用无效');
          base64(command.keyPackage, 128 * 1024);
          const existing = transport.packages.find(
            (p) => p.reference === command.reference,
          );
          if (existing) {
            if (
              existing.device_scope !== command.deviceScope ||
              existing.key_package !== command.keyPackage
            )
              throw new Error('密钥引用冲突');
            if (command.expired && !existing.claimedBy)
              existing.createdAt = '1970-01-01T00:00:00.000Z';
            const usable =
              !command.expired &&
              !existing.claimedBy &&
              Date.parse(existing.createdAt) > Date.parse(now) - 86400_000;
            // An offline device still needs the private package for a persisted Welcome,
            // including retired generations whose history remains readable.
            const needed = transport.sessions.some(
              (session) =>
                session.packages.some(
                  (key) => key.reference === existing.reference,
                ) &&
                (Boolean(session.welcome) ||
                  (session.status === 'preparing' &&
                    session.leaseUntil > Date.parse(now))),
            );
            return { published: true, usable, retirable: !usable && !needed };
          }
          if (command.expired)
            return { published: false, usable: false, retirable: true };
          if (
            transport.packages.filter(
              (p) =>
                p.device_scope === command.deviceScope &&
                !p.claimedBy &&
                Date.parse(p.createdAt) > Date.parse(now) - 86400_000,
            ).length >= 30
          )
            throw new Error('设备待用密钥数量已达上限');
          transport.packages.push({
            device_scope: command.deviceScope,
            reference: command.reference,
            key_package: command.keyPackage,
            createdAt: now,
          });
          return { published: true, usable: true };
        }
        const conversationId = identifier(command.conversationId);
        const conversation = state.conversations.find(
          (c) =>
            c.id === conversationId &&
            c.generations.some((g) =>
              g.members.some(
                (m) =>
                  m.accountId === accountId &&
                  m.organizationId === actor!.organizationId,
              ),
            ),
        );
        if (!conversation) throw new Error('无权读取同行会话');
        if (conversation.status === 'blocked') throw new Error('会话已屏蔽');
        let generation = currentGeneration(conversation);
        const isMember = Boolean(
          generation?.members.some(
            (m) =>
              m.accountId === accountId &&
              m.organizationId === actor!.organizationId,
          ),
        );
        // Approval changes freeze old ciphertext writes before constructing a new roster.
        let current = transport.sessions.find(
          (s) =>
            s.conversationId === conversationId &&
            s.generation === conversation.generation,
        );
        if (
          current &&
          current.status !== 'retired' &&
          conversation.status !== 'archived'
        ) {
          const approved = approvedRoster(
            ctx,
            transport,
            conversation,
            current.authority.members[0]!.split('/')[0]!,
          );
          if (
            JSON.stringify(approved) !==
              JSON.stringify(current.authority.members) ||
            (current.status === 'preparing' &&
              current.leaseUntil <= Date.parse(now))
          ) {
            current.status = 'retired';
            rotateForDevices(conversation, now);
            generation = currentGeneration(conversation);
            current = undefined;
          }
        }
        for (const session of transport.sessions)
          if (
            session.conversationId === conversationId &&
            session.generation !== conversation.generation
          )
            session.status = 'retired';
        if (command.type === 'rekey') {
          if (!isMember || conversation.status === 'archived')
            throw new Error('无权恢复该会话密钥');
          if (command.expectedGeneration !== conversation.generation)
            throw new Error('会话已更新，请刷新后重试');
          if (
            current &&
            Date.parse(now) - Date.parse(generation!.createdAt) < 60_000
          )
            throw new Error('密钥刚刚更新，请一分钟后重试');
          if (
            !Array.isArray(command.availableReferences) ||
            command.availableReferences.length > 100 ||
            command.availableReferences.some(
              (ref) => typeof ref !== 'string' || !/^[0-9a-f]{64}$/.test(ref),
            )
          )
            throw new Error('本机密钥清单无效');
          for (const key of transport.packages)
            if (
              key.device_scope.endsWith(
                `/${device.organizationId}/${accountId}/${deviceId}`,
              ) &&
              !key.claimedBy &&
              !command.availableReferences.includes(key.reference)
            )
              key.claimedBy = 'retired-after-device-recovery';
          if (current) current.status = 'retired';
          rotateForDevices(conversation, now);
          for (const member of generation!.members)
            state.notices.push({
              id: `rekey:${conversationId}:${conversation.generation}:${member.accountId}`,
              accountId: member.accountId,
              type: 'keys_changed',
              subjectId: conversationId,
              text: '同行成员请求恢复加密密钥，历史消息不会重新分发',
              createdAt: now,
            });
          return { rekeyed: true, generation: conversation.generation };
        }
        if (command.type === 'activate' || command.type === 'append') {
          if (!readCarpoolConfig().requestsEnabled)
            throw new Error('服务器已暂停同行消息写入，历史仍可查看');
          if (
            !isMember ||
            conversation.status === 'archived' ||
            command.generation !== conversation.generation ||
            !current
          )
            throw new Error('无权写入，同行会话成员或代次已变化');
          const scope = current.authority.members.find((s) =>
            s.endsWith(`/${device.organizationId}/${accountId}/${deviceId}`),
          );
          if (!scope) throw new Error('无权使用该会话设备');
          if (command.type === 'activate') {
            if (
              current.initializer !== scope ||
              current.leaseId !== command.leaseId
            )
              throw new Error('无权激活该加密会话');
            base64(command.groupId, 128);
            base64(command.welcome, 2 * 1024 * 1024);
            if (current.status === 'active') {
              if (
                current.groupId !== command.groupId ||
                current.welcome !== command.welcome
              )
                throw new Error('加密激活回执冲突');
              return { active: true };
            }
            current.groupId = command.groupId;
            current.welcome = command.welcome;
            current.status = 'active';
            conversation.status = 'active';
            return { active: true };
          }
          if (
            current.status !== 'active' ||
            current.groupId !== command.groupId ||
            command.epoch !== 1
          )
            throw new Error('加密会话尚未就绪或密钥代次不匹配');
          identifier(command.eventId);
          base64(command.ciphertext, 128 * 1024);
          const previous = transport.events.find(
            (e) => e.id === command.eventId,
          );
          if (previous) {
            if (
              previous.conversationId !== conversationId ||
              previous.generation !== command.generation ||
              previous.sender !== scope ||
              previous.ciphertext !== command.ciphertext
            )
              throw new Error('消息标识内容冲突');
            return { event: previous };
          }
          if (
            transport.events.filter(
              (e) =>
                e.sender === scope &&
                Date.parse(e.createdAt) > Date.parse(now) - 60_000,
            ).length >= 30
          )
            throw new Error('发送过于频繁，请稍后重试');
          if (
            transport.events.filter((e) => e.conversationId === conversationId)
              .length >= 1000
          )
            throw new Error('本次同行会话消息数量已达上限');
          const event: ParkCipherEvent = {
            id: command.eventId,
            sequence: (transport.events.at(-1)?.sequence ?? 0) + 1,
            conversationId,
            generation: command.generation,
            sender: scope,
            groupId: command.groupId,
            epoch: command.epoch,
            ciphertext: command.ciphertext,
            createdAt: now,
          };
          transport.events.push(event);
          for (const member of generation!.members)
            if (member.accountId !== accountId)
              state.notices.push({
                id: `message:${event.id}:${member.accountId}`,
                accountId: member.accountId,
                type: 'message',
                subjectId: conversationId,
                text: '收到一条同行加密消息',
                createdAt: now,
              });
          return { event };
        }
        if (command.type === 'read') {
          if (!Number.isSafeInteger(command.sequence) || command.sequence < 0)
            throw new Error('已读位置无效');
          const accessible = visibleEvents(
            transport,
            conversation,
            accountId,
            deviceId,
          );
          if (
            command.sequence > Math.max(0, ...accessible.map((e) => e.sequence))
          )
            throw new Error('无权标记该消息已读');
          const previous = transport.reads.find(
            (r) =>
              r.accountId === accountId && r.conversationId === conversationId,
          );
          if (previous)
            previous.sequence = Math.max(previous.sequence, command.sequence);
          else
            transport.reads.push({
              accountId,
              conversationId,
              sequence: command.sequence,
            });
          for (const notice of state.notices)
            if (
              notice.accountId === accountId &&
              notice.type === 'message' &&
              notice.subjectId === conversationId &&
              accessible.some(
                (event) =>
                  event.sequence <= command.sequence &&
                  notice.id === `message:${event.id}:${accountId}`,
              )
            )
              notice.readAt = now;
          return { read: true };
        }
        if (command.type !== 'state') throw new Error('未知加密操作');
        if (!current && isMember && conversation.status !== 'archived') {
          const ownPackage = transport.packages.find((p) =>
            p.device_scope.endsWith(
              `/${device.organizationId}/${accountId}/${deviceId}`,
            ),
          );
          if (ownPackage) {
            const roster = approvedRoster(
              ctx,
              transport,
              conversation,
              ownPackage.device_scope.split('/')[0]!,
            );
            const packages = roster
              .filter((s) => s !== ownPackage.device_scope)
              .map((scope) =>
                transport.packages.find(
                  (p) =>
                    p.device_scope === scope &&
                    !p.claimedBy &&
                    Date.parse(p.createdAt) > Date.parse(now) - 86400_000,
                ),
              );
            if (
              generation!.members.every((m) =>
                roster.some(
                  (s) =>
                    s.split('/')[1] === m.organizationId &&
                    s.split('/')[2] === m.accountId,
                ),
              ) &&
              packages.every(Boolean) &&
              roster.includes(ownPackage.device_scope)
            ) {
              const leaseId = randomUUID();
              current = {
                conversationId,
                generation: conversation.generation,
                authority: {
                  park_id: actor!.parkId!,
                  conversation_id: conversationId,
                  generation: conversation.generation,
                  members: roster,
                },
                initializer: ownPackage.device_scope,
                leaseId,
                leaseUntil: Date.parse(now) + 60_000,
                packages: packages as Package[],
                status: 'preparing',
              };
              for (const package_ of packages) package_!.claimedBy = leaseId;
              transport.sessions.push(current);
            }
          }
        }
        const sessions = transport.sessions.filter(
          (s) =>
            s.conversationId === conversationId &&
            s.authority.members.some((member) =>
              member.endsWith(
                `/${device.organizationId}/${accountId}/${deviceId}`,
              ),
            ),
        );
        return {
          conversationId,
          participants: [
            ...new Set(
              sessions.flatMap((session) =>
                session.authority.members.map(
                  (member) => member.split('/')[2]!,
                ),
              ),
            ),
          ].map((memberId, index) => {
            const member = ctx.intents.find(
              (intent) => intent.accountId === memberId,
            );
            const group = ctx.state.groups.find(
              (group) => group.id === conversation.groupId,
            );
            const role =
              group?.driverAccountId === memberId
                ? '司机'
                : group?.coordinatorAccountId === memberId
                  ? '协调人'
                  : '同行成员';
            return {
              accountId: memberId,
              displayName: `${member?.displayName.slice(0, 1) || '园区'}同事（成员 ${index + 1}）`,
              role,
            };
          }),
          writeEnabled: readCarpoolConfig().requestsEnabled,
          status: conversation.status,
          generation: conversation.generation,
          sessions: sessions.map((s) => ({
            authority: s.authority,
            groupId: s.groupId,
            welcome: s.welcome,
            status: s.status,
            initializer: s.initializer,
            reference: s.packages.find((p) =>
              p.device_scope.endsWith(
                `/${device.organizationId}/${accountId}/${deviceId}`,
              ),
            )?.reference,
            initialization:
              s.status === 'preparing' &&
              s.initializer.endsWith(
                `/${device.organizationId}/${accountId}/${deviceId}`,
              )
                ? {
                    leaseId: s.leaseId,
                    packages: s.packages.map((p) => ({
                      device_scope: p.device_scope,
                      reference: p.reference,
                      key_package: p.key_package,
                    })),
                  }
                : undefined,
          })),
          events: visibleEvents(transport, conversation, accountId, deviceId),
          readSequence:
            transport.reads.find(
              (r) =>
                r.accountId === accountId &&
                r.conversationId === conversationId,
            )?.sequence ?? 0,
        };
      }),
  };
}
function approvedRoster(
  ctx: CarpoolWorkflowContext,
  transport: ParkCarpoolTransportState,
  conversation: CarpoolConversation,
  serverScope: string,
): string[] {
  const members = currentGeneration(conversation)?.members ?? [];
  return (ctx.devices ?? [])
    .filter((d) =>
      members.some(
        (m) =>
          m.accountId === d.accountId && m.organizationId === d.organizationId,
      ),
    )
    .map(
      (d) => `${serverScope}/${d.organizationId}/${d.accountId}/${d.deviceId}`,
    )
    .filter((scope) => transport.packages.some((p) => p.device_scope === scope))
    .sort();
}
function visibleEvents(
  transport: ParkCarpoolTransportState,
  conversation: CarpoolConversation,
  accountId: string,
  deviceId: string,
) {
  const generations = new Set(
    transport.sessions
      .filter(
        (s) =>
          s.conversationId === conversation.id &&
          s.authority.members.some(
            (m) =>
              m.split('/')[2] === accountId && m.split('/')[3] === deviceId,
          ),
      )
      .map((s) => s.generation),
  );
  return transport.events.filter(
    (e) =>
      e.conversationId === conversation.id && generations.has(e.generation),
  );
}

export type ParkTransportResult = Awaited<
  ReturnType<ReturnType<typeof createParkCarpoolTransport>['execute']>
>;
export type ParkTransportView = Extract<
  ParkTransportResult,
  { conversationId: string }
>;
