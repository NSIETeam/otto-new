/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node', maxWorkers: 1, fileParallelism: false,
    include: ['packages/desktop/src/main/enterprise-crypto-migration.test.ts'],
  },
});
