/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node', maxWorkers: 1, fileParallelism: false,
    include: [
      'packages/desktop/src/main/enterprise-crypto-migration.test.ts',
      'packages/desktop/src/main/enterprise-e2ee.test.ts',
      'packages/desktop/src/main/enterprise-client.test.ts',
      'packages/desktop/src/main/enterprise-mls.test.ts',
      'packages/desktop/src/main/enterprise-mls-private-messages.test.ts',
      'packages/desktop/src/main/park-market-mls.test.ts',
      'packages/desktop/src/main/enterprise-server-url.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/desktop/src/main/enterprise-e2ee.ts', 'packages/desktop/src/main/enterprise-server-url.ts'],
      reportsDirectory: 'packages/desktop/coverage/crypto-migration',
      thresholds: { lines: 80, statements: 80, branches: 80, functions: 80 },
    },
  },
});
