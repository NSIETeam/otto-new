/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import continuity from './agent-continuity.vitest.config.mjs';
export default {
  ...continuity,
  test: {
    ...continuity.test,
    include: [
      ...continuity.test.include,
      'packages/server/src/deliveryRepair.strategies.test.ts',
      'packages/server/src/adaptiveExecution.strategies.test.ts',
      'packages/server/src/adaptiveExecution.recovery.test.ts',
      'packages/server/src/verificationEvidence.test.ts',
      'scripts/tests/agent-eval-baseline.test.js',
    ],
  },
};
