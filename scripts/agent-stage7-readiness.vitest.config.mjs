/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import natural from './agent-natural-output.vitest.config.mjs';

// Deterministic regression only. Real-model calls are never included here.
// The live-entry guard test uses its own loopback fixture and no usable key.
export default {
  ...natural,
  test: {
    ...natural.test,
    include: [
      ...natural.test.include,
      'packages/evals/src/liveEvalGate.scenario.test.ts',
      'packages/evals/src/stage7Comparison.scenario.test.ts',
      'scripts/tests/agent-live-pair.test.js',
    ],
  },
};
