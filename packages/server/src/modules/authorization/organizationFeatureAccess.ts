/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  ORGANIZATION_FEATURE_KEYS,
  type OrganizationFeatureKey,
} from '../../productModules.js';
import type {
  OrganizationFeatureConfigurationFacade,
  OrganizationFeatureState,
  OrganizationFeatures,
} from '../identity_organization/index.js';

export interface OrganizationFeatureAccessDependencies {
  configuration: OrganizationFeatureConfigurationFacade;
  isLicenseUsable(feature: OrganizationFeatureKey): boolean;
}

export interface OrganizationFeatureAccessFacade {
  getConfiguredOrganizationFeatures(
    organizationId: string,
  ): OrganizationFeatures;
  getOrganizationFeatures(organizationId: string): OrganizationFeatures;
  getOrganizationFeatureState(
    organizationId: string,
  ): OrganizationFeatureState;
  updateOrganizationFeatures(
    organizationId: string,
    patch: Partial<OrganizationFeatures>,
  ): OrganizationFeatures;
  isOrganizationFeatureEnabled(
    organizationId: string,
    feature: OrganizationFeatureKey,
  ): boolean;
  requireOrganizationFeature(
    organizationId: string,
    feature: OrganizationFeatureKey,
  ): void;
}

export class OrganizationFeatureDeniedError extends Error {
  readonly code = 'organization_feature_disabled';

  constructor(
    readonly organizationId: string,
    readonly feature: OrganizationFeatureKey,
  ) {
    super(`功能未启用或未获授权: ${feature}`);
    this.name = 'OrganizationFeatureDeniedError';
  }
}

function resolveEntitlements(
  isLicenseUsable: (feature: OrganizationFeatureKey) => boolean,
): OrganizationFeatures {
  const entitled = {} as OrganizationFeatures;
  for (const feature of ORGANIZATION_FEATURE_KEYS) {
    try {
      entitled[feature] = isLicenseUsable(feature) === true;
    } catch {
      entitled[feature] = false;
    }
  }
  return entitled;
}

function resolveFeatureState(
  configured: OrganizationFeatures,
  isLicenseUsable: (feature: OrganizationFeatureKey) => boolean,
): OrganizationFeatureState {
  const entitled = resolveEntitlements(isLicenseUsable);
  const effective = {} as OrganizationFeatures;
  for (const feature of ORGANIZATION_FEATURE_KEYS) {
    effective[feature] = configured[feature] === true && entitled[feature] === true;
  }
  return { configured: { ...configured }, entitled, effective };
}

export function createOrganizationFeatureAccessFacade(
  dependencies: OrganizationFeatureAccessDependencies,
): OrganizationFeatureAccessFacade {
  const featureState = (organizationId: string): OrganizationFeatureState =>
    resolveFeatureState(
      dependencies.configuration.getConfiguredOrganizationFeatures(organizationId),
      dependencies.isLicenseUsable,
    );
  const effectiveFeatures = (organizationId: string): OrganizationFeatures =>
    featureState(organizationId).effective;

  return {
    getConfiguredOrganizationFeatures: (organizationId) =>
      dependencies.configuration.getConfiguredOrganizationFeatures(
        organizationId,
      ),
    getOrganizationFeatures: effectiveFeatures,
    getOrganizationFeatureState: featureState,
    updateOrganizationFeatures(organizationId, patch) {
      const configured =
        dependencies.configuration.updateConfiguredOrganizationFeatures(
          organizationId,
          patch,
        );
      return resolveFeatureState(configured, dependencies.isLicenseUsable).effective;
    },
    isOrganizationFeatureEnabled(organizationId, feature) {
      return effectiveFeatures(organizationId)[feature] === true;
    },
    requireOrganizationFeature(organizationId, feature) {
      if (!effectiveFeatures(organizationId)[feature]) {
        throw new OrganizationFeatureDeniedError(organizationId, feature);
      }
    },
  };
}
