/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
export default {
  test: {
    include: [
      'packages/evals/src/liveEvalGate.scenario.test.ts',
      'scripts/tests/agent-experiment-plan.test.js',
      'scripts/tests/agent-eval-baseline.test.js',
      'scripts/tests/agent-experiment-files.test.js',
      'scripts/tests/agent-live-pair.test.js',
    ],
    setupFiles: [],
    maxWorkers: 1,
    fileParallelism: false,
  },
};
