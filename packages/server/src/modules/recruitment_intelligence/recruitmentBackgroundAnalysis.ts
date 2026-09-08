/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import type { RecurringTaskRegistry } from 'otto-core';
import { RecruitmentJobError, recruitmentJobId, type RecruitmentJobActor, type RecruitmentSharedJob } from './recruitmentJobs.js';
import type { RecruitmentJobStore } from './recruitmentJobStore.js';
import type { RecruitmentBackgroundModel } from './recruitmentBackgroundModel.js';
import { recruitmentSyncMetadata } from './recruitmentCollaboration.js';
import { buildRecruitmentPrompt, parseRecruitmentSemanticAnalysis, sanitizeRecruitmentModelInput } from './recruitmentSemanticModel.js';
import { captureRecruitmentAssessmentContext } from './recruitmentAssessment.js';
import { RECRUITMENT_SEMANTIC_ANALYSIS_VERSION, type RecruitmentSemanticEvaluation } from './recruitmentSemantic.js';
import { RecruitmentAutoArchiveWorker, startRecruitmentAutoArchive } from './recruitmentAutoArchive.js';
import type { RecruitmentUsageLedger, RecruitmentOrganizationUsage, RecruitmentUsageReservation } from './recruitmentUsageLedger.js';

export interface RecruitmentBackgroundResult {
  status: 'completed' | 'unknown'; runId: string; attemptedAt: string; message: string;
  inputFingerprint: string; modelVersion: string; redactedResume: string;
  evaluation?: RecruitmentSemanticEvaluation;
  trigger?: 'background' | 'manual'; requestedBy?: string;
}
export interface RecruitmentBackgroundState {
  enabled: boolean; generation: string; actorAccountId: string; confirmedAt: string;
  scopeToken: string; headerToken: string; modelVersion: string; modelId: string;
  dailyRequestLimit: number; dailyReservedTokenLimit: number; message: string;
  organizationUsage?: RecruitmentOrganizationUsage;
  usage: Array<{ day: string; requests: number; reservedTokens: number; inputTokens: number; outputTokens: number; unknownRequests: number }>;
  pending?: { id: string; itemId: string; until: string; day: string };
}
export type RecruitmentBackgroundAction = { kind: 'configure_background_analysis'; jobId: string; expectedRevision: number; enabled: boolean; confirmed: true; dailyRequestLimit?: number; dailyReservedTokenLimit?: number };
export interface RecruitmentOneOffAction {
  kind: 'analyze_intake_once'; jobId: string; itemId: string; expectedRevision: number;
  scopeToken: string; headerToken: string; modelVersion: string; confirmed: true;
}
interface OneOffContext extends RecruitmentOneOffAction { actorAccountId: string }
export type RecruitmentBackgroundModelResolver = (organizationId: string) => RecruitmentBackgroundModel | null;

