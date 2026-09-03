/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Provider-owned QR onboarding adapters. The request sequences mirror the
 * official WeCom CLI 1.1.1 and DingTalk connector 0.8.25, but never execute
 * either installer (both installers mutate OpenClaw configuration).
 */

import { createHash } from 'node:crypto';
import type { ChannelBrokerPairingRegistration } from './channelConnector.js';
import type {
  ChannelPairingBrokerStatus,
  ChannelPairingBrokerV1,
  ChannelPairingRegistrationResult,
} from './managedChannelConnector.js';

const PAIRING_ID = /^pair_[a-f0-9]{24}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface BrokerOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('official channel endpoint must use HTTPS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(target, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`official channel request failed (${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('official channel response body is missing');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('official channel response is too large');
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('official channel response is invalid');
    }
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function officialAuthorizationUrl(value: unknown, hostname: string): string {
  const raw = string(value);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== hostname || url.username || url.password) {
    throw new Error('provider returned an invalid authorization URL');
  }
  return url.toString();
}

function opaqueTenantId(provider: string, credentialId: string): string {
  return `${provider}:${createHash('sha256').update(credentialId, 'utf8').digest('hex').slice(0, 24)}`;
}

interface PendingWeCom { scode: string; requestedScopes: readonly string[] }

export class WeComOfficialQrPairingBrokerV1 implements ChannelPairingBrokerV1 {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingWeCom>();
  private readonly platformCode: number;

  constructor(options: BrokerOptions & { platform?: NodeJS.Platform } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    const platform = options.platform ?? process.platform;
    this.platformCode = platform === 'darwin' ? 1 : platform === 'win32' ? 2 : platform === 'linux' ? 3 : 0;
  }

  async register(registration: ChannelBrokerPairingRegistration): Promise<ChannelPairingRegistrationResult> {
    if (registration.provider !== 'wecom') throw new Error('WeCom broker provider mismatch');
    const response = await requestJson(
      this.fetchImpl,
      `https://work.weixin.qq.com/ai/qc/generate?source=wecom-cli&plat=${this.platformCode}`,
      { method: 'GET' },
      this.timeoutMs,
    );
    const data = object(response.data);
    const scode = string(data.scode);
    if (!scode || scode.length > 512) throw new Error('WeCom QR response is missing scode');
    const qrPayload = officialAuthorizationUrl(data.auth_url, 'work.weixin.qq.com');
    this.pending.set(registration.pairingId, {
      scode,
      requestedScopes: [...registration.requestedScopes],
    });
    return { qrPayload, pollAfterMs: 3_000 };
  }

  async poll(pairingId: string): Promise<ChannelPairingBrokerStatus> {
    if (!PAIRING_ID.test(pairingId)) throw new Error('invalid channel pairing id');
    const pending = this.pending.get(pairingId);
    if (!pending) throw new Error('WeCom QR registration was not found');
    const response = await requestJson(
      this.fetchImpl,
      `https://work.weixin.qq.com/ai/qc/query_result?scode=${encodeURIComponent(pending.scode)}`,
      { method: 'GET' },
      this.timeoutMs,
    );
    const data = object(response.data);
    const status = string(data.status).toLowerCase();
    if (status !== 'success') return { status: 'waiting', pollAfterMs: 3_000 };
    const bot = object(data.bot_info);
    const botId = string(bot.botid);
    const secret = string(bot.secret);
    if (!botId || !secret) throw new Error('WeCom authorization result is missing credentials');
    this.pending.delete(pairingId);
    return {
      status: 'authorized',
      authorization: {
        tenantId: string(bot.corpid) || opaqueTenantId('wecom', botId),
        tenantName: string(bot.corpname) || '企业微信',
        botName: string(bot.botname) || 'ClawMaster',
        ...(string(bot.userid) ? { providerUserId: string(bot.userid) } : {}),
        grantedScopes: [...pending.requestedScopes],
      },
      plaintextCredential: JSON.stringify({ kind: 'wecom-aibot-v1', botId, secret }),
      pollAfterMs: 3_000,
    };
  }

  cancel(pairingId: string): Promise<void> {
    this.pending.delete(pairingId);
    return Promise.resolve();
  }
}

interface PendingDingTalk { deviceCode: string; requestedScopes: readonly string[]; pollAfterMs: number }

export class DingTalkOfficialQrPairingBrokerV1 implements ChannelPairingBrokerV1 {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingDingTalk>();

  constructor(options: BrokerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async register(registration: ChannelBrokerPairingRegistration): Promise<ChannelPairingRegistrationResult> {
    if (registration.provider !== 'dingtalk') throw new Error('DingTalk broker provider mismatch');
    const init = await this.post('/app/registration/init', { source: 'DING_DWS_CLAW' });
    this.assertOk(init, 'DingTalk registration init');
    const nonce = string(init.nonce);
    if (!nonce || nonce.length > 512) throw new Error('DingTalk registration nonce is missing');
    const begun = await this.post('/app/registration/begin', { nonce });
    this.assertOk(begun, 'DingTalk registration begin');
    const deviceCode = string(begun.device_code);
    if (!deviceCode || deviceCode.length > 2_048) throw new Error('DingTalk device code is missing');
    const qrPayload = officialAuthorizationUrl(
      begun.verification_uri_complete,
      'open-dev.dingtalk.com',
    );
    const intervalSeconds = Number(begun.interval ?? 3);
    const pollAfterMs = Number.isFinite(intervalSeconds)
      ? Math.min(30_000, Math.max(1_000, Math.round(intervalSeconds * 1_000)))
      : 3_000;
    this.pending.set(registration.pairingId, {
      deviceCode,
      requestedScopes: [...registration.requestedScopes],
      pollAfterMs,
    });
    return { qrPayload, pollAfterMs };
  }

  async poll(pairingId: string): Promise<ChannelPairingBrokerStatus> {
    if (!PAIRING_ID.test(pairingId)) throw new Error('invalid channel pairing id');
    const pending = this.pending.get(pairingId);
    if (!pending) throw new Error('DingTalk QR registration was not found');
    const response = await this.post('/app/registration/poll', { device_code: pending.deviceCode });
    this.assertOk(response, 'DingTalk registration poll');
    const status = string(response.status).toUpperCase();
    if (status === 'FAIL' || status === 'EXPIRED') {
      this.pending.delete(pairingId);
      return { status: 'denied', reason: string(response.fail_reason) || 'DingTalk authorization ended' };
    }
    if (status !== 'SUCCESS') return { status: 'waiting', pollAfterMs: pending.pollAfterMs };
    const clientId = string(response.client_id);
    const clientSecret = string(response.client_secret);
    if (!clientId || !clientSecret) throw new Error('DingTalk authorization result is missing credentials');
    this.pending.delete(pairingId);
    return {
      status: 'authorized',
      authorization: {
        tenantId: opaqueTenantId('dingtalk', clientId),
        tenantName: '钉钉',
        botName: 'ClawMaster',
        grantedScopes: [...pending.requestedScopes],
      },
      plaintextCredential: JSON.stringify({ kind: 'dingtalk-stream-v1', clientId, clientSecret }),
      pollAfterMs: pending.pollAfterMs,
    };
  }

  cancel(pairingId: string): Promise<void> {
    this.pending.delete(pairingId);
    return Promise.resolve();
  }

  private post(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    return requestJson(this.fetchImpl, `https://oapi.dingtalk.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, this.timeoutMs);
  }

  private assertOk(response: Record<string, unknown>, action: string): void {
    if (Number(response.errcode) !== 0) {
      throw new Error(`${action} failed: ${string(response.errmsg) || 'unknown error'}`);
    }
  }
}
