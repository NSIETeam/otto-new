/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
export default {
  test: {
    include: [
      'packages/evals/src/iterationReview.scenario.test.ts',
      'packages/evals/src/stage7Comparison.scenario.test.ts',
      'scripts/tests/agent-iteration.test.js',
    ],
    setupFiles: [],
    maxWorkers: 1,
    fileParallelism: false,
  },
};