export function configureRecruitmentBackground(job: RecruitmentSharedJob, actor: RecruitmentJobActor, action: RecruitmentBackgroundAction, resolve: RecruitmentBackgroundModelResolver | undefined, now: string): RecruitmentBackgroundState {
  if (!actor.isAdmin && job.ownerAccountId !== actor.id) throw new RecruitmentJobError(403, '仅岗位创建者或企业管理员可以配置后台付费分析');
  if (action.confirmed !== true || typeof action.enabled !== 'boolean') throw new RecruitmentJobError(400, '请明确确认使用企业授权模型、费用上限及岗位共享范围');
  const old = job.backgroundAnalysis; const model = resolve?.(actor.organizationId);
  if (action.enabled && !model) throw new RecruitmentJobError(409, '服务器未配置本企业获准使用的后台模型，请联系管理员；尚未开启');
  if (action.enabled && !model?.organizationBudget) throw new RecruitmentJobError(409, '服务器未配置本企业招聘企业总额度，请联系管理员；尚未开启');
  if (action.enabled && old?.pending && Date.parse(old.pending.until) > Date.parse(now)) throw new RecruitmentJobError(409, '上一轮可能仍在计费，请稍后刷新；可以立即暂停');
  const dailyRequestLimit = action.dailyRequestLimit ?? old?.dailyRequestLimit ?? 5;
  const dailyReservedTokenLimit = action.dailyReservedTokenLimit ?? old?.dailyReservedTokenLimit ?? 100_000;
  if (!Number.isInteger(dailyRequestLimit) || dailyRequestLimit < 1 || dailyRequestLimit > 50 || !Number.isInteger(dailyReservedTokenLimit) || dailyReservedTokenLimit < 10_000 || dailyReservedTokenLimit > 2_000_000) throw new RecruitmentJobError(400, '每天调用限额为 1–50 次，预留 Token 限额为 10000–2000000');
  const sync = recruitmentSyncMetadata(job);
  return { enabled: action.enabled, generation: randomUUID(), actorAccountId: actor.id, confirmedAt: now, scopeToken: sync.scopeToken, headerToken: sync.headerToken,
    modelVersion: model?.version ?? old?.modelVersion ?? '', modelId: model?.id ?? old?.modelId ?? '', dailyRequestLimit, dailyReservedTokenLimit,
    usage: old?.usage ?? [], ...(old?.organizationUsage ? { organizationUsage: old.organizationUsage } : {}), ...(old?.pending && Date.parse(old.pending.until) > Date.parse(now) ? { pending: old.pending } : {}), message: action.enabled ? '已开启：仅分析当前岗位与简历正文，不联系、淘汰或录用候选人' : '额度已保存，后台未开启 / 已暂停；已发出的请求可能仍然计费，预留额度保留' };
}

