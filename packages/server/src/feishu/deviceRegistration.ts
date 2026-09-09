/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { randomBytes } from 'node:crypto';
import { registerApp as sdkRegisterApp } from '@larksuiteoapi/node-sdk';
import type { FeishuCredentials } from './vendor/credentials.js';
import type { FeishuDeviceRegistrationPublic } from '../protocol.js';

type RegisterApp = typeof sdkRegisterApp;
const TERMINAL = new Set(['connected', 'denied', 'expired', 'failed', 'cancelled']);

export interface FeishuDeviceRegistrationManagerOptions {
  registerApp?: RegisterApp;
  onAuthorized: (credentials: FeishuCredentials, assertActive: () => void) => Promise<void>;
  now?: () => number;
  randomId?: () => string;
  qrReadyTimeoutMs?: number;
}

interface RegistrationState extends FeishuDeviceRegistrationPublic {
  controller: AbortController;
  isCurrentIdentity: () => boolean;
}

function publicState(state: RegistrationState): FeishuDeviceRegistrationPublic {
  const { controller: _controller, isCurrentIdentity: _isCurrentIdentity, ...result } = state;
  return { ...result };
}

/**
 * Owns the official Feishu/Lark device-registration lifecycle. Secrets never
 * enter public state; only the host callback receives and persists them.
 */
export class FeishuDeviceRegistrationManager {
  private readonly registrations = new Map<string, RegistrationState>();
  private readonly registerApp: RegisterApp;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly qrReadyTimeoutMs: number;

  constructor(private readonly options: FeishuDeviceRegistrationManagerOptions) {
    this.registerApp = options.registerApp ?? sdkRegisterApp;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomBytes(12).toString('hex'));
    this.qrReadyTimeoutMs = options.qrReadyTimeoutMs ?? 15_000;
  }

  async begin(domain: 'feishu' | 'lark', isCurrentIdentity: () => boolean = () => true): Promise<FeishuDeviceRegistrationPublic> {
    // Keep the UI's retry history bounded and supersede any unfinished scan.
    for (const id of this.registrations.keys()) this.cancel(id);
    while (this.registrations.size >= 16) {
      this.registrations.delete(this.registrations.keys().next().value!);
    }
    const registrationId = `fdr_${this.randomId()}`;
    if (!/^fdr_[a-f0-9]{24}$/u.test(registrationId)) {
      throw new Error('invalid Feishu registration id');
    }
    const controller = new AbortController();
    const state: RegistrationState = {
      registrationId,
      domain,
      status: 'starting',
      expiresAtMs: this.now() + 10 * 60_000,
      pollAfterMs: 2_000,
      controller,
      isCurrentIdentity,
    };
    this.registrations.set(registrationId, state);

    let resolveQr!: () => void;
    let rejectQr!: (error: Error) => void;
    const qrReady = new Promise<void>((resolve, reject) => {
      resolveQr = resolve;
      rejectQr = reject;
    });
    controller.signal.addEventListener('abort', () => {
      rejectQr(new Error('飞书扫码授权已取消或过期。'));
    }, { once: true });
    const timer = setTimeout(
      () => rejectQr(new Error('飞书二维码生成超时，请重试。')),
      this.qrReadyTimeoutMs,
    );
    timer.unref?.();

    void this.registerApp({
      domain: domain === 'feishu' ? 'accounts.feishu.cn' : 'accounts.larksuite.com',
      larkDomain: 'accounts.larksuite.com',
      source: 'otto-desktop',
      signal: controller.signal,
      createOnly: true,
      appPreset: {
        name: 'Otto · {user}',
        desc: '在飞书中安全控制自己的 Otto 桌面助理',
      },
      addons: {
        preset: false,
        scopes: {
          tenant: [
            'im:message:send_as_bot',
            'im:message.p2p_msg:readonly',
            'im:message.group_at_msg:readonly',
            'contact:user.base:readonly',
          ],
        },
        events: { items: { tenant: ['im.message.receive_v1'] } },
      },
      onQRCodeReady: ({ url, expireIn }) => {
        if (!this.isActive(state)) return;
        clearTimeout(timer);
        state.qrUrl = url;
        state.expiresAtMs = this.now() + Math.max(30, expireIn) * 1_000;
        state.status = 'waiting_scan';
        resolveQr();
      },
      onStatusChange: ({ status, interval }) => {
        if (!this.isActive(state)) return;
        if (status === 'slow_down') state.status = 'slow_down';
        else if (status === 'domain_switched') state.status = 'domain_switched';
        else if (state.status === 'starting') state.status = 'waiting_scan';
        if (interval !== undefined) {
          state.pollAfterMs = Math.min(30_000, Math.max(1_000, interval * 1_000));
        }
      },
    }).then(async (result) => {
      if (!this.isActive(state)) return;
      const appId = result.client_id?.trim();
      const appSecret = result.client_secret?.trim();
      const ownerOpenId = result.user_info?.open_id?.trim();
      if (!appId || !appSecret || !ownerOpenId) {
        throw new Error('飞书授权结果缺少应用凭证或扫码用户身份。');
      }
      await this.options.onAuthorized({
        appId,
        appSecret,
        domain: result.user_info?.tenant_brand === 'lark' ? 'lark' : domain,
        ownerOpenId,
      }, () => {
        if (!this.isActive(state)) throw new Error('飞书扫码授权已取消或过期。');
      });
      if (!this.isActive(state)) return;
      state.status = 'connected';
      state.ownerOpenId = ownerOpenId;
      delete state.qrUrl;
    }).catch((error: unknown) => {
      if (TERMINAL.has(state.status)) return;
      if (controller.signal.aborted) {
        state.status = 'cancelled';
      } else {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : '';
        state.status = code === 'access_denied'
          ? 'denied'
          : code === 'expired_token'
            ? 'expired'
            : 'failed';
        state.error = '飞书扫码授权失败，请重新扫码。';
      }
      delete state.qrUrl;
      rejectQr(new Error('飞书扫码授权失败，请重新扫码。'));
    }).finally(() => clearTimeout(timer));

    try {
      await qrReady;
      return publicState(state);
    } catch (error) {
      controller.abort();
      this.registrations.delete(registrationId);
      throw error;
    }
  }

  get(registrationId: string): FeishuDeviceRegistrationPublic | null {
    const state = this.registrations.get(registrationId);
    if (state) this.isActive(state);
    return state ? publicState(state) : null;
  }

  private isActive(state: RegistrationState): boolean {
    if (TERMINAL.has(state.status) || state.controller.signal.aborted) return false;
    if (!state.isCurrentIdentity()) {
      state.status = 'cancelled';
      delete state.qrUrl;
      state.controller.abort();
      return false;
    }
    if (this.now() < state.expiresAtMs) return true;
    state.status = 'expired';
    delete state.qrUrl;
    state.controller.abort();
    return false;
  }

  cancel(registrationId: string): FeishuDeviceRegistrationPublic | null {
    const state = this.registrations.get(registrationId);
    if (!state) return null;
    if (this.isActive(state)) {
      state.status = 'cancelled';
      delete state.qrUrl;
      state.controller.abort();
    }
    return publicState(state);
  }

  stopAll(): void {
    for (const id of this.registrations.keys()) this.cancel(id);
    this.registrations.clear();
  }
}
