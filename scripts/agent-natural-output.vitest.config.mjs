/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import semantic from './agent-semantic-evidence.vitest.config.mjs';
export default {
  ...semantic,
  test: {
    ...semantic.test,
    include: [
      ...semantic.test.include,
      'packages/server/src/turnPresentation.test.ts',
      'packages/server/src/turnControlPolicy.test.ts',
    ],
  },
};
