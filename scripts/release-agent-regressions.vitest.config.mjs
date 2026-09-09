import base from './agent-baseline.vitest.config.mjs';
export default {
  ...base,
  test: {
    ...base.test,
    include: [
      'packages/server/src/turnControlPolicy.test.ts',
      'packages/server/src/turnRecoveryStore.test.ts',
      'packages/evals/src/agent-runtime-adversarial.scenario.test.ts',
      'packages/evals/src/safetyLiveness.scenario.test.ts',
      'packages/evals/src/realTasks/continuity.scenario.test.ts',
    ],
  },
};
