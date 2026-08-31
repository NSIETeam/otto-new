/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_GRANTABLE_ENTERPRISE_FEATURES,
  parseDeploymentFeatureGrants,
} from './deploymentFeatureGrants.js';

describe('deployment feature grants', () => {
  it('accepts exactly the seven enterprise features and removes duplicates', () => {
    expect(parseDeploymentFeatureGrants(
      `${DEPLOYMENT_GRANTABLE_ENTERPRISE_FEATURES.join(',')},skill_market`,
    )).toEqual(DEPLOYMENT_GRANTABLE_ENTERPRISE_FEATURES);
  });

  it.each(['model_gateway', '*', 'all', 'unknown_feature'])(
    'rejects unsupported broad grant %s',
    (feature) => {
      expect(() => parseDeploymentFeatureGrants(feature)).toThrow(
        'contains unsupported features',
      );
    },
  );

  it('returns no grants when the setting is absent', () => {
    expect(parseDeploymentFeatureGrants(undefined)).toEqual([]);
  });
});
