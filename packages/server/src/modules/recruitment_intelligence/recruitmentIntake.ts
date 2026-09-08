/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import type { RecurringTaskRegistry } from 'otto-core';
import { RecruitmentJobError, type RecruitmentJobActor, type RecruitmentSharedJob } from './recruitmentJobs.js';
import { recruitmentSyncMetadata } from './recruitmentCollaboration.js';
import type { RecruitmentJobStore } from './recruitmentJobStore.js';
import type { RecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';
import type { RecruitmentMaterialResult } from './recruitmentSourceMaterial.js';
import type { RecruitmentBackgroundResult } from './recruitmentBackgroundAnalysis.js';
import type { RecruitmentIntakeClaim } from './recruitmentIntakeClaims.js';
import type { RecruitmentArchiveReceipt } from './recruitmentAutoArchive.js';

export interface RecruitmentIncomingMaterial { id: string; receivedAt: string; expiresAt: string; material: RecruitmentMaterialResult; analysis?: RecruitmentBackgroundResult; manualAnalysis?: RecruitmentIntakeClaim; manualAnalysisHistory?: RecruitmentIntakeClaim[]; archive?: RecruitmentArchiveReceipt }
export interface RecruitmentIntakeRun {
  id: string; startedAt: string; finishedAt: string; status: 'completed' | 'partial' | 'paused' | 'failed';
  received: number; unchanged: number; failed: number; hasMore: boolean; modelInvoked: false; message: string;
}
export interface RecruitmentIntakeState {
  enabled: boolean; generation: string; actorAccountId: string; sourceId: 'workable';
  intervalMinutes: number; retentionDays: number; maxMaterials: number; confirmedAt: string;
  scopeToken: string; headerToken: string; nextRunAt: string;
  cursor?: string; lease?: { id: string; until: string };
  runs: RecruitmentIntakeRun[];
  seen: Array<{ id: string; expiresAt: string }>;
}
export type RecruitmentIntakeAction = {
  kind: 'configure_intake'; jobId: string; expectedRevision: number; confirmed: true; enabled: boolean;
  intervalMinutes?: number; retentionDays?: number; maxMaterials?: number;
} | { kind: 'dismiss_intake'; jobId: string; expectedRevision: number; itemId: string; confirmed: true };

export async function configureRecruitmentIntake(job: RecruitmentSharedJob, actor: RecruitmentJobActor, action: Extract<RecruitmentIntakeAction, { kind: 'configure_intake' }>, runtime: RecruitmentSourceRuntime | undefined, now: string): Promise<RecruitmentIntakeState> {
  if (!actor.isAdmin && job.ownerAccountId !== actor.id) throw new RecruitmentJobError(403, '仅岗位创建者或企业管理员可以开启、暂停后台接收');
  if (action.confirmed !== true || typeof action.enabled !== 'boolean') throw new RecruitmentJobError(400, '请明确确认后台读取、限期保存和岗位共享范围');
  const old = job.intake;
  const intervalMinutes = action.intervalMinutes ?? old?.intervalMinutes ?? 60;
  const retentionDays = action.retentionDays ?? old?.retentionDays ?? 7;
  const maxMaterials = action.maxMaterials ?? old?.maxMaterials ?? 5;
  if (![30, 60, 360, 1440].includes(intervalMinutes) || ![7, 30, 90].includes(retentionDays) || ![5, 10, 20].includes(maxMaterials)) throw new RecruitmentJobError(400, '后台接收周期、保存期限或单次数量无效');
  if (action.enabled) {
    if (!runtime?.getCandidateMaterial) throw new RecruitmentJobError(409, '服务器尚未配置可读取材料的招聘来源');
    const sources = await runtime.listSources({ organizationId: actor.organizationId, actorAccountId: actor.id, requisitionId: job.id });
    if (!sources.some((source) => source.id === 'workable' && source.productionEnabled && source.authorized && source.searchable && source.materialReadable)) throw new RecruitmentJobError(409, 'Workable 尚未完成生产验收或本人岗位授权，不能开启后台接收');
  }
  const sync = recruitmentSyncMetadata(job);
  return { enabled: action.enabled, generation: randomUUID(), actorAccountId: actor.id, sourceId: 'workable', intervalMinutes, retentionDays, maxMaterials,
    confirmedAt: now, scopeToken: sync.scopeToken, headerToken: sync.headerToken, nextRunAt: now, runs: old?.runs ?? [], seen: old?.seen ?? [] };
}

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Receives into the encrypted job inbox. Does not evaluate, contact or rank people. */
export class RecruitmentIntakeWorker {
  private cursor = { organizationId: '', jobId: '' };
  constructor(private readonly options: {
    store: RecruitmentJobStore; runtime: RecruitmentSourceRuntime;
    getActor(id: string): Promise<RecruitmentJobActor | null>;
    isEntitled(organizationId: string): Promise<boolean>;
    audit(event: { organizationId: string; jobId: string; actorAccountId: string; runId: string; phase: 'requested' | 'completed' }): Promise<void>;
    now?: () => number;
  }) {}
  async tick(signal?: AbortSignal): Promise<void> {
    const page = await this.options.store.scan?.(this.cursor, 50);
    if (!page) return;
    let processed = 0;
    for (const entry of page.jobs) {
      if (signal?.aborted) return;
      this.cursor = { organizationId: entry.organizationId, jobId: entry.job.id };
      const config = entry.job.intake;
      if (!config) continue;
      const now = this.now();
      if ((config.enabled && Date.parse(config.nextRunAt) <= now && (!config.lease || Date.parse(config.lease.until) <= now)) || (entry.inboxExpiry && Date.parse(entry.inboxExpiry) <= now)) {
        await this.run(entry.organizationId, entry.job.id, signal);
        if (++processed >= 2) return;
      }
    }
    if (!page.hasMore) this.cursor = { organizationId: '', jobId: '' };
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private async valid(org: string, job: RecruitmentSharedJob, state: RecruitmentIntakeState): Promise<boolean> {
    const actor = await this.options.getActor(state.actorAccountId);
    const sync = recruitmentSyncMetadata(job);
    return Boolean(await this.options.isEntitled(org) && actor?.active && actor.organizationId === org && (actor.isAdmin || job.ownerAccountId === actor.id)
      && sync.scopeToken === state.scopeToken && sync.headerToken === state.headerToken);
  }
  private async run(org: string, jobId: string, parentSignal?: AbortSignal): Promise<void> {
    const { store, runtime } = this.options;
    let job = await store.get(org, jobId); if (!job?.intake) return;
    const now = this.now();
    const retained = (job.incomingMaterials ?? []).filter((item) => Date.parse(item.expiresAt) > now);
    if (retained.length !== (job.incomingMaterials?.length ?? 0)) {
      const cleaned = { ...job, incomingMaterials: retained, revision: job.revision + 1 };
      if (!await store.compareAndSet(org, job.revision, cleaned)) return;
      job = cleaned;
    }
    const config = job.intake!;
    if (!config.enabled || Date.parse(config.nextRunAt) > now || (config.lease && Date.parse(config.lease.until) > now)) return;
    const runId = randomUUID(); const startedAt = new Date(now).toISOString();
    const leased = { ...job, revision: job.revision + 1, intake: { ...config, lease: { id: runId, until: new Date(now + 180_000).toISOString() } } };
    if (!await store.compareAndSet(org, job.revision, leased)) return;
    const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(parentSignal ? [parentSignal] : [])]);
    const incoming: RecruitmentIncomingMaterial[] = []; const seen = config.seen.filter((entry) => Date.parse(entry.expiresAt) > now);
    let unchanged = 0; let failed = 0; let cursor = config.cursor; let paused = false; let hasMore = false;
    let message = '本轮资料接收完成；尚未执行模型分析';
    const assertCurrent = async (): Promise<RecruitmentSharedJob> => {
      signal.throwIfAborted();
      const fresh = await store.get(org, jobId);
      if (!fresh?.intake?.enabled || fresh.intake.generation !== config.generation || fresh.intake.lease?.id !== runId || !await this.valid(org, fresh, config)) throw new Error('scope changed');
      return fresh;
    };
    try {
      await this.options.audit({ organizationId: org, jobId, actorAccountId: config.actorAccountId, runId, phase: 'requested' });
      await assertCurrent();
      const scope = { organizationId: org, actorAccountId: config.actorAccountId, requisitionId: jobId };
      const ready = async (): Promise<void> => {
        const sources = await runtime.listSources(scope);
        if (!sources.some((source) => source.id === config.sourceId && source.productionEnabled && source.authorized && source.searchable && source.materialReadable)) throw new Error('source unavailable');
        await assertCurrent();
      };
      await ready();
      const search = await runtime.search({ ...scope, query: `岗位：${job.title}\n招聘目标：${job.description}`, sourceIds: [config.sourceId], limitPerSource: config.maxMaterials,
        cursors: { [config.sourceId]: config.cursor ?? '' }, signal });
      await assertCurrent();
      const sourceStatus = search.sources.find((source) => source.sourceId === config.sourceId);
      if (sourceStatus?.status !== 'ok') throw new Error('search incomplete');
      hasMore = Boolean(sourceStatus.nextCursor); cursor = sourceStatus.nextCursor;
      for (const candidate of search.candidates.slice(0, config.maxMaterials)) {
        await assertCurrent();
        const source = candidate.sources.find((entry) => entry.sourceId === config.sourceId);
        if (!source) { failed++; continue; }
        try {
          const material = await runtime.getCandidateMaterial!({ ...scope, runId: search.runId, canonicalId: candidate.canonicalId, sourceId: config.sourceId, signal });
          await assertCurrent();
          if (material.requisitionId !== jobId || material.runId !== search.runId || material.canonicalId !== candidate.canonicalId || material.source.sourceId !== source.sourceId
            || material.source.sourceRecordId !== source.sourceRecordId || material.material.sourceRecordId !== source.sourceRecordId
            || typeof material.material.text !== 'string' || material.material.text.length > 80_000 || !['full_text', 'partial', 'unavailable'].includes(material.material.completeness)) throw new Error('invalid material');
          const id = fingerprint([config.sourceId, source.sourceRecordId, material.material.text, material.material.completeness, material.material.attachment?.sha256]);
          if (seen.some((entry) => entry.id === id)) { unchanged++; continue; }
          if (retained.length + incoming.length >= 100 || seen.length >= 500) throw new Error('inbox full');
          const expiresAt = new Date(now + config.retentionDays * 86_400_000).toISOString();
          incoming.push({ id, receivedAt: startedAt, expiresAt, material }); seen.push({ id, expiresAt });
          if (material.material.completeness !== 'full_text') failed++;
        } catch { failed++; paused = true; message = '部分材料读取失败或待处理箱已满，已暂停；成功读取的材料保留，需人工检查后继续'; break; }
      }
      await ready();
    } catch {
      paused = true; failed++; message = '岗位、账号、来源授权或运行条件变化，后台接收已暂停；请核查授权与运行记录后重新开启';
      incoming.length = 0;
    }
    // Pause/reconfigure/delete wins over this result. Concurrent candidate edits merge by a fresh job CAS.
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = await store.get(org, jobId);
      if (!fresh?.intake || fresh.intake.generation !== config.generation || fresh.intake.lease?.id !== runId) return;
      const scopeValid = await this.valid(org, fresh, config);
      const resumeAfterShutdown = Boolean(parentSignal?.aborted && scopeValid);
      if (!scopeValid || signal.aborted) { paused = true; incoming.length = 0; message = '权限、岗位要求或运行状态已变化，旧结果未入档，后台接收已暂停'; }
      if (resumeAfterShutdown) { failed = 0; message = '服务器停止了本轮读取，迟到材料未入档；任务配置保留，重启后重新检查授权并继续'; }
      const existing = (fresh.incomingMaterials ?? []).filter((entry) => Date.parse(entry.expiresAt) > this.now());
      const added = incoming.filter((entry) => !existing.some((item) => item.id === entry.id));
      let materials = [...existing, ...added];
      if (Buffer.byteLength(JSON.stringify([fresh.candidates, materials]), 'utf8') > 5_900_000) { materials = existing; incoming.length = 0; paused = true; message = '岗位档案达到容量上限，本轮新材料未保存，后台接收已暂停'; }
      const run: RecruitmentIntakeRun = { id: runId, startedAt, finishedAt: new Date(this.now()).toISOString(), status: paused ? (incoming.length ? 'partial' : 'paused') : failed ? 'partial' : 'completed',
        received: incoming.length, unchanged, failed, hasMore, modelInvoked: false, message };
      const next: RecruitmentSharedJob = { ...fresh, incomingMaterials: materials, revision: fresh.revision + 1, updatedAt: run.finishedAt, updatedBy: config.actorAccountId,
        intake: { ...fresh.intake, enabled: !paused || resumeAfterShutdown, lease: undefined, cursor: paused ? config.cursor : cursor,
          nextRunAt: new Date(this.now() + (resumeAfterShutdown ? 0 : config.intervalMinutes * 60_000)).toISOString(), seen: incoming.length ? seen : config.seen.filter((entry) => Date.parse(entry.expiresAt) > this.now()), runs: [run, ...fresh.intake.runs].slice(0, 10) } };
      if (await store.compareAndSet(org, fresh.revision, next)) {
        await this.options.audit({ organizationId: org, jobId, actorAccountId: config.actorAccountId, runId, phase: 'completed' }); return;
      }
    }
  }
}

export function startRecruitmentIntake(worker: RecruitmentIntakeWorker, registry: RecurringTaskRegistry): () => void {
  const abort = new AbortController();
  const stop = registry.register({ name: 'enterprise.recruitment-material-intake', source: 'packages/server/src/modules/recruitment_intelligence/recruitmentIntake.ts',
    intervalMs: 60_000, initialDelayMs: 0, missedRunPolicy: 'run-once', estimatedCostUsdPerRun: 0,
    getInputVersion: () => String(Math.floor(Date.now() / 60_000)), run: async () => {
      try { await worker.tick(abort.signal); } catch { throw new Error('招聘后台接收未完成，将在下轮检查持久任务状态'); }
    },
  });
  return () => { abort.abort(); stop?.(); };
}
