/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import baseline from './agent-baseline.vitest.config.mjs';
export default {
  ...baseline,
  test: {
    ...baseline.test,
    setupFiles: [],
    include: [
      'packages/core/src/policy/turnExecutionGuard.test.ts',
      'packages/core/src/tools/generate-safe-document.test.ts',
      'packages/server/src/semanticAcceptance*.test.ts',
      'packages/server/src/deliveryRepair*.test.ts',
      'packages/server/src/claimEvidence*.test.ts',
      'packages/server/src/runtime.claimEvidence.test.ts',
      'packages/server/src/agentTurnTracker.completion.test.ts',
      'packages/server/src/turnConstraints*.test.ts',
      'packages/evals/src/safetyLiveness.scenario.test.ts',
    ],
  },
};
