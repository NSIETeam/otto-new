/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { OrganizationFeatureKey } from '../../productModules.js';

/**
 * Deployment grants are an explicit operator policy for this server. They do
 * not replace License verification: a usable signed deployment License is
 * still required before any grant can take effect.
 */
export const DEPLOYMENT_GRANTABLE_ENTERPRISE_FEATURES = [
  'enterprise_tree',
  'park_service',
  'feishu_auto_reply',
  'direct_messages',
  'atoa',
  'knowledge',
  'skill_market',
] as const satisfies readonly OrganizationFeatureKey[];

const GRANTABLE = new Set<OrganizationFeatureKey>(
  DEPLOYMENT_GRANTABLE_ENTERPRISE_FEATURES,
);

export function parseDeploymentFeatureGrants(
  raw: string | undefined,
): readonly OrganizationFeatureKey[] {
  if (!raw?.trim()) return [];
  const features = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = features.filter(
    (feature) => !GRANTABLE.has(feature as OrganizationFeatureKey),
  );
  if (invalid.length > 0) {
    throw new Error(
      `OTTO_ENTERPRISE_DEPLOYMENT_GRANTS contains unsupported features: ${[
        ...new Set(invalid),
      ].join(', ')}`,
    );
  }
  return [
    ...new Set(features as OrganizationFeatureKey[]),
  ];
}
