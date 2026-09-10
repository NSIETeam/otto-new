/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { CarpoolWorkflowState } from './parkCarpoolWorkflow.js';
export interface CarpoolMaintenanceInput {
  now: string;
  positionRetentionHours: number;
  communicationRetentionDays?: number;
  deleteAccountId?: string;
}
export interface CarpoolMaintenanceResult {
  accountIds: string[];
  deletedPositions: number;
  scanned?: { intents: number; publications: number; workflows: number };
  deferred?: Array<{ parkId: string; reason: string }>;
  checkedParkIds?: string[];
}
export const CARPOOL_BACKGROUND = { workflowBytes: 1024 * 1024, principals: 256, intents: 200, devices: 256 } as const;
export class CarpoolMaintenanceDeferred extends Error {
  constructor(readonly parkId: string, readonly reason: string) { super(`同行后台刷新已延后：${reason}`); }
}
export interface CarpoolMaintenanceCursor { after?: string[]; end?: string[] }
// Process-local cursors deliberately reset on restart. A fixed high-water mark
// completes each finite cycle even while later keys are being inserted.
export function advanceCarpoolMaintenanceCursor(cursor: CarpoolMaintenanceCursor, keys: string[][], limit: number): void {
  const last = keys.at(-1);
  if (keys.length < limit || JSON.stringify(last) === JSON.stringify(cursor.end)) {
    delete cursor.after; delete cursor.end;
  } else cursor.after = last;
}
export function carpoolWorkflowAccountScopes(state: CarpoolWorkflowState): Map<string, Set<string>> {
  const ids = new Map<string, Set<string>>();
  const add = (id?: string, organization?: string) => { if (id && id !== 'deleted') { const scopes = ids.get(id) ?? new Set<string>(); if (organization) scopes.add(organization); ids.set(id, scopes); } };
  for (const row of state.requests) { add(row.senderAccountId, row.senderOrganizationId); add(row.receiverAccountId, row.receiverOrganizationId); }
  for (const group of state.groups) { add(group.coordinatorAccountId); add(group.driverAccountId); for (const member of group.members) add(member.accountId, member.organizationId); }
  for (const conversation of state.conversations) for (const generation of conversation.generations) for (const member of generation.members) add(member.accountId, member.organizationId);
  for (const row of state.blocks) { add(row.from); add(row.to); }
  for (const row of state.notices) add(row.accountId);
  for (const row of state.availability) add(row.accountId);
  for (const row of state.measurements ?? []) add(row.accountId);
  for (const row of state.reports) { add(row.reporter); add(row.target); }
  for (const row of state.transport?.events ?? []) add(row.sender.split('/')[2], row.sender.split('/')[1]);
  for (const row of state.transport?.reads ?? []) add(row.accountId);
  for (const row of state.transport?.packages ?? []) add(row.device_scope.split('/')[2], row.device_scope.split('/')[1]);
  return ids;
}
export function pruneCarpoolWorkflow(
  state: CarpoolWorkflowState,
  now: string,
  deletedAccounts: readonly string[] = [],
  retentionDays = 30,
): void {
  const deleted = new Set(deletedAccounts);
  const cutoff = Date.parse(now) - retentionDays * 86400_000;
  state.measurements = state.measurements?.filter(
    (row) =>
      !deleted.has(row.accountId) &&
      Date.parse(row.day + 'T00:00:00+08:00') > cutoff,
  );
  state.requests = state.requests.filter(
    (request) =>
      !deleted.has(request.senderAccountId) &&
      !deleted.has(request.receiverAccountId) &&
      Date.parse(request.createdAt) > cutoff,
  );
  state.notices = state.notices.filter(
    (notice) =>
      !deleted.has(notice.accountId) && Date.parse(notice.createdAt) > cutoff,
  );
  state.blocks = state.blocks.filter((block) => !deleted.has(block.from));
  state.availability = state.availability.filter(
    (entry) => !deleted.has(entry.accountId),
  );
  for (const group of state.groups) {
    const remaining = group.members.filter(
      (member) => !deleted.has(member.accountId),
    );
    if (remaining.length !== group.members.length) {
      group.members = remaining;
      group.version += 1;
      delete group.intentFingerprint;
      delete group.transfer;
      if (!['closed', 'expired'].includes(group.status))
        group.status =
          remaining.length < 2
            ? 'closed'
            : remaining.some(
                  (member) => member.accountId === group.coordinatorAccountId,
                )
              ? group.status
              : 'closed_to_new_members';
    }
  }
  state.groups = state.groups.filter(
    (group) => Date.parse(group.expiresAt) > cutoff,
  );
  for (const conversation of state.conversations) {
    const latest = conversation.generations.find(
      (generation) => generation.generation === conversation.generation,
    );
    const remaining =
      latest?.members.filter((member) => !deleted.has(member.accountId)) ?? [];
    if (
      latest &&
      !['archived', 'blocked'].includes(conversation.status) &&
      remaining.length !== latest.members.length
    ) {
      latest.retiredAt = now;
      conversation.generation += 1;
      conversation.status =
        remaining.length < 2 ? 'archived' : 'preparing_keys';
      if (remaining.length >= 2)
        conversation.generations.push({
          generation: conversation.generation,
          members: remaining,
          createdAt: now,
        });
    }
    for (const generation of conversation.generations)
      generation.members = generation.members.filter(
        (member) => !deleted.has(member.accountId),
      );
  }
  state.conversations = state.conversations.filter((conversation) =>
    conversation.generations.some(
      (generation) =>
        generation.members.length && Date.parse(generation.createdAt) > cutoff,
    ),
  );
  const conversations = new Set(
    state.conversations.map((conversation) => conversation.id),
  );
  for (const report of state.reports)
    if (deleted.has(report.reporter) || deleted.has(report.target)) {
      if (deleted.has(report.reporter)) report.reporter = 'deleted';
      if (deleted.has(report.target)) report.target = 'deleted';
      report.reason = '相关账号已删除同行数据';
      report.requestId = undefined;
      report.evidence = undefined;
    }
  state.reports = state.reports.filter(
    (report) =>
      Date.parse(report.createdAt) > cutoff || report.status === 'open',
  );
  if (state.transport) {
    state.transport.events = state.transport.events.filter(
      (event) =>
        conversations.has(event.conversationId) &&
        !deleted.has(event.sender.split('/')[2]!) &&
        Date.parse(event.createdAt) > cutoff,
    );
    state.transport.sessions = state.transport.sessions.filter((session) =>
      conversations.has(session.conversationId),
    );
    state.transport.reads = state.transport.reads.filter(
      (read) =>
        conversations.has(read.conversationId) && !deleted.has(read.accountId),
    );
    // Keep recent consumed references for replay rejection; old key material is never reused.
    state.transport.packages = state.transport.packages.filter(
      (key) =>
        !deleted.has(key.device_scope.split('/')[2]!) &&
        (Date.parse(key.createdAt) > cutoff ||
          state.transport!.sessions.some((session) =>
            session.packages.some((item) => item.reference === key.reference),
          )),
    );
  }
}
