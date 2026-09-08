/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import constraints from './agent-constraints.vitest.config.mjs';
export default {
  ...constraints,
  test: {
    ...constraints.test,
    include: [
      ...constraints.test.include,
      'packages/server/src/deliveryEvidence.test.ts',
      'packages/server/src/artifactEvidence.test.ts',
      'packages/server/src/agentTurnTracker.test.ts',
      'packages/server/src/incompleteDelivery.test.ts',
      'packages/server/src/testCaseEvidence.test.ts',
    ],
  },
};
