/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import type { RecurringTaskRegistry } from 'otto-core';
import { RecruitmentJobError, type RecruitmentJobActor, type RecruitmentSharedJob } from './recruitmentJobs.js';
import type { RecruitmentJobStore } from './recruitmentJobStore.js';
import { recruitmentSyncMetadata } from './recruitmentCollaboration.js';
import { projectRecruitmentArchive } from './recruitmentAutoArchiveDocument.js';

export interface RecruitmentArchiveReceipt {
  status: 'created' | 'updated' | 'unchanged' | 'needs_review'; at: string; message: string; candidateId?: string;
}
export interface RecruitmentAutoArchiveState {
  enabled: boolean; generation: string; actorAccountId: string; confirmedAt: string; expiresAt: string;
  retentionDays: 7 | 30 | 90; scopeToken: string; headerToken: string; message: string; lastRunAt?: string;
  /** Source hashes and deletion barriers, never raw resumes. Kept until this job is deleted. */
  bindings: Array<{ sourceKey: string; candidateId: string; documentToken: string; retrievedAt: string; runId: string }>;
}
export type RecruitmentAutoArchiveAction = { kind: 'configure_auto_archive'; jobId: string; expectedRevision: number; enabled: boolean; confirmed: true; retentionDays?: number };
export function configureRecruitmentAutoArchive(job: RecruitmentSharedJob, actor: RecruitmentJobActor, action: RecruitmentAutoArchiveAction, now: string): RecruitmentAutoArchiveState {
  if (!actor.isAdmin && actor.id !== job.ownerAccountId) throw new RecruitmentJobError(403, '仅岗位创建者或企业管理员可授权自动正式入档');
  if (action.confirmed !== true || typeof action.enabled !== 'boolean') throw new RecruitmentJobError(400, '请独立确认自动建档、更新及当前岗位共享范围');
  const days = action.retentionDays ?? job.autoArchive?.retentionDays ?? 30;
  if (![7, 30, 90].includes(days)) throw new RecruitmentJobError(400, '自动入档授权与保留期仅支持 7、30 或 90 天');
  const sync = recruitmentSyncMetadata(job);
  return { scopeToken: sync.scopeToken, headerToken: sync.headerToken, enabled: action.enabled, generation: randomUUID(), actorAccountId: actor.id, confirmedAt: now,
    expiresAt: new Date(Date.parse(now) + days * 86_400_000).toISOString(), retentionDays: days as 7 | 30 | 90,
    bindings: job.autoArchive?.bindings ?? [], message: action.enabled ? '已授权：后台已完成结果将自动正式入档；不覆盖人工修改，不新增模型调用' : '自动入档已暂停；已保存的正式档案保留' };
}
// Canonical object order avoids misidentifying a harmless client JSON round-trip as an edit.
export function recruitmentArchiveDocumentToken(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([key, data]) => [key, stable(data)])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export class RecruitmentAutoArchiveWorker {
  private cursor = { organizationId: '', jobId: '' };
  constructor(private readonly options: {
    store: RecruitmentJobStore; getActor(id: string): Promise<RecruitmentJobActor | null>; isEntitled(org: string): Promise<boolean>;
    audit(event: { organizationId: string; jobId: string; actorAccountId: string; runId: string; phase: 'requested' | 'completed' }): Promise<void>;
    now?: () => number;
  }) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private async valid(org: string, job: RecruitmentSharedJob): Promise<boolean> {
    const config = job.autoArchive; if (!config?.enabled || Date.parse(config.expiresAt) <= this.now()) return false;
    const actor = await this.options.getActor(config.actorAccountId); const sync = recruitmentSyncMetadata(job);
    return Boolean(actor?.active && actor.organizationId === org && (actor.isAdmin || actor.id === job.ownerAccountId)
      && config.scopeToken === sync.scopeToken && config.headerToken === sync.headerToken && await this.options.isEntitled(org));
  }
  async tick(signal?: AbortSignal): Promise<void> {
    const page = await this.options.store.scan?.(this.cursor, 50); if (!page) return;
    let processed = 0;
    for (const entry of page.jobs) {
      if (signal?.aborted) return;
      this.cursor = { organizationId: entry.organizationId, jobId: entry.job.id };
      if (entry.job.autoArchive?.enabled) { await this.run(entry.organizationId, entry.job.id, signal); if (++processed >= 10) return; }
    }
    if (!page.hasMore) this.cursor = { organizationId: '', jobId: '' };
  }
  private async run(org: string, id: string, signal?: AbortSignal): Promise<void> {
    const { store } = this.options; const first = await store.get(org, id); if (!first?.autoArchive?.enabled) return;
    const generation = first.autoArchive.generation;
    for (let tries = 0; tries < 8; tries++) {
      const job = await store.get(org, id); if (!job?.autoArchive?.enabled || job.autoArchive.generation !== generation || signal?.aborted) return;
      if (!await this.valid(org, job)) {
        if (signal?.aborted) return;
        await store.compareAndSet(org, job.revision, { ...job, revision: job.revision + 1, autoArchive: { ...job.autoArchive, enabled: false, message: '自动入档授权到期，或账号、许可、岗位要求、共享范围已变化；请重新核对授权' } }); return;
      }
      const item = job.incomingMaterials?.filter((entry) => !entry.archive && !entry.manualAnalysis && entry.analysis?.status === 'completed' && Date.parse(entry.expiresAt) > this.now())
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))[0];
      if (!item) return;
      const at = new Date(this.now()).toISOString(); const next = await projectRecruitmentArchive(job, item, at);
      const event = { organizationId: org, jobId: id, actorAccountId: job.autoArchive.actorAccountId, runId: item.analysis!.runId };
      await this.options.audit({ ...event, phase: 'requested' });
      if (signal?.aborted || !await this.valid(org, job)) return;
      // CAS also rejects deletion, pausing and coworker edits performed during audit/projection.
      if (await store.compareAndSet(org, job.revision, { ...next, revision: job.revision + 1, updatedAt: at, updatedBy: job.autoArchive.actorAccountId })) {
        await this.options.audit({ ...event, phase: 'completed' }); return;
      }
    }
  }
}
export function startRecruitmentAutoArchive(worker: RecruitmentAutoArchiveWorker, registry: RecurringTaskRegistry): () => void {
  const abort = new AbortController();
  const stop = registry.register({ name: 'enterprise.recruitment-auto-archive', source: 'packages/server/src/modules/recruitment_intelligence/recruitmentAutoArchive.ts', intervalMs: 60_000, initialDelayMs: 15_000, missedRunPolicy: 'run-once', estimatedCostUsdPerRun: 0,
    getInputVersion: () => String(Math.floor(Date.now() / 60_000)), run: async () => { try { await worker.tick(abort.signal); } catch { throw new Error('招聘自动入档未完成；已完成的模型结果保留，下轮仅检查存档，不重新调用模型'); } } });
  return () => { abort.abort(); stop?.(); };
}
