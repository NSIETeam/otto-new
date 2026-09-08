/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import baseline from './agent-baseline.vitest.config.mjs';
export default {
  ...baseline,
  test: {
    ...baseline.test,
    setupFiles: [],
    pool: 'threads',
    include: ['packages/evals/src/realTasks/matrix.worker.test.ts'],
    testTimeout: 900000,
    hookTimeout: 60000,
  },
};
