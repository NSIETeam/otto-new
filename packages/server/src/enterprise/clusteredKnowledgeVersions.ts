/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  PostgresBusinessRecord,
  PostgresEnterpriseBusinessRepository,
} from './postgresBusinessRepository.js';

export type ClusteredKnowledgePayload = {
  title: string | null;
  department: string | null;
  category: string;
  content: string;
  tags: string[];
  contributor: string;
  contributorAccountId: string;
  confidence: number;
  sourceType: string;
  sourceId: string | null;
  sourceLabel: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewDueAt?: string | null;
  expiresAt?: string | null;
};

interface KnowledgeSnapshot {
  id: string;
  knowledgeId: string;
  version: number;
  payload: ClusteredKnowledgePayload;
  status: string;
  changedBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Only server-stored, tenant-bound snapshots are restorable; incomplete legacy events are not snapshots. */
export async function listClusteredKnowledgeSnapshots(
  repository: Pick<PostgresEnterpriseBusinessRepository, 'listBusinessEvents'>,
  current: PostgresBusinessRecord<ClusteredKnowledgePayload>,
): Promise<KnowledgeSnapshot[]> {
  const events = await repository.listBusinessEvents({
    organizationId: current.organizationId,
    domain: 'knowledge',
    resourceType: 'entry',
    resourceId: current.resourceId,
    limit: 500,
    newestFirst: true,
  });
  const byVersion = new Map<number, KnowledgeSnapshot>();
  const add = (value: unknown): void => {
    const snapshot = object(value);
    const payload = object(snapshot.payload);
    const version = Number(snapshot.version);
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > current.version ||
      typeof payload.content !== 'string' ||
      !payload.content.trim() ||
      typeof payload.category !== 'string' ||
      !payload.category.trim() ||
      (payload.title !== null && typeof payload.title !== 'string')
    )
      return;
    byVersion.set(version, {
      id: `${current.resourceId}:v${version}`,
      knowledgeId: current.resourceId,
      version,
      payload: payload as ClusteredKnowledgePayload,
      status: typeof snapshot.status === 'string' ? snapshot.status : 'unknown',
      changedBy:
        typeof snapshot.changedBy === 'string' ? snapshot.changedBy : null,
      changeNote:
        typeof snapshot.changeNote === 'string' ? snapshot.changeNote : null,
      createdAt:
        typeof snapshot.createdAt === 'string' ? snapshot.createdAt : '',
    });
  };
  for (const event of [...events].reverse()) {
    if (
      event.organizationId !== current.organizationId ||
      event.domain !== 'knowledge' ||
      event.resourceType !== 'entry' ||
      event.resourceId !== current.resourceId
    )
      continue;
    const details = object(event.payload);
    if (details.previous)
      add({
        version: details.fromVersion,
        payload: details.previous,
        changeNote: '旧版修订前快照（原始变更原因未记录）',
      });
    add(details.previousSnapshot);
    add(details.currentSnapshot);
  }
  const existing = byVersion.get(current.version);
  add({
    ...existing,
    version: current.version,
    payload: current.payload,
    status: current.status,
    createdAt: current.updatedAt,
    changedBy: existing?.changedBy ?? current.payload.reviewedBy,
    changeNote: existing?.changeNote ?? '当前版本',
  });
  return [...byVersion.values()].sort((a, b) => b.version - a.version);
}

export function clusteredKnowledgeSnapshotView(snapshot: KnowledgeSnapshot) {
  const { payload, ...meta } = snapshot;
  return {
    ...meta,
    title: payload.title,
    category: payload.category,
    content: payload.content,
  };
}
