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
