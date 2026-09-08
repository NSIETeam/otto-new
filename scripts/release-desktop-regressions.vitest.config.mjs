/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import base from './agent-baseline.vitest.config.mjs';
export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'scripts/tests/release-mode.test.js',
      'packages/desktop/scripts/packaging-contract.test.mjs',
      'packages/desktop/scripts/verify-packaged-content.test.mjs',
      'packages/desktop/scripts/installer-size-budget.test.mjs',
      'packages/desktop/scripts/make-latest-json.test.mjs',
      'packages/desktop/scripts/verify-update-manifest.test.mjs',
      'packages/desktop/scripts/update-mirror-config.test.mjs',
      'packages/desktop/src/main/update-sources.test.ts',
    ],
  },
};
