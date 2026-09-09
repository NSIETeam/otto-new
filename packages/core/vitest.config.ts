/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { configDefaults, defineConfig } from 'vitest/config';
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
    maxWorkers: 2,
    // Preserve Vitest 3 discovery, including .spec and JS tests. Vitest 4 only
    // excludes node_modules/.git by default, so retain its former generic rules.
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
    maxConcurrency: 5, // 每个进程内最大并发测试数
    outputFile: {
      junit: 'junit.xml',
    },
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage',
      // Vitest 4 instruments the explicit include set; do not parse bundled
      // Markdown/HTML templates as JavaScript. All source extensions remain.
      include: ['src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'],
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
