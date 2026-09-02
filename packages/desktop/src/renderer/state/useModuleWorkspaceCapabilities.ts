/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentProfile } from '../agents/departmentAgents.js';
import type { CustomAgentDefinition } from '../customAgents.js';
import { buildModuleCatalog, type InstalledCustomerModuleSummary, type ModuleDefinition, type ParkModuleAuthorization } from '../moduleCatalog.js';
import { normalizeServerUrlForStorage } from '../moduleWorkspace.js';
import type { ModuleGroupParkIdentity } from '../moduleGroupCatalog.js';
import type {
  EnterpriseOrganizationFeatures,
  EnterpriseOrganizationFeatureState,
} from '../../preload/index.js';

interface CapabilityState {
  key: string;
  status: 'loading' | 'ready' | 'failed';
  featureState: EnterpriseOrganizationFeatureState | null;
  park: ParkModuleAuthorization;
  parkIdentity: ModuleGroupParkIdentity | null;
}

const NO_PARK: ParkModuleAuthorization = {
  hasParkContext: false,
  canViewStatistics: false,
  canViewStaffTasks: false,
  canUseCarpool: false,
};

const INTERNAL_ADMIN_PREVIEW_FEATURES: EnterpriseOrganizationFeatures = {
  enterprise_tree: true,
  park_service: true,
  feishu_auto_reply: true,
  direct_messages: true,
  atoa: true,
  knowledge: true,
  skill_market: true,
};

const INTERNAL_ADMIN_PREVIEW_FEATURE_STATE: EnterpriseOrganizationFeatureState = {
  configured: INTERNAL_ADMIN_PREVIEW_FEATURES,
  entitled: INTERNAL_ADMIN_PREVIEW_FEATURES,
  effective: INTERNAL_ADMIN_PREVIEW_FEATURES,
};

const INTERNAL_ADMIN_PREVIEW_PARK: ParkModuleAuthorization = {
  hasParkContext: true,
  canViewStatistics: true,
  canViewStaffTasks: true,
  canUseCarpool: true,
};

const INTERNAL_ADMIN_PREVIEW_PARK_IDENTITY: ModuleGroupParkIdentity = {
  name: '北控宏创科技园',
  slug: 'hongchuang-park',
  status: 'active',
};