/** One paid request per job per tick. CAS reservation precedes IO; uncertain attempts are never replayed. */
export class RecruitmentBackgroundWorker {
  readonly autoArchive: RecruitmentAutoArchiveWorker;
  private cursor = { organizationId: '', jobId: '' };
  constructor(private readonly options: {
    store: RecruitmentJobStore; usageLedger: RecruitmentUsageLedger; resolveModel: RecruitmentBackgroundModelResolver;
    getActor(id: string): Promise<RecruitmentJobActor | null>; isEntitled(org: string): Promise<boolean>;
    audit(event: { organizationId: string; jobId: string; actorAccountId: string; runId: string; phase: 'requested' | 'completed'; operation?: 'archive' }): Promise<void>;
    now?: () => number;
  }) { this.autoArchive = new RecruitmentAutoArchiveWorker({ ...options, audit: (event) => options.audit({ ...event, operation: 'archive' }) }); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  /** Same executor and ledger as the scheduler; only server-held material, never a caller-supplied prompt. */
  async analyzeOnce(accountId: string, action: RecruitmentOneOffAction): Promise<void> {
    if (!action || action.confirmed !== true || !/^[a-f0-9]{64}$/u.test(action.itemId)
      || !/^[a-f0-9]{64}$/u.test(action.scopeToken) || !/^[a-f0-9]{64}$/u.test(action.headerToken)
      || typeof action.modelVersion !== 'string' || !action.modelVersion || action.modelVersion.length > 200
      || !Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 1) throw new RecruitmentJobError(400, '请确认本份材料、企业模型费用及岗位共享范围');
    const id = recruitmentJobId(action.jobId); const actor = await this.options.getActor(accountId);
    if (!actor?.active) throw new RecruitmentJobError(403, '企业账号不可用');
    const job = await this.options.store.get(actor.organizationId, id);
    if (!job || (!actor.isAdmin && job.ownerAccountId !== actor.id && !job.collaboratorAccountIds.includes(actor.id))) throw new RecruitmentJobError(404, '岗位不存在或未授权访问');
    const sync = recruitmentSyncMetadata(job); const config = job.backgroundAnalysis;
    if (job.revision !== action.expectedRevision || sync.scopeToken !== action.scopeToken || sync.headerToken !== action.headerToken) throw new RecruitmentJobError(409, '岗位或共享范围已变化，请刷新后重新确认');
    if (!config || config.modelVersion !== action.modelVersion) throw new RecruitmentJobError(409, '请由岗位创建者先保存企业模型与岗位额度，再确认本次分析');
    const manual: OneOffContext = { ...action, actorAccountId: actor.id };
    if (!await this.valid(actor.organizationId, job, config, manual)) throw new RecruitmentJobError(403, '账号、许可、模型或岗位额度授权已变化；未调用模型');
    const item = job.incomingMaterials?.find((entry) => entry.id === action.itemId && Date.parse(entry.expiresAt) > this.now());
    if (!item) throw new RecruitmentJobError(404, '材料不存在或已到期');
    if (item.manualAnalysis) throw new RecruitmentJobError(409, '此材料已由桌面分析认领，请核对原客户端结果，不会切换模型');
    if (item.analysis) return; // Existing completed/unknown attempts are read, never retried by a click.
    if (item.material.material.completeness !== 'full_text' || item.material.material.text.trim().length < 20) throw new RecruitmentJobError(400, '尚未读取足够的简历全文，未调用模型');
    await this.run(actor.organizationId, id, undefined, manual);
  }
  async tick(signal?: AbortSignal): Promise<void> {
    const page = await this.options.store.scan?.(this.cursor, 50); if (!page) return;
    let processed = 0;
    for (const entry of page.jobs) {
      if (signal?.aborted) return;
      this.cursor = { organizationId: entry.organizationId, jobId: entry.job.id };
      if (entry.job.backgroundAnalysis?.enabled || entry.job.backgroundAnalysis?.pending) {
        await this.run(entry.organizationId, entry.job.id, signal); if (++processed >= 2) return;
      }
    }
    if (!page.hasMore) this.cursor = { organizationId: '', jobId: '' };
  }
  private async valid(org: string, job: RecruitmentSharedJob, config: RecruitmentBackgroundState, manual?: OneOffContext): Promise<boolean> {
    const actor = await this.options.getActor(config.actorAccountId); const sync = recruitmentSyncMetadata(job);
    const requester = manual ? await this.options.getActor(manual.actorAccountId) : null;
    const manualAllowed = Boolean(manual && requester?.active && requester.organizationId === org
      && (requester.isAdmin || job.ownerAccountId === requester.id || job.collaboratorAccountIds.includes(requester.id))
      && manual.scopeToken === sync.scopeToken && manual.headerToken === sync.headerToken && manual.modelVersion === config.modelVersion);
    return Boolean((manual ? manualAllowed : config.enabled) && actor?.active && actor.organizationId === org && (actor.isAdmin || job.ownerAccountId === actor.id)
      && await this.options.isEntitled(org) && sync.scopeToken === config.scopeToken && sync.headerToken === config.headerToken
      && this.options.resolveModel(org)?.version === config.modelVersion && this.options.resolveModel(org)?.organizationBudget);
  }
  private async run(org: string, id: string, parent?: AbortSignal, manual?: OneOffContext): Promise<void> {
    const { store } = this.options; const job = await store.get(org, id); const config = job?.backgroundAnalysis; if (!job || !config) return;
    if (manual && job.revision !== manual.expectedRevision) throw new RecruitmentJobError(409, '档案已更新，请刷新；不会重复提交');
    const analysisActorId = manual?.actorAccountId ?? config.actorAccountId;
    const now = this.now(); const nowText = new Date(now).toISOString();
    if (config.pending) {
      if (manual) throw new RecruitmentJobError(409, '本岗位已有请求处理中或结果待核对，请刷新，不会重复提交');
      if (Date.parse(config.pending.until) <= now) {
        await this.options.usageLedger.finish(org, config.pending.id, 'unknown').catch(() => undefined);
        await store.compareAndSet(org, job.revision, { ...job, revision: job.revision + 1, backgroundAnalysis: { ...config, pending: undefined, enabled: false, message: '上次调用中断，计费或结果未知；不会自动重试，岗位及企业预留额度保留' } });
      }
      return;
    }
    if (!config.enabled && !manual) return;
    if (!await this.valid(org, job, config, manual)) {
      if (manual) throw new RecruitmentJobError(403, '本次分析授权已变化，未调用模型');
      await store.compareAndSet(org, job.revision, { ...job, revision: job.revision + 1, backgroundAnalysis: { ...config, enabled: false, message: '账号、许可、岗位、共享范围、模型或企业总额度配置已变化，请核查后重新开启' } }); return;
    }
    // An attempted item is not automatically retried even when configuration changes.
    const item = job.incomingMaterials?.find((entry) => (!manual || entry.id === manual.itemId) && !entry.analysis && !entry.manualAnalysis && Date.parse(entry.expiresAt) > now && entry.material.material.completeness === 'full_text' && entry.material.material.text.trim());
    if (!item) return;
    const input = { candidateId: item.id, jobTitle: job.title, jobDescription: job.description, redactedResume: sanitizeRecruitmentModelInput(item.material.material.text), resumeProvided: true };
    const prompt = buildRecruitmentPrompt(input, input.redactedResume);
    // UTF-8 bytes + framing headroom + max output; a conservative admission estimate, NOT an invoice guarantee.
    const reservedTokens = Buffer.byteLength(prompt, 'utf8') + 8192;
    const day = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
    const usage = config.usage.filter((entry) => entry.day >= new Date(now - 7 * 86_400_000).toISOString().slice(0, 10));
    const daily = usage.find((entry) => entry.day === day) ?? { day, requests: 0, reservedTokens: 0, inputTokens: 0, outputTokens: 0, unknownRequests: 0 };
    if (daily.requests >= config.dailyRequestLimit || daily.reservedTokens + reservedTokens > config.dailyReservedTokenLimit) {
      const message = `达到岗位每日调用或预留 Token 上限，未发出新请求；${config.enabled ? '次日（北京时间）自动重新检查' : '次日（北京时间）可重新手动提交'}`;
      if (config.message !== message) await store.compareAndSet(org, job.revision, { ...job, revision: job.revision + 1, backgroundAnalysis: { ...config, message } }); return;
    }
    const runId = randomUUID(); const model = this.options.resolveModel(org)!;
    const inputFingerprint = createHash('sha256').update(JSON.stringify([prompt, model.version])).digest('hex');
    const attempt: RecruitmentBackgroundResult = { status: 'unknown', runId, attemptedAt: nowText, inputFingerprint, modelVersion: model.version, redactedResume: input.redactedResume, trigger: manual ? 'manual' : 'background', requestedBy: analysisActorId, message: '请求已预留额度；结果或计费尚未确认，不会自动重复调用' };
    const reserved: RecruitmentSharedJob = { ...job, revision: job.revision + 1,
      incomingMaterials: job.incomingMaterials!.map((entry) => entry.id === item.id ? { ...entry, analysis: attempt } : entry),
      backgroundAnalysis: { ...config, pending: { id: runId, itemId: item.id, day, until: new Date(now + 180_000).toISOString() },
        usage: [{ ...daily, requests: daily.requests + 1, reservedTokens: daily.reservedTokens + reservedTokens, unknownRequests: daily.unknownRequests + 1 }, ...usage.filter((entry) => entry.day !== day)], message: '本轮正在分析；先预留额度，结果返回后记录实际用量' } };
    if (Buffer.byteLength(JSON.stringify([reserved.candidates, reserved.incomingMaterials]), 'utf8') > 5_800_000) {
      await store.compareAndSet(org, job.revision, { ...job, revision: job.revision + 1, backgroundAnalysis: { ...config, enabled: false, message: '岗位档案接近容量上限，已暂停；请先整理材料' } }); return;
    }
    if (!await store.compareAndSet(org, job.revision, reserved)) return;
    // Source record IDs can change. Include original material (not only redacted text)
    // so two different people's similar anonymized resumes do not collide.
    const ledgerKey = createHash('sha256').update(JSON.stringify([id, config.scopeToken, config.headerToken, model.id, model.version,
      RECRUITMENT_SEMANTIC_ANALYSIS_VERSION, prompt, item.material.material.text.replace(/\r\n?/gu, '\n').trim()])).digest('hex');
    let admission: RecruitmentUsageReservation;
    try { admission = await this.options.usageLedger.reserve(org, model.organizationBudget!, { key: ledgerKey, runId, reservedTokens }); }
    catch {
      await this.rejectAdmission(org, id, runId, item.id, day, reservedTokens, 'unconfirmed'); return;
    }
    if (admission.kind !== 'reserved') {
      await this.rejectAdmission(org, id, runId, item.id, day, reservedTokens, admission); return;
    }
    const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(parent ? [parent] : [])]);
    let evaluation: RecruitmentSemanticEvaluation | undefined; let counts: { inputTokens: number | null; outputTokens: number | null } | undefined;
    try {
      await this.options.audit({ organizationId: org, jobId: id, actorAccountId: analysisActorId, runId, phase: 'requested' });
      const fresh = await store.get(org, id); signal.throwIfAborted();
      if (!fresh || fresh.backgroundAnalysis?.generation !== config.generation || fresh.backgroundAnalysis.pending?.id !== runId
        || !fresh.incomingMaterials?.some((entry) => entry.id === item.id && entry.analysis?.runId === runId && Date.parse(entry.expiresAt) > this.now())
        || !await this.valid(org, fresh, config, manual)) throw new Error('scope changed');
      const response = await model.invoke(prompt, signal); signal.throwIfAborted(); counts = response;
      const parsed = parseRecruitmentSemanticAnalysis(response.raw, input.redactedResume, { modelProvider: model.id, inputTokens: response.inputTokens ?? 0, outputTokens: response.outputTokens ?? 0 });
      evaluation = { ...parsed, analysisVersion: RECRUITMENT_SEMANTIC_ANALYSIS_VERSION, assessmentContext: await captureRecruitmentAssessmentContext(input, model.id),
        execution: { runId, disposition: 'executed', requestedAt: nowText, inputFingerprint, inputTokens: response.inputTokens, outputTokens: response.outputTokens } };
    } catch { /* Keep the persisted unknown marker, never expose response bodies or blindly retry. */ }
    let ledgerUnconfirmed = false; let organizationUsage: RecruitmentOrganizationUsage | undefined;
    try {
      await this.options.usageLedger.finish(org, runId, evaluation ? 'completed' : 'unknown', counts);
      organizationUsage = await this.options.usageLedger.snapshot(org, this.options.resolveModel(org)?.organizationBudget ?? model.organizationBudget!);
    } catch { ledgerUnconfirmed = true; }
    for (let retry = 0; retry < 8; retry++) {
      const fresh = await store.get(org, id); const state = fresh?.backgroundAnalysis;
      if (!fresh || state?.pending?.id !== runId) return;
      const usable = Boolean(evaluation && !signal.aborted && state.generation === config.generation && await this.valid(org, fresh, state, manual));
      const result = usable ? { ...attempt, status: 'completed' as const, message: '已分析岗位与简历正文；结论仅有简历自述支持，仍需面试或实战核实', evaluation } : { ...attempt, message: '调用未完整完成或运行条件变化，旧结果未采用；可能已计费，不会自动重试' };
      const materials = fresh.incomingMaterials?.filter((entry) => Date.parse(entry.expiresAt) > this.now()).map((entry) => entry.id === item.id && entry.analysis?.runId === runId ? { ...entry, analysis: result } : entry);
      const fits = Buffer.byteLength(JSON.stringify([fresh.candidates, materials]), 'utf8') <= 5_900_000;
      const next = { ...fresh, revision: fresh.revision + 1, updatedAt: new Date(this.now()).toISOString(), updatedBy: analysisActorId,
        incomingMaterials: fits ? materials : fresh.incomingMaterials,
        backgroundAnalysis: { ...state, ...(organizationUsage ? { organizationUsage } : {}), pending: undefined, enabled: usable && fits && state.enabled && !ledgerUnconfirmed,
          message: ledgerUnconfirmed ? '企业账本回报未确认，已暂停新调用；预留额度保留，请核对用量。已有有效结果仍会保留' : fits ? result.message : '结果超出岗位容量，未保存；预留额度保留，请人工处理',
          usage: state.usage.map((entry) => entry.day === day ? { ...entry, inputTokens: entry.inputTokens + (counts?.inputTokens ?? 0), outputTokens: entry.outputTokens + (counts?.outputTokens ?? 0), unknownRequests: entry.unknownRequests - (counts?.inputTokens != null && counts.outputTokens != null ? 1 : 0) } : entry) } };
      if (await store.compareAndSet(org, fresh.revision, next)) { await this.options.audit({ organizationId: org, jobId: id, actorAccountId: analysisActorId, runId, phase: 'completed' }); return; }
    }
  }
  /** Roll back only the JOB reservation on a confirmed enterprise denial. An ambiguous write is never refunded. */
  private async rejectAdmission(org: string, id: string, runId: string, itemId: string, day: string, tokens: number, admission: Exclude<RecruitmentUsageReservation, { kind: 'reserved' }> | 'unconfirmed'): Promise<void> {
    const unknown = admission === 'unconfirmed'; const budget = !unknown && admission.kind === 'budget';
    const message = unknown ? '企业账本写入未确认，未调用模型；已暂停，预留额度保留，请核对后处理'
      : budget ? '达到企业招聘每日总额度，未调用模型，不占本岗位额度；若后台已开启，次日（北京时间）再检查，否则需手动重新提交'
      : admission.kind === 'duplicate' ? `相同岗位、材料和模型已有调用记录（${admission.runId}），不重复调用；请核对原结果或未知用量`
      : '企业招聘调用记录达到容量上限，未调用模型；请管理员核对历史记录';
    let organizationUsage: RecruitmentOrganizationUsage | undefined;
    try { const limit = this.options.resolveModel(org)?.organizationBudget; if (limit) organizationUsage = await this.options.usageLedger.snapshot(org, limit); } catch { /* Do not invent zero usage. */ }
    for (let retry = 0; retry < 8; retry++) {
      const fresh = await this.options.store.get(org, id); const state = fresh?.backgroundAnalysis;
      if (!fresh || state?.pending?.id !== runId) return;
      const next = { ...fresh, revision: fresh.revision + 1,
        incomingMaterials: fresh.incomingMaterials?.map((entry) => entry.id === itemId && entry.analysis?.runId === runId
          ? { ...entry, analysis: budget ? undefined : { ...entry.analysis, message } } : entry),
        backgroundAnalysis: { ...state, pending: undefined, message, enabled: state.enabled && budget,
          ...(organizationUsage ? { organizationUsage } : {}), usage: unknown ? state.usage : state.usage.map((entry) => entry.day === day
            ? { ...entry, requests: entry.requests - 1, reservedTokens: entry.reservedTokens - tokens, unknownRequests: entry.unknownRequests - 1 } : entry) } };
      if (await this.options.store.compareAndSet(org, fresh.revision, next)) return;
    }
  }
}

export function startRecruitmentBackgroundAnalysis(worker: RecruitmentBackgroundWorker, registry: RecurringTaskRegistry): () => void {
  const abort = new AbortController();
  // Separate zero-cost registration: filing an existing result does not require another paid task or model call.
  const stopArchive = startRecruitmentAutoArchive(worker.autoArchive, registry);
  // Positive estimate keeps this behind the scheduler's paid-work gate. Per-job admission uses the persisted Token ledger, not this estimate.
  const stop = registry.register({ name: 'enterprise.recruitment-background-analysis', source: 'packages/server/src/modules/recruitment_intelligence/recruitmentBackgroundAnalysis.ts', intervalMs: 60_000, initialDelayMs: 10_000, missedRunPolicy: 'run-once', estimatedCostUsdPerRun: 1,
    getInputVersion: () => String(Math.floor(Date.now() / 60_000)), run: async () => { try { await worker.tick(abort.signal); } catch { throw new Error('招聘后台分析未完成；持久额度和已尝试标记保留，下轮检查状态'); } } });
  return () => { abort.abort(); stopArchive(); stop?.(); };
}
