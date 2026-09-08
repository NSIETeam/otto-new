/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import baseline from './agent-baseline.vitest.config.mjs';
export default {
  ...baseline,
  test: {
    ...baseline.test,
    include: [
      ...baseline.test.include,
      'packages/server/src/turnConstraints.test.ts',
      'packages/server/src/taskContract.test.ts',
      'packages/server/src/agentTurnTracker.contract.test.ts',
      'packages/server/src/runtime*.test.ts',
      'packages/core/src/policy/turnExecutionGuard.test.ts',
      'packages/core/src/policy/centralPolicy.test.ts',
      'packages/core/src/core/kernelBoundary.test.ts',
      'packages/core/src/core/nonInteractiveToolExecutor.test.ts',
    ],
  },
};
