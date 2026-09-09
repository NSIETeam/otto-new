/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import base from './agent-baseline.vitest.config.mjs';
export default {
  ...base,
  test: {
    ...base.test,
    // Real profile/audit files must not inherit the unit setup's fs append mock.
    setupFiles: [],
    include: [
      'packages/core/src/utils/paths.test.ts',
      'packages/core/src/utils/userDirectoryIsolation.test.ts',
      'packages/core/src/skills/skill-loader.test.ts',
      'packages/core/src/orchestration/autoSkillGenerator.test.ts',
      'packages/server/src/userDataRoot.test.ts',
      'packages/server/src/endpoint.test.ts',
      'packages/server/src/customModels.test.ts',
      'packages/server/src/userSettings.test.ts',
      'packages/server/src/chatFileCache.test.ts',
      'packages/server/src/enterprise/server.test.ts',
      'packages/desktop/src/main/enterprise-server-url.test.ts',
      'packages/desktop/src/main/enterprise-client.test.ts',
    ],
  },
};
