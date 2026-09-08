/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { defineConfig } from 'vitest/config';
import base from './agent-baseline.vitest.config.mjs';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'scripts/tests/enterprise-upgrade-preservation.test.js',
      'packages/server/src/enterprise/server.test.ts',
      'packages/server/src/modules/commercial_control/deploymentFeatureGrants.test.ts',
      'packages/server/src/modules/commercial_control/deploymentRepository.test.ts',
      'packages/server/src/enterprise/db.upgrade-1.9.13.test.ts',
    ],
  },
});
