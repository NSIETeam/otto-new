/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { RecruitmentJobStore } from './recruitmentJobStore.js';
import { randomUUID } from 'node:crypto';
import { mergeRecruitmentPatch, recruitmentSyncMetadata, type RecruitmentJobPatch, type RecruitmentSyncMetadata } from './recruitmentCollaboration.js';
import { copyRecruitmentCandidate, recruitmentIdentityMatch, relatedRecruitmentApplication, type RecruitmentRelatedApplication } from './recruitmentPeople.js';
import { configureRecruitmentIntake, type RecruitmentIncomingMaterial, type RecruitmentIntakeState, type RecruitmentIntakeAction } from './recruitmentIntake.js';
import type { RecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';
import { configureRecruitmentBackground, type RecruitmentBackgroundState, type RecruitmentBackgroundAction, type RecruitmentBackgroundModelResolver, type RecruitmentOneOffAction } from './recruitmentBackgroundAnalysis.js';
import { applyRecruitmentIntakeClaim, type RecruitmentIntakeClaimAction } from './recruitmentIntakeClaims.js';
import { configureRecruitmentAutoArchive, type RecruitmentAutoArchiveAction, type RecruitmentAutoArchiveState } from './recruitmentAutoArchive.js';

/** Versioned desktop material, never interpreted as permissions or instructions. personId is server-owned. */
export interface RecruitmentArchivedCandidate { id: string; expiresAt: string; document: string; personId?: string }
export interface RecruitmentJobHeader {
  id: string; title: string; description: string; revision: number;
  ownerAccountId?: string;
  intake?: RecruitmentIntakeState;
  backgroundAnalysis?: RecruitmentBackgroundState;
  autoArchive?: RecruitmentAutoArchiveState;
  collaboratorAccountIds: string[]; updatedAt: string; updatedBy: string;
}
export interface RecruitmentSharedJob extends RecruitmentJobHeader { candidates: RecruitmentArchivedCandidate[]; incomingMaterials?: RecruitmentIncomingMaterial[] }
export interface RecruitmentJobActor { id: string; organizationId: string; isAdmin: boolean; active: boolean }
export type RecruitmentJobAction =
  | RecruitmentIntakeAction
  | RecruitmentBackgroundAction
  | RecruitmentOneOffAction
  | RecruitmentIntakeClaimAction
  | RecruitmentAutoArchiveAction
  | RecruitmentJobPatch
  | { kind: 'list'; cursor?: string }
  | { kind: 'get'; jobId: string; knownRevision?: number }
  | { kind: 'related'; jobId: string; candidateId: string; cursor?: string }
  | { kind: 'unlink_candidate'; jobId: string; candidateId: string; expectedRevision: number; confirmed: true }
  | { kind: 'copy_candidate'; jobId: string; candidateId: string; expectedRevision: number; targetJobId: string; targetRevision: number; sharingConfirmed: true }
  | { kind: 'link_candidate'; jobId: string; candidateId: string; expectedRevision: number; targetJobId: string; targetCandidateId: string; targetRevision: number; sharingConfirmed: true }
  | { kind: 'save'; jobId: string; expectedRevision: number; title: string; description: string; candidates: RecruitmentArchivedCandidate[]; sharingConfirmed: true }
  | { kind: 'share'; jobId: string; expectedRevision: number; collaboratorAccountIds: string[] }
  | { kind: 'delete'; jobId: string; expectedRevision: number };
export type RecruitmentJobResponse =
  | { kind: 'unchanged'; jobId: string; revision: number }
  | { kind: 'list'; jobs: RecruitmentJobHeader[]; nextCursor: string | null; canManage: boolean }
  | { kind: 'job'; job: RecruitmentSharedJob; canManage: boolean; sync?: RecruitmentSyncMetadata }
  | { kind: 'related'; matches: RecruitmentRelatedApplication[]; nextCursor: string | null }
  | { kind: 'deleted' };

export class RecruitmentJobError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function recruitmentJobId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) throw new RecruitmentJobError(400, '招聘档案标识无效');
  return value;
}
export function recruitmentJobText(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new RecruitmentJobError(400, '招聘档案字段不完整或超过大小限制');
  return value;
}
export function validateRecruitmentCandidates(value: unknown, now: number): RecruitmentArchivedCandidate[] {
  if (!Array.isArray(value) || value.length > 100) throw new RecruitmentJobError(400, '每个岗位最多保存 100 位候选人');
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new RecruitmentJobError(400, '候选人档案格式不正确');
    const item = raw as Record<string, unknown>;
    const id = recruitmentJobId(item.id);
    if (ids.has(id)) throw new RecruitmentJobError(400, '候选人标识重复');
    ids.add(id);
    const document = recruitmentJobText(item.document, 1_000_000, true);
    let data: Record<string, unknown>;
    try { data = JSON.parse(document) as Record<string, unknown>; } catch { throw new RecruitmentJobError(400, '候选人文档不是有效 JSON'); }
    const expiresAt = recruitmentJobText(item.expiresAt, 40, true);
    const expiry = Date.parse(expiresAt);
    const consent = Date.parse(String(data?.consentAt));
    if (!data || data.id !== id || data.expiresAt !== expiresAt || !Number.isFinite(expiry) || !Number.isFinite(consent)
      || consent > now + 60_000 || ![7, 30, 90].includes(Number(data.retentionDays))
      || expiry <= consent || expiry > consent + Number(data.retentionDays) * 86_400_000 + 1000) {
      throw new RecruitmentJobError(400, '候选人授权时间或保存期限不一致');
    }
    return { id, expiresAt, document };
  }).filter((item) => Date.parse(item.expiresAt) > now);
}

