/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChannelPairingBrokerStatus,
  ChannelPairingBrokerV1,
} from './managedChannelConnector.js';
import type { ChannelBrokerPairingRegistration } from './channelConnector.js';

export interface HttpChannelPairingBrokerOptions {
  baseUrl: string;
  /** Device-scoped broker credential; never included in errors. */
  bearerToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const PAIRING_ID_PATTERN = /^pair_[a-f0-9]{24}$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

function assertPairingId(pairingId: string): void {
  if (!PAIRING_ID_PATTERN.test(pairingId)) throw new Error('invalid channel pairing id');
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('channel pairing broker must use HTTPS');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export class HttpChannelPairingBrokerV1 implements ChannelPairingBrokerV1 {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly bearerToken: string;

  constructor(options: HttpChannelPairingBrokerOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.bearerToken = options.bearerToken.trim();
    if (!this.bearerToken) throw new Error('channel pairing broker credential is required');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error('channel pairing broker timeout is invalid');
    }
  }

  async register(registration: ChannelBrokerPairingRegistration): Promise<void> {
    assertPairingId(registration.pairingId);
    await this.request(`/v1/channel-pairings/${registration.pairingId}`, {
      method: 'PUT',
      headers: { 'idempotency-key': registration.pairingId },
      body: JSON.stringify(registration),
    });
  }

  async poll(pairingId: string): Promise<ChannelPairingBrokerStatus> {
    assertPairingId(pairingId);
    const body = await this.request(`/v1/channel-pairings/${pairingId}`, {
      method: 'GET',
    });
    if (!body || typeof body !== 'object') throw new Error('channel pairing broker returned invalid status');
    const input = body as Record<string, unknown>;
    if (input.status === 'waiting') return { status: 'waiting' };
    if (input.status === 'denied') {
      return {
        status: 'denied',
        ...(typeof input.reason === 'string' && input.reason.trim()
          ? { reason: input.reason.trim().slice(0, 500) }
          : {}),
      };
    }
    if (
      input.status !== 'authorized' ||
      typeof input.plaintextCredential !== 'string' ||
      !input.plaintextCredential ||
      typeof input.authorization !== 'object' ||
      input.authorization === null
    ) {
      throw new Error('channel pairing broker returned invalid authorization');
    }
    const authorization = input.authorization as Record<string, unknown>;
    if (
      typeof authorization.tenantId !== 'string' ||
      typeof authorization.tenantName !== 'string' ||
      typeof authorization.botName !== 'string' ||
      !Array.isArray(authorization.grantedScopes) ||
      authorization.grantedScopes.some((scope) => typeof scope !== 'string')
    ) {
      throw new Error('channel pairing broker returned invalid tenant identity');
    }
    return {
      status: 'authorized',
      plaintextCredential: input.plaintextCredential,
      authorization: {
        tenantId: authorization.tenantId,
        tenantName: authorization.tenantName,
        botName: authorization.botName,
        grantedScopes: authorization.grantedScopes as string[],
        ...(authorization.requiresAdminApproval === true
          ? { requiresAdminApproval: true }
          : {}),
      },
    };
  }

  async cancel(pairingId: string): Promise<void> {
    assertPairingId(pairingId);
    await this.request(`/v1/channel-pairings/${pairingId}`, { method: 'DELETE' });
  }

  private async request(
    requestPath: string,
    init: RequestInit,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.bearerToken}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
      });
      if (!response.ok) {
        throw new Error(`channel pairing broker request failed (${response.status})`);
      }
      if (response.status === 204) return undefined;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_RESPONSE_BYTES) {
        throw new Error('channel pairing broker response is too large');
      }
      try {
        return JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new Error('channel pairing broker returned invalid JSON');
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('channel pairing broker request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
