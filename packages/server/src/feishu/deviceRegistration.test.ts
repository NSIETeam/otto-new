/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { FeishuDeviceRegistrationManager } from './deviceRegistration.js';

describe('FeishuDeviceRegistrationManager', () => {
  it('passes a live authorization guard through delayed credential persistence', async () => {
    let release!: () => void;
    let persisted = false;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const onAuthorized = vi.fn(async (_credentials, assertActive: () => void) => {
      await paused;
      assertActive();
      persisted = true;
    });
    const manager = new FeishuDeviceRegistrationManager({
      registerApp: vi.fn(async (options) => {
        options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device', expireIn: 30 });
        return { client_id: 'cli_test', client_secret: 'secret', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' as const } };
      }),
      onAuthorized, randomId: () => '0123456789abcdef01234567',
    });
    const pairing = await manager.begin('feishu');
    await vi.waitFor(() => expect(onAuthorized).toHaveBeenCalledWith(expect.any(Object), expect.any(Function)));
    manager.cancel(pairing.registrationId);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(persisted).toBe(false);
    expect(manager.get(pairing.registrationId)).toMatchObject({ status: 'cancelled' });
  });

  it('settles begin when cancelled before the QR callback arrives', async () => {
    const manager = new FeishuDeviceRegistrationManager({
      registerApp: vi.fn((options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })),
      onAuthorized: vi.fn(), randomId: () => '0123456789abcdef01234567',
    });
    let rejected = false;
    const begun = manager.begin('feishu').catch(() => { rejected = true; });
    manager.cancel('fdr_0123456789abcdef01234567');
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejected).toBe(true);
    await begun;
  });

  it.each(['cancelled', 'expired'] as const)('ignores credentials that arrive after registration is %s', async (terminalStatus) => {
    let now = 1_000;
    let resolveAuthorization!: (value: Awaited<ReturnType<typeof import('@larksuiteoapi/node-sdk').registerApp>>) => void;
    const onAuthorized = vi.fn(async () => undefined);
    const manager = new FeishuDeviceRegistrationManager({
      registerApp: vi.fn((options) => {
        options.onQRCodeReady({ url: 'https://accounts.feishu.cn/device', expireIn: 30 });
        return new Promise((resolve) => { resolveAuthorization = resolve; });
      }),
      onAuthorized,
      randomId: () => '0123456789abcdef01234567',
      now: () => now,
    });
    const pairing = await manager.begin('feishu');
    if (terminalStatus === 'cancelled') manager.cancel(pairing.registrationId);
    else now = pairing.expiresAtMs;
    expect(manager.get(pairing.registrationId)?.status).toBe(terminalStatus);
    resolveAuthorization({
      client_id: 'cli_late', client_secret: 'late-secret',
      user_info: { open_id: 'ou_late', tenant_brand: 'feishu' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(manager.get(pairing.registrationId)).toMatchObject({ status: terminalStatus });
    expect(manager.get(pairing.registrationId)).not.toHaveProperty('qrUrl');
    manager.stopAll();
  });

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
    }), expect.any(Function)));
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
