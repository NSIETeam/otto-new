/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import type { ChannelBrokerPairingRegistration } from './channelConnector.js';
import {
  DingTalkOfficialQrPairingBrokerV1,
  WeComOfficialQrPairingBrokerV1,
} from './officialQrPairingBrokers.js';

const registration = (provider: 'wecom' | 'dingtalk'): ChannelBrokerPairingRegistration => ({
  pairingId: 'pair_0123456789abcdef01234567',
  provider,
  nonce: 'n'.repeat(32),
  installationPublicKey: 'public-key',
  requestedScopes: ['message.send'],
  expiresAtMs: Date.now() + 300_000,
  qrPayload: 'https://connect.invalid/pair',
});

describe('official QR pairing brokers', () => {
  it('uses the WeCom official QR flow without exposing bot credentials', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        scode: 'scan-code',
        auth_url: 'https://work.weixin.qq.com/ai/qc/gen?source=wecom-cli&scode=scan-code',
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        status: 'success',
        bot_info: { botid: 'bot-1', secret: 'secret-1', corpid: 'corp-1', corpname: 'Acme' },
      } }), { status: 200 }));
    const broker = new WeComOfficialQrPairingBrokerV1({ fetchImpl, platform: 'darwin' });

    const begun = await broker.register(registration('wecom'));
    expect(begun.qrPayload).toContain('work.weixin.qq.com/ai/qc/gen');
    expect(JSON.stringify(begun)).not.toContain('secret-1');
    const result = await broker.poll('pair_0123456789abcdef01234567');
    expect(result).toMatchObject({
      status: 'authorized',
      authorization: { tenantId: 'corp-1', tenantName: 'Acme' },
    });
    expect(JSON.parse((result as { plaintextCredential: string }).plaintextCredential)).toEqual({
      kind: 'wecom-aibot-v1', botId: 'bot-1', secret: 'secret-1',
    });
  });

  it('uses DingTalk official device registration and keeps device codes private', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, nonce: 'nonce-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0,
        device_code: 'device-secret',
        verification_uri_complete: 'https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=A-B',
        expires_in: 300,
        interval: 3,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0, status: 'SUCCESS', client_id: 'ding-client', client_secret: 'ding-secret',
      }), { status: 200 }));
    const broker = new DingTalkOfficialQrPairingBrokerV1({ fetchImpl });

    const begun = await broker.register(registration('dingtalk'));
    expect(begun.qrPayload).toContain('open-dev.dingtalk.com/openapp/registration');
    expect(JSON.stringify(begun)).not.toContain('device-secret');
    const result = await broker.poll('pair_0123456789abcdef01234567');
    expect(result.status).toBe('authorized');
    expect(JSON.parse((result as { plaintextCredential: string }).plaintextCredential)).toEqual({
      kind: 'dingtalk-stream-v1', clientId: 'ding-client', clientSecret: 'ding-secret',
    });
  });

  it('rejects an authorization URL outside the official provider host', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, nonce: 'nonce-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0,
        device_code: 'device-secret',
        verification_uri_complete: 'https://evil.example/steal',
      }), { status: 200 }));
    const broker = new DingTalkOfficialQrPairingBrokerV1({ fetchImpl });
    await expect(broker.register(registration('dingtalk'))).rejects.toThrow('authorization URL');
    await expect(broker.poll('pair_0123456789abcdef01234567')).rejects.toThrow('was not found');
  });
});
