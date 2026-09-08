/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import {
  createRecruitmentSourceGateway,
  RECRUITMENT_REQUIRED_SOURCE_CAPABILITIES,
  type RecruitmentGatewaySearchRequest,
  type RecruitmentGatewaySearchResult,
  type RecruitmentSearchAuditEvent,
  type RecruitmentSourceAdapter,
  type RecruitmentSourceAuthorization,
} from './recruitmentSourceGateway.js';
import {
  MemoryRecruitmentSourceStore,
  type RecruitmentSourceStore,
} from './recruitmentSourceStore.js';
import { createRecruitmentMaterialReader, type RecruitmentMaterialRequest, type RecruitmentMaterialResult, type RecruitmentMaterialAuditEvent } from './recruitmentSourceMaterial.js';

export type RecruitmentSourceAccessMode =
  | 'enterprise_owned'
  | 'official_api'
  | 'authorized_mcp'
  | 'evaluation_only';

export interface RecruitmentSourceRegistration {
  adapter: RecruitmentSourceAdapter;
  accessMode: RecruitmentSourceAccessMode;
  /**
   * Explicit deployment decision. A public GitHub repository or a trusted MCP
   * process is not, by itself, evidence that commercial candidate access is
   * authorized.
   */
  productionEnabled: boolean;
  authorizationReference?: string;
  repositoryUrl?: string;
}

export interface RecruitmentSourceRuntimeView {
  id: string;
  label: string;
  accessMode: RecruitmentSourceAccessMode;
  capabilities: readonly string[];
  productionEnabled: boolean;
  authorized: boolean;
  searchable: boolean;
  materialReadable?: boolean;
  status:
    | 'ready'
    | 'organization_authorization_required'
    | 'connector_capability_required'
    | 'production_approval_required';
  authorizationEvidenceRecorded: boolean;
  repositoryUrl?: string;
  reason?: string;
}

export interface RecruitmentSourceRuntime {
  getCandidateMaterial?(input: RecruitmentMaterialRequest): Promise<RecruitmentMaterialResult>;
  listSources(input: {
    organizationId: string;
    actorAccountId: string;
    requisitionId?: string;
  }): Promise<RecruitmentSourceRuntimeView[]>;
  search(input: RecruitmentGatewaySearchRequest): Promise<RecruitmentGatewaySearchResult>;
  getSearchRun(
    organizationId: string,
    runId: string,
  ): ReturnType<RecruitmentSourceStore['getSearchRun']>;
}

function safeRepositoryUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function deploymentAuthorization(
  registration: RecruitmentSourceRegistration,
): RecruitmentSourceAuthorization {
  if (
    registration.accessMode === 'evaluation_only' ||
    !registration.productionEnabled
  ) {
    return {
      allowed: false,
      reason: '连接器仅允许隔离评估，尚未批准读取真实候选人数据',
    };
  }
  if (!registration.authorizationReference?.trim()) {
    return {
      allowed: false,
      reason: '缺少平台授权、企业自有数据授权或处理协议记录',
    };
  }
  return { allowed: true };
}

async function organizationAuthorization(
  registration: RecruitmentSourceRegistration,
  input: { organizationId: string; actorAccountId: string; requisitionId?: string },
  authorizeSource: (input: {
    organizationId: string;
    actorAccountId: string;
    sourceId: string;
    requisitionId?: string;
  }) => Promise<RecruitmentSourceAuthorization>,
): Promise<RecruitmentSourceAuthorization> {
  const deployment = deploymentAuthorization(registration);
  if (!deployment.allowed) return deployment;
  try {
    return await authorizeSource({
      ...input,
      sourceId: registration.adapter.id,
    });
  } catch {
    return {
      allowed: false,
      reason: '暂时无法验证该企业的来源授权，请稍后重试',
    };
  }
}

