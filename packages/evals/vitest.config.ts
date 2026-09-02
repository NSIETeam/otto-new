import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export default defineConfig({
  root: workspaceRoot,
  test: {
    include: ['packages/evals/src/**/*.scenario.test.ts'],
    setupFiles: ['scripts/tests/test-setup.ts'],
    reporters: ['default', 'junit'],
    outputFile: {
      junit: path.join(workspaceRoot, 'packages/evals/artifacts/junit.xml'),
    },
  },
});
