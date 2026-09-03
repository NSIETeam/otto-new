/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { FeishuDeviceRegistrationManager } from './deviceRegistration.js';

describe('FeishuDeviceRegistrationManager', () => {
  it('keeps credentials server-side and binds the scanning user as owner', async () => {
    const onAuthorized = vi.fn(async () => undefined);
    const registerApp = vi.fn(async (options: Parameters<typeof import('@larksuiteoapi/node-sdk').registerApp>[0]) => {
      options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device?code=opaque', expireIn: 300 });
      return {
        client_id: 'cli_test', client_secret: 'secret-never-public',
        user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' as const },
      };
    });
    const manager = new FeishuDeviceRegistrationManager({
      registerApp, onAuthorized, randomId: () => '0123456789abcdef01234567', now: () => 1_000,
    });

    const pairing = await manager.begin('feishu');
    expect(pairing).toMatchObject({ status: 'waiting_scan', qrUrl: expect.stringContaining('opaque') });
    expect(JSON.stringify(pairing)).not.toContain('secret-never-public');
    await vi.waitFor(() => expect(onAuthorized).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'cli_test', appSecret: 'secret-never-public', ownerOpenId: 'ou_owner',
    })));
    const connected = manager.get(pairing.registrationId);
    expect(connected).toMatchObject({ status: 'connected', ownerOpenId: 'ou_owner' });
    expect(connected).not.toHaveProperty('qrUrl');
  });

  it('cancels polling without exposing a partial authorization', async () => {
    let signal: AbortSignal | undefined;
    const manager = new FeishuDeviceRegistrationManager({
      registerApp: vi.fn((options) => {
        signal = options.signal;
        options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device', expireIn: 300 });
        return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'abort' }))));
      }),
      onAuthorized: vi.fn(), randomId: () => '0123456789abcdef01234567',
    });
    const pairing = await manager.begin('feishu');
    expect(manager.cancel(pairing.registrationId)).toMatchObject({ status: 'cancelled' });
    expect(signal?.aborted).toBe(true);
  });
});
