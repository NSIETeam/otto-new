import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/evals/src/**/*.live.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    reporters: ['default'],
  },
});
