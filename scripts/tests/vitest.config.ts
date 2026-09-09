/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/tests/**/*.test.js', 'scripts/tests/**/*.contract.js'],
    setupFiles: ['scripts/tests/test-setup.ts'],
    // 性能优化：限制并发和资源使用
    pool: 'forks', // 使用 forks 池，比 threads 更稳定且内存隔离更好
    maxWorkers: 2,
    maxConcurrency: 5, // 每个进程内最大并发测试数
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