export function createRecruitmentSourceRuntime(options: {
  registrations: readonly RecruitmentSourceRegistration[];
  authorizeSource(input: {
    organizationId: string;
    actorAccountId: string;
    sourceId: string;
    requisitionId?: string;
  }): Promise<RecruitmentSourceAuthorization>;
  store?: RecruitmentSourceStore;
  audit?(event: RecruitmentSearchAuditEvent): Promise<void>;
  auditMaterial?(event: RecruitmentMaterialAuditEvent): Promise<void>;
  sourceTimeoutMs?: number;
  now?: () => Date;
  nowMs?: () => number;
  createId?: () => string;
}): RecruitmentSourceRuntime {
  const registrations = [...options.registrations];
  const byId = new Map<string, RecruitmentSourceRegistration>();
  for (const registration of registrations) {
    if (byId.has(registration.adapter.id)) {
      throw new Error('recruitment source registration is duplicated');
    }
    byId.set(registration.adapter.id, registration);
  }
  const store = options.store ?? new MemoryRecruitmentSourceStore({ now: options.now ? () => options.now!().getTime() : undefined });
  const authorize = async (input: {
    organizationId: string;
    actorAccountId: string;
    sourceId: string;
    requisitionId?: string;
  }): Promise<RecruitmentSourceAuthorization> => {
    const registration = byId.get(input.sourceId);
    if (!registration) return { allowed: false, reason: '招聘来源未登记' };
    const deployment = deploymentAuthorization(registration);
    if (!deployment.allowed) return deployment;
    return options.authorizeSource(input);
  };
  const gateway = createRecruitmentSourceGateway({
    adapters: registrations.map((registration) => registration.adapter),
    authorizeSource: authorize,
    persistence: store,
    audit: options.audit,
    sourceTimeoutMs: options.sourceTimeoutMs,
    now: options.now,
    nowMs: options.nowMs,
    createId: options.createId,
  });

  return {
    getCandidateMaterial: createRecruitmentMaterialReader({
      store, registrations: byId, authorize, audit: options.auditMaterial,
      timeoutMs: options.sourceTimeoutMs, now: options.now,
    }),
    async listSources(input) {
      return Promise.all(registrations.map(async (registration) => {
        const deployment = deploymentAuthorization(registration);
        const organization = await organizationAuthorization(
          registration,
          input,
          options.authorizeSource,
        );
        const capabilities = new Set(registration.adapter.capabilities);
        const missingCapabilities = RECRUITMENT_REQUIRED_SOURCE_CAPABILITIES.filter(
          (capability) => !capabilities.has(capability),
        );
        const searchable = deployment.allowed
          && organization.allowed
          && missingCapabilities.length === 0;
        const repositoryUrl = safeRepositoryUrl(registration.repositoryUrl);
        return {
          id: registration.adapter.id,
          label: registration.adapter.label,
          accessMode: registration.accessMode,
          capabilities: [...registration.adapter.capabilities],
          productionEnabled: registration.productionEnabled,
          authorized: organization.allowed,
          searchable,
          materialReadable: searchable && typeof registration.adapter.getCandidate === 'function',
          status: searchable
            ? 'ready'
            : !deployment.allowed
              ? 'production_approval_required'
              : !organization.allowed
                ? 'organization_authorization_required'
                : 'connector_capability_required',
          authorizationEvidenceRecorded: Boolean(
            registration.authorizationReference?.trim(),
          ),
          ...(repositoryUrl ? { repositoryUrl } : {}),
          ...(organization.reason
            ? { reason: organization.reason }
            : missingCapabilities.length > 0
              ? { reason: `连接器缺少 ${missingCapabilities.join('、')} 能力` }
              : {}),
        } satisfies RecruitmentSourceRuntimeView;
      }));
    },
    search(input) {
      // A fresh interactive query must not reuse another job's synchronization cursor.
      // Pagination is explicit; an empty cursor means the first page for that source.
      return gateway.search({
        ...input,
        cursors: Object.fromEntries(registrations.map(({ adapter }) => [adapter.id, input.cursors?.[adapter.id] ?? ''])),
      });
    },
    getSearchRun(organizationId, runId) {
      return store.getSearchRun(organizationId, runId);
    },
  };
}
