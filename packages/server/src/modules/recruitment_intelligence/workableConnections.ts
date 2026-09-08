/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomBytes, randomUUID } from 'node:crypto';
import { validateWorkableRedirect, type WorkableOAuthClient } from './workableOAuthClient.js';
import { recruitmentJobId, type RecruitmentJobActor, type RecruitmentJobHeader } from './recruitmentJobs.js';
import type { WorkableConnectionRecord, WorkableConnectionStore, WorkableVerifiedTarget } from './workableConnectionStore.js';
import { createWorkableRecruitmentAdapter, probeWorkableConnection, type WorkableRecruitmentScope } from './workableRecruitmentAdapter.js';
import { readWorkableAcceptanceApproval, probeWorkableMaterial, type WorkableMaterialCheck } from './workableAcceptance.js';
import { createRecruitmentResumeReader } from './recruitmentResumeReader.js';
import { createWorkableMcpSessionFactory, type WorkableOAuthGrant } from './workableMcpSession.js';

export type WorkableConnectionAction =
  | { kind: 'status'; jobId?: string }
  | { kind: 'probe'; jobId: string; expectedRevision: number; confirmed: true }
  | { kind: 'material_probe'; jobId: string; expectedRevision: number; confirmed: true }
  | { kind: 'oauth_start'; expectedRevision: number; redirectUri: string; confirmed: true }
  | { kind: 'oauth_complete'; state: string; code: string }
  | { kind: 'oauth_cancel'; state: string; confirmed: true }
  | { kind: 'bind'; jobId: string; expectedRevision: number; account: string; shortcode: string; confirmed: true }
  | { kind: 'unbind'; jobId: string; expectedRevision: number; confirmed: true }
  | { kind: 'revoke'; expectedRevision: number; confirmed: true };
export interface WorkableConnectionView {
  revision: number;
  status: 'authorization_required' | 'expired' | 'binding_required' | 'bound_pending_acceptance';
  targets: WorkableVerifiedTarget[];
  binding?: { account: string; shortcode: string };
  expiresAt?: string;
  authorizationAvailable: boolean;
  authorizationPending?: boolean;
  connectionCheck?: { checkedAt: string; scope: 'protocol_and_account_only'; candidateReadVerified: false; resumeReadVerified: false };
  materialAcceptanceAvailable?: boolean;
  materialCheck?: WorkableMaterialCheck;
  /** Returned only to the initiating desktop main process, never includes verifier or token. */
  authorization?: { url: string; state: string };
}
export class WorkableConnectionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const conflict = (): never => { throw new WorkableConnectionError(409, '授权或绑定已变化，请刷新后重新操作'); };
function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(value)) throw new WorkableConnectionError(400, 'Workable 账号或岗位标识无效');
  return value;
}

/** Per-user vault and broker. No global token fallback and no renderer token-import route. */
export class WorkableConnectionService {
  private readonly activeProbes = new Set<string>();
  constructor(private readonly options: {
    store: WorkableConnectionStore;
    getActor(id: string): Promise<RecruitmentJobActor | null>;
    getJob(org: string, jobId: string): Promise<RecruitmentJobHeader | null>;
    audit(event: { organizationId: string; actorAccountId: string; kind: string; revision: number; phase: 'requested' | 'completed'; jobId?: string }): Promise<void>;
    now?: () => number;
    oauth?: WorkableOAuthClient;
    probeFetch?: typeof globalThis.fetch;
    acceptanceEnv?: NodeJS.ProcessEnv;
  }) {}

