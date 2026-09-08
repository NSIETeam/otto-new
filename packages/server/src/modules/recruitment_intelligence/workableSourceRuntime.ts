/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { WorkableConnectionService } from './workableConnections.js';
import { createWorkableRecruitmentRegistration } from './workableMcpSession.js';
import { createRecruitmentSourceRuntime, type RecruitmentSourceRuntime } from './recruitmentSourceRuntime.js';
import type { RecruitmentSourceStore } from './recruitmentSourceStore.js';
import type { RecruitmentSearchAuditEvent } from './recruitmentSourceGateway.js';
import type { RecruitmentMaterialAuditEvent } from './recruitmentSourceMaterial.js';

/** Installed by both enterprise hosts; installation and OAuth are NOT production acceptance. */
export function createWorkableSourceRuntime(options: {
  connectionService(): Pick<WorkableConnectionService, 'resolveGrant'>;
  store: RecruitmentSourceStore;
  audit(event: RecruitmentSearchAuditEvent): Promise<void>;
  auditMaterial(event: RecruitmentMaterialAuditEvent): Promise<void>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}): RecruitmentSourceRuntime {
  const env = options.env ?? process.env;
  const resolveGrant: WorkableConnectionService['resolveGrant'] = (scope, signal) => options.connectionService().resolveGrant(scope, signal);
  const reference = env.OTTO_WORKABLE_AUTHORIZATION_REFERENCE?.trim() ?? '';
  // Download hosts require explicit review. No CDN wildcard and no guessing from resume URLs.
  let approvedOrigins: string[] | undefined;
  if (env.OTTO_WORKABLE_RESUME_ORIGINS) {
    const value: unknown = JSON.parse(env.OTTO_WORKABLE_RESUME_ORIGINS);
    if (!Array.isArray(value) || value.length < 1 || value.length > 20 || !value.every((item) => typeof item === 'string')) throw new Error('Workable 简历下载来源配置无效');
    approvedOrigins = value;
  }
  return createRecruitmentSourceRuntime({
    registrations: [createWorkableRecruitmentRegistration({
      resolveGrant, fetch: options.fetch,
      approval: { realAccountVerified: env.OTTO_WORKABLE_REAL_ACCOUNT_VERIFIED === '1', authorizationReference: reference },
      ...(approvedOrigins ? { resume: { approvedOrigins } } : {}),
    })],
    store: options.store, audit: options.audit, auditMaterial: options.auditMaterial,
    sourceTimeoutMs: 25_000,
    async authorizeSource(input) {
      if (!input.requisitionId) return { allowed: false, reason: '请先保存或加载有权访问的企业共享岗位，再检查该岗位的来源授权' };
      const grant = await resolveGrant({ organizationId: input.organizationId, actorAccountId: input.actorAccountId, requisitionId: input.requisitionId }, AbortSignal.timeout(5_000));
      return grant ? { allowed: true } : { allowed: false, reason: '本人授权已失效、当前岗位未绑定或岗位权限已变化，请刷新本人授权' };
    },
  });
}
