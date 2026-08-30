/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const workflowSource = fileURLToPath(
  new URL('../workflow/src/index.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      // The workspace package's runtime entry is generated under dist/. Core
      // tests must exercise the source from the same checkout instead of a
      // possibly stale local build left by an earlier branch or merge.
      'otto-workflow': workflowSource,
    },
  },
  test: {
    reporters: ['default', 'junit'],
    silent: true,
    setupFiles: ['../../scripts/tests/test-setup.ts'],
    // 性能优化：限制并发和资源使用
    pool: 'forks', // 使用 forks 池，比 threads 更稳定且内存隔离更好
    poolOptions: {
      forks: {
        maxForks: 2, // 最大并发进程数（可根据你的 CPU 核心数调整，建议 2-4）
        minForks: 1, // 最小进程数
      },
    },
    maxConcurrency: 5, // 每个进程内最大并发测试数
    outputFile: {
      junit: 'junit.xml',
    },
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*'],
      reporter: [
        ['text', { file: 'full-text-summary.txt' }],
        'html',
        'json',
        'lcov',
        'cobertura',
        ['json-summary', { outputFile: 'coverage-summary.json' }],
      ],
    },
  },
});