  private async actor(id: string, org?: string): Promise<RecruitmentJobActor> {
    recruitmentJobId(id);
    const actor = await this.options.getActor(id);
    if (!actor?.active || actor.id !== id || (org !== undefined && actor.organizationId !== org)) throw new WorkableConnectionError(403, '企业账号不可用或授权范围不一致');
    recruitmentJobId(actor.organizationId);
    return actor;
  }
  private async allowedJob(actor: RecruitmentJobActor, jobId: string): Promise<void> {
    const fresh = await this.actor(actor.id, actor.organizationId);
    const job = await this.options.getJob(actor.organizationId, recruitmentJobId(jobId));
    if (!job || job.id !== jobId || (!fresh.isAdmin && job.ownerAccountId !== actor.id && !job.collaboratorAccountIds.includes(actor.id))) throw new WorkableConnectionError(404, '岗位不存在或未授权访问');
  }
  private valid(record: WorkableConnectionRecord | null): boolean {
    return Boolean(record?.grant && Number.isFinite(Date.parse(record.grant.expiresAt)) && Date.parse(record.grant.expiresAt) > (this.options.now?.() ?? Date.now()));
  }
  private view(record: WorkableConnectionRecord | null, jobId?: string): WorkableConnectionView {
    const binding = record?.bindings.find((item) => item.jobId === jobId);
    const valid = this.valid(record);
    return { revision: record?.revision ?? 0, authorizationAvailable: Boolean(this.options.oauth),
      ...(record?.pendingOAuth && record.pendingOAuth.expiresAt > (this.options.now?.() ?? Date.now()) ? { authorizationPending: true } : {}),
      status: !record?.grant ? 'authorization_required' : !valid ? 'expired' : !binding ? 'binding_required' : 'bound_pending_acceptance',
      targets: valid ? record!.grant!.targets.map((target) => ({ ...target })) : [],
      ...(valid && binding ? { binding: { account: binding.account, shortcode: binding.shortcode } } : {}),
      ...(record?.grant ? { expiresAt: record.grant.expiresAt } : {}),
      ...(valid && binding && record?.grant && record.materialAcceptance && record.materialAcceptance.jobId === jobId && record.materialAcceptance.bindingVersion === `${record.grant.id}_${binding.revision}` ? { materialCheck: record.materialAcceptance.report } : {}),
    };
  }
  private async save(actor: RecruitmentJobActor, expected: number, next: WorkableConnectionRecord, kind: string, jobId?: string): Promise<void> {
    if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) throw new WorkableConnectionError(400, '授权修订号无效');
    const event = { organizationId: actor.organizationId, actorAccountId: actor.id, kind, revision: next.revision, ...(jobId ? { jobId } : {}) };
    await this.options.audit({ ...event, phase: 'requested' });
    await this.actor(actor.id, actor.organizationId);
    if (jobId) await this.allowedJob(actor, jobId);
    if (!await this.options.store.compareAndSet(actor.organizationId, actor.id, expected, next)) conflict();
    await this.options.audit({ ...event, phase: 'completed' });
  }

  /** Only a trusted server-side OAuth callback after state/PKCE, owner and catalog validation may call this.
   * Capture expectedRevision when starting OAuth, not when its delayed callback arrives.
   * Intentionally not exposed through HTTP/IPC; this does NOT implement OAuth itself. */
  async acceptVerifiedGrant(input: { organizationId: string; actorAccountId: string; expectedRevision: number; accessToken: string; expiresAt: string; targets: WorkableVerifiedTarget[] }): Promise<void> {
    const actor = await this.actor(input.actorAccountId, input.organizationId);
    if (typeof input.accessToken !== 'string' || !/^[\x21-\x7E]{1,8192}$/u.test(input.accessToken)
      || typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= (this.options.now?.() ?? Date.now())
      || !Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 100) throw new WorkableConnectionError(400, '已验证授权材料无效或过期');
    const targets = input.targets.map((target) => {
      if (!target || typeof target.label !== 'string' || !target.label.trim() || target.label.length > 500) throw new WorkableConnectionError(400, '已验证的岗位目录无效');
      return { account: providerId(target.account), shortcode: providerId(target.shortcode), label: target.label };
    });
    if (new Set(targets.map((t) => JSON.stringify([t.account, t.shortcode]))).size !== targets.length) throw new WorkableConnectionError(400, '岗位目录重复');
    const current = await this.options.store.get(actor.organizationId, actor.id);
    await this.save(actor, input.expectedRevision, { revision: input.expectedRevision + 1, grant: { id: randomUUID(), accessToken: input.accessToken, expiresAt: input.expiresAt, targets }, bindings: [], ...(current?.lastOAuthStartedAt !== undefined ? { lastOAuthStartedAt: current.lastOAuthStartedAt } : {}) }, 'authorize');
  }

  async act(accountId: string, action: WorkableConnectionAction): Promise<WorkableConnectionView> {
    const result = await this.execute(accountId, action);
    if (!('jobId' in action) || !action.jobId) return result;
    const actor = await this.actor(accountId);
    return { ...result, materialAcceptanceAvailable: Boolean(readWorkableAcceptanceApproval(this.options.acceptanceEnv ?? process.env,
      { organizationId: actor.organizationId, actorAccountId: actor.id, requisitionId: action.jobId }, this.options.now?.() ?? Date.now())) };
  }
  private async execute(accountId: string, action: WorkableConnectionAction): Promise<WorkableConnectionView> {
    if (!action || typeof action !== 'object' || !['status', 'probe', 'material_probe', 'bind', 'unbind', 'revoke', 'oauth_start', 'oauth_complete', 'oauth_cancel'].includes(action.kind)) throw new WorkableConnectionError(400, '授权操作无效');
    const actor = await this.actor(accountId);
    if (action.kind === 'oauth_start' || action.kind === 'oauth_complete' || action.kind === 'oauth_cancel') return this.oauthAction(actor, action);
    if (action.kind !== 'revoke' && (action.kind !== 'status' || action.jobId !== undefined)) await this.allowedJob(actor, action.jobId!);
    const current = await this.options.store.get(actor.organizationId, actor.id);
    if (action.kind === 'status') {
      if (action.jobId !== undefined) await this.allowedJob(actor, action.jobId);
      else await this.actor(actor.id, actor.organizationId);
      const fresh = await this.options.store.get(actor.organizationId, actor.id);
      return this.view(fresh, action.jobId);
    }
    if (action.confirmed !== true) throw new WorkableConnectionError(400, '请先确认本次授权变更');
    if ((current?.revision ?? 0) !== action.expectedRevision) conflict();
    if (action.kind === 'probe') return this.probe(actor, action, current);
    if (action.kind === 'material_probe') return this.materialProbe(actor, action, current);
    let next: WorkableConnectionRecord;
    if (action.kind === 'revoke') next = { revision: action.expectedRevision + 1, grant: null, bindings: [], ...(current?.lastOAuthStartedAt ? { lastOAuthStartedAt: current.lastOAuthStartedAt } : {}) };
    else {
      if (!current || !this.valid(current)) throw new WorkableConnectionError(409, '请先完成本人 Workable 授权');
      const bindings = current.bindings.filter((binding) => binding.jobId !== action.jobId);
      if (action.kind === 'bind') {
        const account = providerId(action.account); const shortcode = providerId(action.shortcode);
        if (!current.grant!.targets.some((target) => target.account === account && target.shortcode === shortcode)) throw new WorkableConnectionError(403, '账号或岗位不在本人已验证授权目录中');
        if (bindings.length >= 100) throw new WorkableConnectionError(400, '已达到岗位绑定数量上限');
        bindings.push({ jobId: action.jobId, account, shortcode, revision: randomUUID() });
      }
      next = { ...current, revision: current.revision + 1, bindings };
    }
    await this.save(actor, action.expectedRevision, next, action.kind, action.kind === 'revoke' ? undefined : action.jobId);
    return this.view(next, action.kind === 'revoke' ? undefined : action.jobId);
  }

  private async materialProbe(actor: RecruitmentJobActor, action: Extract<WorkableConnectionAction, { kind: 'material_probe' }>, current: WorkableConnectionRecord | null): Promise<WorkableConnectionView> {
    const scope = { organizationId: actor.organizationId, actorAccountId: actor.id, requisitionId: action.jobId };
    const env = this.options.acceptanceEnv ?? process.env;
    const approval = readWorkableAcceptanceApproval(env, scope, this.options.now?.() ?? Date.now());
    if (!approval) throw new WorkableConnectionError(403, '尚未为本企业、本人和当前岗位批准限期样本验收；无需也不能冒充生产已验收');
    const binding = current?.bindings.find((item) => item.jobId === action.jobId);
    if (!current || !this.valid(current) || !binding) throw new WorkableConnectionError(409, '请先完成本人授权并绑定测试岗位');
    const key = JSON.stringify([actor.organizationId, actor.id]);
    if (this.activeProbes.has(key) || this.activeProbes.size >= 100) throw new WorkableConnectionError(429, '只读检查正在执行，请稍后再试');
    this.activeProbes.add(key);
    const expectedBinding = `${current.grant!.id}_${binding.revision}`;
    try {
      const signal = AbortSignal.timeout(25_000);
      const authorize = async (input = scope, cancellation = signal) => {
        const permit = readWorkableAcceptanceApproval(env, scope, this.options.now?.() ?? Date.now());
        if (permit?.approvalFingerprint !== approval.approvalFingerprint) throw new Error('验收批准已变化');
        const record = await this.options.store.get(actor.organizationId, actor.id);
        if (record?.revision !== current.revision) throw new Error('授权记录已变化');
        const grant = await this.resolveGrant(input, cancellation);
        if (grant?.bindingRevision !== expectedBinding) throw new Error('绑定已变化');
        return grant;
      };
      let approvedOrigins: string[] | undefined;
      if (env.OTTO_WORKABLE_RESUME_ORIGINS) {
        const origins: unknown = JSON.parse(env.OTTO_WORKABLE_RESUME_ORIGINS);
        if (!Array.isArray(origins) || !origins.length || origins.length > 20 || !origins.every((entry) => typeof entry === 'string')) throw new Error('附件配置无效');
        approvedOrigins = origins;
      }
      const adapter = createWorkableRecruitmentAdapter({ openSession: createWorkableMcpSessionFactory({ resolveGrant: authorize, fetch: this.options.probeFetch }),
        ...(approvedOrigins ? { resumeReader: createRecruitmentResumeReader({ approvedOrigins }) } : {}) });
      await this.options.audit({ ...scope, jobId: action.jobId, kind: 'material_probe', phase: 'requested', revision: current.revision });
      const report = await probeWorkableMaterial({ adapter, scope, signal, assertAuthorized: async () => { await authorize(); }, now: this.options.now });
      await authorize(); signal.throwIfAborted();
      const next = { ...current, revision: current.revision + 1, materialAcceptance: { jobId: action.jobId, bindingVersion: expectedBinding, approvalFingerprint: approval.approvalFingerprint, report } };
      if (!await this.options.store.compareAndSet(actor.organizationId, actor.id, current.revision, next)) conflict();
      await this.options.audit({ ...scope, jobId: action.jobId, kind: 'material_probe', phase: 'completed', revision: next.revision });
      await this.allowedJob(actor, action.jobId);
      const fresh = await this.options.store.get(actor.organizationId, actor.id);
      if (fresh?.revision !== next.revision || !this.valid(fresh)) conflict();
      return this.view(fresh, action.jobId);
    } catch { throw new WorkableConnectionError(409, '验收读取未完成或授权发生变化，请刷新后核对；不会自动重试，也未开启生产或模型分析'); }
    finally { this.activeProbes.delete(key); }
  }
  private async probe(actor: RecruitmentJobActor, action: Extract<WorkableConnectionAction, { kind: 'probe' }>, current: WorkableConnectionRecord | null): Promise<WorkableConnectionView> {
    if (!current || !this.valid(current) || !current.bindings.some((item) => item.jobId === action.jobId)) throw new WorkableConnectionError(409, '请先完成本人授权并绑定当前岗位');
    const key = JSON.stringify([actor.organizationId, actor.id]);
    if (this.activeProbes.has(key) || this.activeProbes.size >= 100) throw new WorkableConnectionError(429, '连接检查正在进行，请稍后再试');
    this.activeProbes.add(key);
    const event = { organizationId: actor.organizationId, actorAccountId: actor.id, jobId: action.jobId, kind: 'probe', revision: current.revision };
    try {
      await this.options.audit({ ...event, phase: 'requested' });
      const signal = AbortSignal.timeout(20_000);
      const scope = { organizationId: actor.organizationId, actorAccountId: actor.id, requisitionId: action.jobId };
      const expectedBinding = `${current.grant!.id}_${current.bindings.find((item) => item.jobId === action.jobId)!.revision}`;
      const open = createWorkableMcpSessionFactory({ resolveGrant: async (input, cancellation) => {
        const grant = await this.resolveGrant(input, cancellation);
        return grant?.bindingRevision === expectedBinding ? grant : null;
      }, fetch: this.options.probeFetch });
      await probeWorkableConnection(await open(scope, signal), signal);
      await this.options.audit({ ...event, phase: 'completed' });
      await this.allowedJob(actor, action.jobId);
      const fresh = await this.options.store.get(actor.organizationId, actor.id);
      if (fresh?.revision !== current.revision || !this.valid(fresh)) conflict();
      return { ...this.view(fresh, action.jobId), connectionCheck: { checkedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), scope: 'protocol_and_account_only', candidateReadVerified: false, resumeReadVerified: false } };
    } catch {
      throw new WorkableConnectionError(409, '连接检查未通过或授权已变化，请刷新后重试。未读取候选人或简历，也未开启生产访问');
    } finally { this.activeProbes.delete(key); }
  }

  private async oauthAction(actor: RecruitmentJobActor, action: Extract<WorkableConnectionAction, { kind: 'oauth_start' | 'oauth_complete' | 'oauth_cancel' }>): Promise<WorkableConnectionView> {
    const now = this.options.now?.() ?? Date.now();
    const current = await this.options.store.get(actor.organizationId, actor.id) ?? { revision: 0, grant: null, bindings: [] };
    if (action.kind === 'oauth_cancel') {
      if (action.confirmed !== true || typeof action.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(action.state)) throw new WorkableConnectionError(400, '取消授权请求无效');
      if (current.pendingOAuth?.state !== action.state) return this.view(current);
      const { pendingOAuth: _pending, ...rest } = current;
      const next = { ...rest, revision: current.revision + 1 };
      await this.save(actor, current.revision, next, 'oauth_cancel'); return this.view(next);
    }
    if (!this.options.oauth) throw new WorkableConnectionError(409, '企业服务器尚未开启 Workable 浏览器授权');
    if (action.kind === 'oauth_start') {
      if (action.confirmed !== true) throw new WorkableConnectionError(400, '请先确认在浏览器授权读取平台账号、已发布岗位和候选人');
      try { validateWorkableRedirect(action.redirectUri); } catch { throw new WorkableConnectionError(400, '仅允许桌面客户端的本机临时回调'); }
      if (current.revision !== action.expectedRevision) conflict();
      if ((current.pendingOAuth && current.pendingOAuth.expiresAt > now) || (current.lastOAuthStartedAt !== undefined && now - current.lastOAuthStartedAt < 60_000)) throw new WorkableConnectionError(429, '授权正在进行或发起过于频繁，请取消旧流程并稍后重试');
      const pending = { state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), redirectUri: action.redirectUri, phase: 'preparing' as const, expiresAt: now + 600_000 };
      const next: WorkableConnectionRecord = { ...current, revision: current.revision + 1, pendingOAuth: pending, lastOAuthStartedAt: now };
      await this.save(actor, current.revision, next, 'oauth_start');
      const check = () => this.checkOAuth(actor, next.revision, pending.state);
      try {
        const prepared = await this.options.oauth.prepare(pending, check);
        await check();
        const waiting: WorkableConnectionRecord = { ...next, revision: next.revision + 1, pendingOAuth: { ...pending, clientId: prepared.clientId, phase: 'waiting' } };
        await this.save(actor, next.revision, waiting, 'oauth_ready');
        return { ...this.view(waiting), authorization: { url: prepared.authorizationUrl, state: pending.state } };
      } catch {
        await this.clearFailedOAuth(actor, pending.state);
        throw new WorkableConnectionError(409, 'Workable 授权发起失败、已取消或协议未通过检查，请刷新后重试');
      }
    }
    const pending = current.pendingOAuth;
    if (!pending || pending.phase !== 'waiting' || pending.state !== action.state || pending.expiresAt <= now || !pending.clientId
      || typeof action.code !== 'string' || !/^[\x21-\x7E]{1,2048}$/u.test(action.code)) throw new WorkableConnectionError(409, '授权回调已过期、已使用或不属于当前账号');
    // Claim before any exchange. Retries cannot reuse the same authorization code.
    const claimed: WorkableConnectionRecord = { ...current, revision: current.revision + 1, pendingOAuth: { ...pending, phase: 'exchanging', verifier: '' } };
    await this.save(actor, current.revision, claimed, 'oauth_exchange');
    const check = () => this.checkOAuth(actor, claimed.revision, pending.state);
    try {
      const grant = await this.options.oauth.complete({ clientId: pending.clientId, redirectUri: pending.redirectUri, verifier: pending.verifier, code: action.code }, check);
      await check();
      await this.acceptVerifiedGrant({ organizationId: actor.organizationId, actorAccountId: actor.id, expectedRevision: claimed.revision, ...grant });
      return this.act(actor.id, { kind: 'status' });
    } catch {
      await this.clearFailedOAuth(actor, pending.state);
      throw new WorkableConnectionError(409, 'Workable 授权或已发布岗位目录读取失败、已取消或范围已变化，请重新授权');
    }
  }
  private async checkOAuth(actor: RecruitmentJobActor, revision: number, state: string): Promise<void> {
    await this.actor(actor.id, actor.organizationId);
    const fresh = await this.options.store.get(actor.organizationId, actor.id);
    if (fresh?.revision !== revision || fresh.pendingOAuth?.state !== state || fresh.pendingOAuth.expiresAt <= (this.options.now?.() ?? Date.now())) conflict();
  }
  private async clearFailedOAuth(actor: RecruitmentJobActor, state: string): Promise<void> {
    try { await this.oauthAction(actor, { kind: 'oauth_cancel', state, confirmed: true }); } catch { /* No retries or credential logging; revocation/expiry still fail closed. */ }
  }

  /** Existing MCP transport invokes this again before/after every provider request. */
  async resolveGrant(scope: WorkableRecruitmentScope, signal: AbortSignal): Promise<WorkableOAuthGrant | null> {
    signal.throwIfAborted();
    try {
      const actor = await this.actor(scope.actorAccountId, scope.organizationId);
      await this.allowedJob(actor, scope.requisitionId);
      const record = await this.options.store.get(actor.organizationId, actor.id);
      if (!this.valid(record)) return null;
      const binding = record!.bindings.find((item) => item.jobId === scope.requisitionId);
      if (!binding || !record!.grant!.targets.some((t) => t.account === binding.account && t.shortcode === binding.shortcode)) return null;
      await this.allowedJob(actor, scope.requisitionId);
      const fresh = await this.options.store.get(actor.organizationId, actor.id);
      signal.throwIfAborted();
      if (fresh?.revision !== record!.revision || !this.valid(fresh)) return null;
      return { ...scope, account: binding.account, jobShortcode: binding.shortcode, bindingRevision: `${record!.grant!.id}_${binding.revision}`, accessToken: record!.grant!.accessToken, expiresAt: record!.grant!.expiresAt };
    } catch (error) { signal.throwIfAborted(); if (error instanceof WorkableConnectionError) return null; throw new Error('Workable 授权读取失败'); }
  }
}
