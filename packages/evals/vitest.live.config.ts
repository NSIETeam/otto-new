import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  root,
  resolve: {
    alias: [
      ['otto-core', 'packages/core/src/index.ts'],
      ['otto-server', 'packages/server/src/index.ts'],
      ['otto-workflow', 'packages/workflow/src/index.ts'],
      ['otto-rpa', 'packages/rpa/src/index.ts'],
      ['@otto/native', 'otto-native/src/index.ts'],
    ].map(([name, file]) => ({
      find: new RegExp(`^${name}$`),
      replacement: path.join(root, file),
    })),
  },
  test: {
    include: ['packages/evals/src/**/*.live.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ['default'],
  },
});
