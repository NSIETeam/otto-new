import base from './agent-baseline.vitest.config.mjs';

export default {
  ...base,
  test: {
    ...base.test,
    // These integration tests verify real audit and credential persistence.
    // Script-suite fs mocks would suppress the append before chmod/readback.
    setupFiles: [],
    include: [
      'packages/server/src/feishu/deviceRegistration.test.ts',
      'packages/server/src/channelPairingRoutes.test.ts',
      'packages/server/src/modules/integration_adapters/*.test.ts',
    ],
  },
};
