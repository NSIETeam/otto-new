/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import repair from './agent-repair-strategies.vitest.config.mjs';
export default {
  ...repair,
  test: {
    ...repair.test,
    include: [
      ...repair.test.include,
      'packages/server/src/claimEvidence*.test.ts',
      'packages/server/src/semanticAcceptance*.test.ts',
      'packages/core/src/tools/web-fetch.test.ts',
      'packages/core/src/tools/web-fetch-security.test.ts',
      'packages/core/src/core/nonInteractiveToolExecutor.test.ts',
      'packages/core/src/tools/web-source-evidence.test.ts',
    ],
  },
};
