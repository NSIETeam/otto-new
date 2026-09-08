/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import iteration from './agent-iteration.vitest.config.mjs';
export default {
  ...iteration,
  test: {
    ...iteration.test,
    include: [
      ...iteration.test.include,
      'packages/evals/src/testPilotReadiness.scenario.test.ts',
    ],
  },
};
