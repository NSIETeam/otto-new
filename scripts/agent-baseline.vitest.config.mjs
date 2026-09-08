/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Exact aliases prevent shared dependency-directory workspace links from loading
// another checkout's stale dist. This profile intentionally has no generated JS.
const aliases = [
  ['otto-core/recurring-tasks', 'packages/core/src/recurringTasks.ts'],
  ['otto-core', 'packages/core/src/index.ts'],
  ['otto-server', 'packages/server/src/index.ts'],
  ['otto-workflow', 'packages/workflow/src/index.ts'],
  ['otto-rpa', 'packages/rpa/src/index.ts'],
  ['@otto/native', 'otto-native/src/index.ts'],
].map(([name, file]) => ({
  find: new RegExp(`^${name}$`),
  replacement: path.join(root, file),
}));
export default defineConfig({
  root,
  cacheDir: path.join(process.env.OTTO_BASELINE_OUTPUT ?? root, 'vite-cache'),
  resolve: { alias: aliases },
  test: {
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ['scripts/tests/test-setup.ts'],
    include: [
      'packages/server/src/taskRequirements.test.ts',
      'packages/server/src/agentTurnTracker.completion.test.ts',
      'packages/server/src/adaptiveExecution.test.ts',
      'packages/server/src/taskGraph.test.ts',
      'packages/server/src/deliveryRepair.test.ts',
      'packages/core/src/services/compressionInvariants.test.ts',
      'packages/evals/src/feedbackBaseline.scenario.test.ts',
      'packages/evals/src/live-metrics.scenario.test.ts',
      'packages/evals/src/live-harness-smoke.scenario.test.ts',
    ],
  },
});