export function useModuleWorkspaceCapabilities(input: {
  edition: 'personal' | 'enterprise';
  serverUrl: string;
  organizationId?: string | null;
  accountId: string;
  accountIsAdmin?: boolean;
  internalAdminPreview?: boolean;
  profiles: readonly AgentProfile[];
  customAgents: readonly CustomAgentDefinition[];
  customerModules?: readonly InstalledCustomerModuleSummary[];
}): {
  status: CapabilityState['status'];
  ready: boolean;
  modules: ModuleDefinition[];
  organizationFeatures: EnterpriseOrganizationFeatures | null;
  organizationFeatureState: EnterpriseOrganizationFeatureState | null;
  /** Same-organization directory baseline; only true after authoritative feature state loads. */
  baselineEnterpriseTreeAvailable: boolean;
  /** Same-organization messaging is baseline and is controlled by configuration, not the Federation entitlement. */
  baselineDirectMessagesAvailable: boolean;
  parkIdentity: ModuleGroupParkIdentity | null;
  retry(): void;
} {
  const key = [
    normalizeServerUrlForStorage(input.serverUrl),
    input.edition,
    input.organizationId?.trim() || 'personal',
    input.accountId.trim() || 'anonymous',
    input.accountIsAdmin ? 'admin' : 'member',
    input.internalAdminPreview ? 'preview' : 'live',
  ].join(':');
  const [retryRevision, setRetryRevision] = useState(0);
  const [state, setState] = useState<CapabilityState>(() => ({
    key,
    status: input.edition === 'personal' || input.internalAdminPreview ? 'ready' : 'loading',
    featureState: input.internalAdminPreview
      ? INTERNAL_ADMIN_PREVIEW_FEATURE_STATE
      : null,
    park: input.internalAdminPreview ? INTERNAL_ADMIN_PREVIEW_PARK : NO_PARK,
    parkIdentity: input.internalAdminPreview ? INTERNAL_ADMIN_PREVIEW_PARK_IDENTITY : null,
  }));
  useEffect(() => {
    let cancelled = false;
    if (input.internalAdminPreview) {
      setState({
        key,
        status: 'ready',
        featureState: INTERNAL_ADMIN_PREVIEW_FEATURE_STATE,
        park: INTERNAL_ADMIN_PREVIEW_PARK,
        parkIdentity: INTERNAL_ADMIN_PREVIEW_PARK_IDENTITY,
      });
      return () => { cancelled = true; };
    }
    if (input.edition === 'personal') {
      setState({ key, status: 'ready', featureState: null, park: NO_PARK, parkIdentity: null });
      return () => { cancelled = true; };
    }
    const organizationId = input.organizationId?.trim();
    setState({ key, status: 'loading', featureState: null, park: NO_PARK, parkIdentity: null });
    if (!organizationId) {
      setState({ key, status: 'failed', featureState: null, park: NO_PARK, parkIdentity: null });
      return () => { cancelled = true; };
    }
    if (typeof window.otto.enterpriseOrganizationFeatureStateGet !== 'function') {
      setState({ key, status: 'failed', featureState: null, park: NO_PARK, parkIdentity: null });
      return () => { cancelled = true; };
    }
    const stateRequest = window.otto.enterpriseOrganizationFeatureStateGet();
    void stateRequest.then(async (featureState) => {
      const features = featureState.effective;
      let parkAuthorization: ParkModuleAuthorization = {
        ...NO_PARK,
        disabledReason: features.park_service
          ? '当前企业尚未绑定园区服务空间'
          : '当前服务器尚未授权园区服务模块',
      };
      let parkIdentity: ModuleGroupParkIdentity | null = null;
      if (features.park_service) {
        try {
          const park = await window.otto.enterpriseParkView();
          const hasParkContext = Boolean(park && park.status === 'active');
          if (park) {
            parkIdentity = {
              name: park.name,
              slug: park.slug,
              status: park.status,
            };
          }
          let canViewStaffTasks = false;
          let canUseCarpool = false;
          if (hasParkContext) {
            const [ticketResult, carpoolResult] = await Promise.allSettled([
              window.otto.enterpriseTicketList(),
              typeof window.otto.enterpriseParkCarpoolGet === 'function'
                ? window.otto.enterpriseParkCarpoolGet()
                : Promise.reject(new Error('park carpool capability unavailable')),
            ]);
            if (ticketResult.status === 'fulfilled') {
              canViewStaffTasks = ticketResult.value.some((ticket) => ticket.isRecipient === true);
            }
            if (carpoolResult.status === 'fulfilled') canUseCarpool = true;
          }
          parkAuthorization = {
            hasParkContext,
            canViewStatistics: hasParkContext && Boolean(park?.isAdminOrganization),
            canViewStaffTasks,
            canUseCarpool,
            disabledReason: hasParkContext ? undefined : '当前企业尚未绑定园区服务空间',
          };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          parkIdentity = null;
          parkAuthorization = {
            ...NO_PARK,
            disabledReason: /commercial module is not entitled|not entitled|未授权/i.test(message)
              ? '当前服务器尚未授权园区服务模块'
              : '园区服务状态读取失败，请重新检测',
          };
          // 园区服务不可用时按模块 fail-closed，不影响 Agent、Skill 等独立能力。
        }
      }
      if (cancelled) return;
      setState({
        key,
        status: 'ready',
        featureState,
        park: parkAuthorization,
        parkIdentity,
      });
    }).catch(() => {
      if (!cancelled) setState({ key, status: 'failed', featureState: null, park: NO_PARK, parkIdentity: null });
    });
    return () => { cancelled = true; };
  }, [input.accountIsAdmin, input.accountId, input.edition, input.internalAdminPreview, input.organizationId, input.serverUrl, key, retryRevision]);

  const current = state.key === key ? state : {
    key,
    status: 'loading' as const,
    featureState: null,
    park: NO_PARK,
    parkIdentity: null,
  };
  const effectiveFeatures = current.featureState?.effective ?? null;
  const modules = useMemo(() => buildModuleCatalog({
    edition: input.edition,
    profiles: input.profiles,
    organizationFeatures: effectiveFeatures,
    parkAuthorization: current.park,
    customAgents: input.customAgents,
    customerModules: input.customerModules,
  }), [effectiveFeatures, current.park, input.customAgents, input.customerModules, input.edition, input.profiles]);
  const retry = useCallback(() => setRetryRevision((value) => value + 1), []);
  return {
    status: current.status,
    ready: current.status === 'ready',
    modules,
    organizationFeatures: effectiveFeatures,
    organizationFeatureState: current.featureState,
    baselineEnterpriseTreeAvailable:
      current.status === 'ready' &&
      current.featureState?.configured.enterprise_tree === true,
    baselineDirectMessagesAvailable:
      current.status === 'ready' &&
      current.featureState?.configured.direct_messages === true,
    parkIdentity: current.parkIdentity,
    retry,
  };
}
