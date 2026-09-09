import { it, expect, vi } from 'vitest';
import { ParkMarketMls } from './park-market-mls.js';
const native = vi.hoisted(() => ({ created: 0, retired: vi.fn() }));
vi.mock('@otto/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@otto/native')>()),
  ParkMlsNativeKernel: class {
    deviceScope = 'server/org/account/device';
    async listKeyPackages() {
      return [
        {
          reference: 'expired',
          key_package: 'expired-by-native',
          publishable: false,
        },
        { reference: 'valid', key_package: 'valid', publishable: true },
      ];
    }
    async createKeyPackage() {
      return { reference: `new-${++native.created}`, key_package: 'new' };
    }
    retireKeyPackages = native.retired;
    async close() {}
  },
}));
it('does not advertise expired native key packages and preserves their keys for delayed welcomes', async () => {
  const request = vi.fn(async (_body: Record<string, unknown>) => ({
    usable: true,
  }));
  const context = {
    serverScope: 'server',
    serverUrl: 'https://test.invalid',
    organizationId: 'org',
    accountId: 'account',
    crypto: {
      localDevice: () => ({ deviceId: 'device' }),
      signParkMarketMls: () => ({ signature: 'fixture', deviceId: 'device' }),
    },
  };
  const client = new ParkMarketMls({
    directory: '/tmp/otto-market-inventory-unit',
    context: () => context as never,
    request,
    protect: (v) => v,
    unprotect: (v) => v,
  });
  await client.activate();
  expect(
    request.mock.calls.some(
      (call) =>
        (call[0] as { payload: { reference: string } }).payload.reference ===
        'expired',
    ),
  ).toBe(false);
  expect(request).toHaveBeenCalledTimes(5);
  expect(native.retired).not.toHaveBeenCalled();
  await client.close();
});