export class RecruitmentJobService {
  constructor(private readonly options: {
    store: RecruitmentJobStore;
    intakeSources?: RecruitmentSourceRuntime;
    backgroundModel?: RecruitmentBackgroundModelResolver;
    analyzeOnce?(accountId: string, action: RecruitmentOneOffAction): Promise<void>;
    getActor(id: string): Promise<RecruitmentJobActor | null>;
    audit?(event: { organizationId: string; actorAccountId: string; jobId: string; kind: string; phase: 'requested' | 'completed'; revision: number; targetJobId?: string; candidateId?: string; targetCandidateId?: string }): Promise<void>;
    now?: () => Date;
  }) {}

  private async actor(id: string): Promise<RecruitmentJobActor> {
    const actor = await this.options.getActor(id);
    if (!actor?.active) throw new RecruitmentJobError(403, '企业账号不可用，请重新登录');
    return actor;
  }
  private visible(actor: RecruitmentJobActor, job: RecruitmentJobHeader): boolean {
    return actor.isAdmin || job.ownerAccountId === actor.id || job.collaboratorAccountIds.includes(actor.id);
  }
  private view(actor: RecruitmentJobActor, job: RecruitmentSharedJob): RecruitmentJobResponse {
    return { kind: 'job', job, canManage: actor.isAdmin || job.ownerAccountId === actor.id, sync: recruitmentSyncMetadata(job) };
  }
  private async assertActorCurrent(actor: RecruitmentJobActor): Promise<void> {
    const fresh = await this.actor(actor.id);
    if (fresh.organizationId !== actor.organizationId || fresh.isAdmin !== actor.isAdmin) throw new RecruitmentJobError(403, '企业账号权限已变化');
  }
  /** Side-effect-free scope check for source access; never loads candidate payload into a response. */
  async canAccess(accountId: string, jobId: string): Promise<boolean> {
    try {
      const actor = await this.actor(accountId);
      const job = await this.options.store.get(actor.organizationId, recruitmentJobId(jobId));
      await this.assertActorCurrent(actor);
      return Boolean(job && job.id === jobId && this.visible(actor, job));
    } catch { return false; }
  }
  async act(accountId: string, action: RecruitmentJobAction): Promise<RecruitmentJobResponse> {
    if (!action || typeof action !== 'object' || Buffer.byteLength(JSON.stringify(action), 'utf8') > 6_000_000) throw new RecruitmentJobError(400, '招聘请求过大或格式不正确');
    const actor = await this.actor(accountId);
    const store = this.options.store;
    const now = (this.options.now?.() ?? new Date()).toISOString();
    if (action.kind === 'list') {
      const page = await store.list(actor.organizationId, action.cursor === undefined ? '' : recruitmentJobId(action.cursor));
      await this.assertActorCurrent(actor);
      return { kind: 'list', jobs: page.jobs.filter((job) => this.visible(actor, job)), nextCursor: page.nextCursor, canManage: actor.isAdmin };
    }
    const id = recruitmentJobId(action.jobId);
    const audit = async (phase: 'requested' | 'completed', revision: number, copiedCandidateId?: string): Promise<void> => {
      const crossJob = action.kind === 'copy_candidate' || action.kind === 'link_candidate';
      await this.options.audit?.({ organizationId: actor.organizationId, actorAccountId: actor.id, jobId: id, kind: action.kind, phase, revision, ...(crossJob ? { targetJobId: action.targetJobId, candidateId: action.candidateId, targetCandidateId: action.kind === 'link_candidate' ? action.targetCandidateId : copiedCandidateId } : action.kind === 'unlink_candidate' ? { candidateId: action.candidateId } : {}) });
    };
    let current = await store.get(actor.organizationId, id);
    await this.assertActorCurrent(actor);
    if (current && !this.visible(actor, current)) throw new RecruitmentJobError(404, '岗位不存在或未授权访问');
    if (action.kind === 'analyze_intake_once') {
      if (!current) throw new RecruitmentJobError(404, '岗位不存在或未授权访问');
      if (!this.options.analyzeOnce) throw new RecruitmentJobError(409, '当前服务器尚未提供企业模型单次分析，请升级；不会改用其他模型');
      await this.options.analyzeOnce(actor.id, action);
      // Re-authorize and apply retention before returning any result to the caller.
      return this.act(accountId, { kind: 'get', jobId: id });
    }
    if (action.kind === 'claim_intake_analysis' || action.kind === 'start_intake_analysis' || action.kind === 'finish_intake_analysis' || action.kind === 'reset_intake_analysis') {
      for (let attempt = 0; attempt < 8; attempt++) {
        if (!current || !this.visible(actor, current)) throw new RecruitmentJobError(404, '岗位不存在或未授权访问');
        const next = applyRecruitmentIntakeClaim(current, actor, action, now);
        if (next === current) return this.view(actor, current);
        await audit('requested', current.revision); await this.assertActorCurrent(actor);
        if (await store.compareAndSet(actor.organizationId, current.revision, next)) { await audit('completed', next.revision); return this.view(actor, next); }
        current = await store.get(actor.organizationId, id); await this.assertActorCurrent(actor);
      }
      throw new RecruitmentJobError(409, '认领状态正在变化，请刷新；未取得启动许可不得调用模型');
    }
    if (action.kind === 'patch') {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (!current || !this.visible(actor, current)) throw new RecruitmentJobError(404, '岗位不存在或未授权访问');
        const next = mergeRecruitmentPatch(current, action, now, actor.id);
        await this.assertActorCurrent(actor);
        if (next === current) return this.view(actor, current);
        await audit('requested', current.revision);
        await this.assertActorCurrent(actor);
        if (await store.compareAndSet(actor.organizationId, current.revision, next)) {
          await audit('completed', next.revision);
          return this.view(actor, next);
        }
        current = await store.get(actor.organizationId, id);
        await this.assertActorCurrent(actor);
      }
      throw new RecruitmentJobError(409, '岗位正在被频繁更新，本地修改已保留，请稍后重试');
    }
    if (action.kind === 'related') {
      const source = current?.candidates.find((item) => item.id === recruitmentJobId(action.candidateId) && Date.parse(item.expiresAt) > Date.parse(now));
      if (!current || !source) throw new RecruitmentJobError(404, '候选人不存在、已到期或未授权访问');
      const page = await store.list(actor.organizationId, action.cursor === undefined ? '' : recruitmentJobId(action.cursor), 15);
      const matches: RecruitmentRelatedApplication[] = [];
      for (const header of page.jobs) {
        if (header.id === current.id || !this.visible(actor, header)) continue;
        const other = await store.get(actor.organizationId, header.id);
        if (!other || !this.visible(actor, other)) continue;
        const found = other.candidates.flatMap((item) => {
          const reason = Date.parse(item.expiresAt) > Date.parse(now) ? recruitmentIdentityMatch(source, item) : null;
          return reason ? [relatedRecruitmentApplication(other, item, reason)] : [];
        });
        const fresh = await store.get(actor.organizationId, other.id);
        if (fresh?.revision === other.revision && this.visible(actor, fresh)) matches.push(...found);
      }
      await this.assertActorCurrent(actor);
      const fresh = await store.get(actor.organizationId, current.id);
      if (!fresh || !this.visible(actor, fresh) || fresh.revision !== current.revision) throw new RecruitmentJobError(409, '来源岗位已变化，请重新加载后查询');
      return { kind: 'related', matches, nextCursor: page.nextCursor };
    }
    if (action.kind === 'get') {
      if (!current) throw new RecruitmentJobError(404, '岗位不存在或未授权访问');
      if (action.knownRevision !== undefined && (!Number.isSafeInteger(action.knownRevision) || action.knownRevision < 1)) throw new RecruitmentJobError(400, '已知岗位版本无效');
      const retained = current.candidates.filter((candidate) => Date.parse(candidate.expiresAt) > Date.parse(now));
      const incomingMaterials = current.incomingMaterials?.filter((item) => Date.parse(item.expiresAt) > Date.parse(now));
      if (retained.length !== current.candidates.length || incomingMaterials?.length !== current.incomingMaterials?.length) {
        const cleaned = { ...current, candidates: retained, ...(incomingMaterials ? { incomingMaterials } : {}), revision: current.revision + 1, updatedAt: now, updatedBy: 'retention-cleanup' };
        if (!await store.compareAndSet(actor.organizationId, current.revision, cleaned)) throw new RecruitmentJobError(409, '档案已更新，请重新加载');
        current = cleaned;
      }
      if (action.knownRevision === current.revision) return { kind: 'unchanged', jobId: current.id, revision: current.revision };
      return this.view(actor, current);
    }
    if (!current && action.kind !== 'save') throw new RecruitmentJobError(404, '岗位不存在或未授权访问');
    if (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 0) throw new RecruitmentJobError(400, '档案版本无效');
    // Exact retry after a lost creation response: only the original owner can
    // acknowledge it, without overwriting any later edit or sharing change.
    if (action.kind === 'save' && action.expectedRevision === 0 && current?.revision === 1 && current.ownerAccountId === actor.id && action.sharingConfirmed === true) {
      const retry = validateRecruitmentCandidates(action.candidates, Date.parse(now));
      if (current.title === action.title && current.description === action.description && JSON.stringify(retry) === JSON.stringify(current.candidates.map(({ id: candidateId, expiresAt, document }) => ({ id: candidateId, expiresAt, document })))) return this.view(actor, current);
    }
    if ((current?.revision ?? 0) !== action.expectedRevision) throw new RecruitmentJobError(409, '其他同事已更新此岗位。请先保留本地修改，再重新加载，不能覆盖新版本');
    if ((action.kind === 'configure_intake' || action.kind === 'dismiss_intake' || action.kind === 'configure_background_analysis' || action.kind === 'configure_auto_archive') && current) {
      let next: RecruitmentSharedJob;
      if (action.kind === 'configure_auto_archive') {
        if (action.enabled && !store.scan) throw new RecruitmentJobError(409, '当前服务器存储不支持后台正式入档');
        next = { ...current, autoArchive: configureRecruitmentAutoArchive(current, actor, action, now), revision: current.revision + 1, updatedAt: now, updatedBy: actor.id };
      } else if (action.kind === 'configure_background_analysis') {
        if (action.enabled && !store.scan) throw new RecruitmentJobError(409, '当前存储不支持服务器后台分析');
        const backgroundAnalysis = configureRecruitmentBackground(current, actor, action, this.options.backgroundModel, now);
        next = { ...current, backgroundAnalysis, revision: current.revision + 1, updatedAt: now, updatedBy: actor.id };
      } else if (action.kind === 'configure_intake') {
        if (action.enabled && !store.scan) throw new RecruitmentJobError(409, '当前存储不支持服务器后台接收');
        const intake = await configureRecruitmentIntake(current, actor, action, this.options.intakeSources, now);
        next = { ...current, intake, revision: current.revision + 1, updatedAt: now, updatedBy: actor.id };
      } else {
        if (action.confirmed !== true || typeof action.itemId !== 'string' || !/^[a-f0-9]{64}$/u.test(action.itemId)) throw new RecruitmentJobError(400, '请确认移除指定待处理材料');
        next = { ...current, incomingMaterials: (current.incomingMaterials ?? []).filter((item) => item.id !== action.itemId), revision: current.revision + 1, updatedAt: now, updatedBy: actor.id };
      }
      await audit('requested', current.revision); await this.assertActorCurrent(actor);
      if (!await store.compareAndSet(actor.organizationId, current.revision, next)) throw new RecruitmentJobError(409, '岗位或后台任务状态已变化，请刷新后重试');
      await audit('completed', next.revision); return this.view(actor, next);
    }
    if (action.kind === 'copy_candidate' || action.kind === 'link_candidate') {
      if (action.sharingConfirmed !== true) throw new RecruitmentJobError(400, '请确认身份及向目标岗位授权同事共享材料的权限');
      const source = current?.candidates.find((item) => item.id === recruitmentJobId(action.candidateId) && Date.parse(item.expiresAt) > Date.parse(now));
      if (!current || !source) throw new RecruitmentJobError(404, '候选人不存在、已到期或未授权访问');
      if (!source.personId) throw new RecruitmentJobError(400, '请先保存来源岗位，再关联已有候选人');
      const target = await store.get(actor.organizationId, recruitmentJobId(action.targetJobId));
      await this.assertActorCurrent(actor);
      if (!target || !this.visible(actor, target)) throw new RecruitmentJobError(404, '目标岗位不存在或未授权访问');
      if (target.id === current.id) throw new RecruitmentJobError(400, '请选择另一个岗位');
      if (!Number.isSafeInteger(action.targetRevision) || action.targetRevision !== target.revision) throw new RecruitmentJobError(409, '目标岗位已变化，请刷新岗位列表');
      const retained = target.candidates.filter((item) => Date.parse(item.expiresAt) > Date.parse(now));
      if (retained.some((item) => item.personId === source.personId)) throw new RecruitmentJobError(409, '目标岗位已有此候选人关联，请直接加载，不要重复复制');
      let nextCandidates: RecruitmentArchivedCandidate[];
      if (action.kind === 'copy_candidate') {
        if (retained.some((item) => recruitmentIdentityMatch(source, item))) throw new RecruitmentJobError(409, '目标岗位已有疑似同一人的记录。请先查找已有岗位记录，核对后关联，避免重复建档');
        if (retained.length >= 100) throw new RecruitmentJobError(400, '目标岗位已达到 100 位候选人上限');
        nextCandidates = [...retained, copyRecruitmentCandidate(source, target, now)];
      } else {
        const targetId = recruitmentJobId(action.targetCandidateId);
        if (!retained.some((item) => item.id === targetId)) throw new RecruitmentJobError(404, '目标候选人不存在或已到期');
        nextCandidates = retained.map((item) => item.id === targetId ? { ...item, personId: source.personId } : item);
      }
      if (Buffer.byteLength(JSON.stringify([nextCandidates, target.incomingMaterials ?? []]), 'utf8') > 5_900_000 || nextCandidates.some((item) => item.document.length > 1_000_000)) throw new RecruitmentJobError(400, '目标岗位档案超过大小限制');
      const next = { ...target, candidates: nextCandidates, revision: target.revision + 1, updatedAt: now, updatedBy: actor.id };
      const copiedCandidateId = action.kind === 'copy_candidate' ? nextCandidates.at(-1)?.id : undefined;
      await audit('requested', current.revision, copiedCandidateId);
      await this.assertActorCurrent(actor);
      if (!await store.compareAndSet(actor.organizationId, target.revision, next, [{ id: current.id, revision: current.revision }])) throw new RecruitmentJobError(409, '来源或目标岗位已变化，关联未保存，请重新加载');
      await audit('completed', next.revision, copiedCandidateId);
      return this.view(actor, next);
    }
    if ((action.kind === 'share' || action.kind === 'delete') && !actor.isAdmin && current?.ownerAccountId !== actor.id) throw new RecruitmentJobError(403, '仅企业管理员或岗位创建者可以管理岗位授权或删除共享岗位');
    let next: RecruitmentSharedJob;
    if (action.kind === 'unlink_candidate' && current) {
      if (action.confirmed !== true) throw new RecruitmentJobError(400, '请确认解除当前岗位的候选人关联');
      const candidateId = recruitmentJobId(action.candidateId);
      if (!current.candidates.some((item) => item.id === candidateId && Date.parse(item.expiresAt) > Date.parse(now))) throw new RecruitmentJobError(404, '候选人不存在或已到期');
      next = { ...current, candidates: current.candidates.map((item) => item.id === candidateId ? { ...item, personId: `person:${randomUUID()}` } : item), revision: current.revision + 1, updatedAt: now, updatedBy: actor.id };
    } else if (action.kind === 'save') {
      if (action.sharingConfirmed !== true) throw new RecruitmentJobError(400, '请确认有权将候选人材料保存到企业服务器');
      next = { id, ...(current?.backgroundAnalysis ? { backgroundAnalysis: current.backgroundAnalysis } : {}), ...(current?.intake ? { intake: current.intake } : {}), ...(current?.incomingMaterials ? { incomingMaterials: current.incomingMaterials } : {}), ownerAccountId: current ? current.ownerAccountId : actor.id, title: recruitmentJobText(action.title, 500, true), description: recruitmentJobText(action.description, 30_000), candidates: validateRecruitmentCandidates(action.candidates, Date.parse(now)), collaboratorAccountIds: current?.collaboratorAccountIds ?? [], revision: action.expectedRevision + 1, updatedAt: now, updatedBy: actor.id };
      // The client cannot forge cross-job identity links through an ordinary save.
      next.candidates = next.candidates.map((item) => ({ ...item, personId: current?.candidates.find((previous) => previous.id === item.id && Date.parse(previous.expiresAt) > Date.parse(now))?.personId ?? `person:${randomUUID()}` }));
    } else if (action.kind === 'share' && current) {
      if (!Array.isArray(action.collaboratorAccountIds) || action.collaboratorAccountIds.length > 100) throw new RecruitmentJobError(400, '岗位协作者列表无效');
      const ids = [...new Set(action.collaboratorAccountIds.map(recruitmentJobId))];
      for (const collaborator of await Promise.all(ids.map((value) => this.options.getActor(value)))) {
        if (!collaborator?.active || collaborator.organizationId !== actor.organizationId) throw new RecruitmentJobError(400, '协作者必须是本企业的有效账号');
      }
      next = { ...current, collaboratorAccountIds: ids, revision: current.revision + 1, updatedAt: now, updatedBy: actor.id };
    } else if (action.kind === 'delete' && current) {
      const fresh = await this.actor(accountId);
      if (fresh.organizationId !== actor.organizationId || (!fresh.isAdmin && current.ownerAccountId !== fresh.id)) throw new RecruitmentJobError(403, '企业账号权限已变化');
      await audit('requested', current.revision);
      await this.assertActorCurrent(actor);
      if (!await store.remove(actor.organizationId, id, current.revision)) throw new RecruitmentJobError(409, '岗位已更新，请重新加载后删除');
      await audit('completed', current.revision);
      return { kind: 'deleted' };
    } else throw new RecruitmentJobError(400, '招聘档案操作无效');
    if (action.kind === 'save' && current?.autoArchive) next.autoArchive = current.autoArchive;
    if (Buffer.byteLength(JSON.stringify([next.candidates, next.incomingMaterials ?? []]), 'utf8') > 5_900_000) throw new RecruitmentJobError(400, '岗位档案和待处理材料超过容量限制');
    const fresh = await this.actor(accountId);
    if (fresh.organizationId !== actor.organizationId || fresh.isAdmin !== actor.isAdmin) throw new RecruitmentJobError(403, '企业账号权限已变化');
    await audit('requested', action.expectedRevision);
    await this.assertActorCurrent(actor);
    if (!await store.compareAndSet(actor.organizationId, action.expectedRevision, next)) throw new RecruitmentJobError(409, '岗位已被其他同事更新，请重新加载');
    await audit('completed', next.revision);
    return this.view(actor, next);
  }
}
