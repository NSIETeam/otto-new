/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'scripts/tests/server-ip-migration.test.ts',
      'packages/desktop/src/main/enterprise-server-url.test.ts',
      'packages/desktop/src/main/enterprise-session-store.test.ts',
      'packages/desktop/src/main/update-sources.test.ts',
      'packages/desktop/src/main/update-service.test.ts',
      'packages/desktop/src/main/update-manifest-integrity.test.ts',
      'packages/desktop/scripts/update-mirror-config.test.mjs',
      'packages/desktop/scripts/make-latest-json.test.mjs',
      'packages/server/src/enterprise/publicInvite.test.ts',
      'packages/server/src/protocol.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'packages/desktop/coverage/server-ip-migration',
      include: [
        'packages/desktop/src/main/enterprise-server-url.ts',
        'packages/desktop/src/main/update-sources.ts',
        'packages/desktop/scripts/update-mirror-config.mjs',
        'packages/server/src/modules/identity_organization/publicInvite.ts',
      ],
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
