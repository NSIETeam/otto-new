/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import baseline from './agent-baseline.vitest.config.mjs';
export default {
  ...baseline,
  test: {
    ...baseline.test,
    setupFiles: [],
    include: ['packages/evals/src/realTasks/**/*.scenario.test.ts'],
    testTimeout: 90000,
    hookTimeout: 60000,
  },
};
