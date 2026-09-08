/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import delivery from './agent-delivery-evidence.vitest.config.mjs';
export default {
  ...delivery,
  test: {
    ...delivery.test,
    include: [
      ...delivery.test.include,
      'packages/server/src/taskContinuity.test.ts',
      'packages/server/src/turnRecoveryStore.test.ts',
      'packages/server/src/taskContinuity.evidence.test.ts',
      'packages/server/src/runtime.continuity.test.ts',
      'packages/server/src/protocol.steering.test.ts',
      'packages/server/src/server.steering.test.ts',
      'packages/server/src/server.test.ts',
    ],
  },
};
