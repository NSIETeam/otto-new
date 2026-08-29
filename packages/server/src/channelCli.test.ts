/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { runChannelCli } from './channelCli.js';

const endpoint = {
  host: '127.0.0.1',
  port: 7637,
  protocolVersion: '1',
  pid: 1,
  startedAt: 1,
  clientToken: 'client',
  controlToken: 'control-secret',
};
const installation = {
  installationId: 'channel_lark_0123456789abcdef01234567',
  provider: 'lark',
  tenantId: 'tenant-1',
  tenantName: 'Acme',
  botName: 'Otto',
  grantedScopes: ['im:message'],
  connectedAtMs: 1,
};

function json(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, error: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runChannelCli', () => {
  it('logs in through QR polling and proves device possession before installation', async () => {
    const output: string[] = [];
    const pairingId = 'pair_0123456789abcdef01234567';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({
        pairingId,
        provider: 'wecom',
        status: 'waiting_scan',
        qrPayload: 'https://connect.otto.example/channel/pair?opaque',
        expiresAtMs: 10_000,
        requestedScopes: ['message.send'],
      }))
      .mockResolvedValueOnce(json({
        pairingId,
        provider: 'wecom',
        status: 'user_authorized',
        qrPayload: '',
        expiresAtMs: 10_000,
        requestedScopes: ['message.send'],
        tenantName: 'Acme',
      }))
      .mockResolvedValueOnce(json({
        ...installation,
        installationId: 'channel_wecom_0123456789abcdef01234567',
        provider: 'wecom',
      }));

    expect(await runChannelCli('wecom', ['login'], {
      readEndpointRecord: () => endpoint,
      fetchImpl,
      now: () => 1,
      sleep: async () => undefined,
      stdout: (text) => output.push(text),
    })).toBe(0);
    expect(output[0]).toContain('请扫码授权 https://connect.otto.example');
    expect(output[1]).toBe('wecom: 已安装 Acme / Otto');
    const installCall = fetchImpl.mock.calls[2];
    expect(installCall[0]).toContain(`/channels/pairings/${pairingId}/install`);
    const body = JSON.parse(String(installCall[1]?.body)) as {
      installationPublicKey: string;
      signature: string;
    };
    expect(body.installationPublicKey).toContain('BEGIN PUBLIC KEY');
    expect(Buffer.from(body.signature, 'base64url')).toHaveLength(64);
  });

  it('uses the authenticated shared supervisor for status and stop', async () => {
    const output: string[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([installation]))
      .mockResolvedValueOnce(json({
        installationId: installation.installationId,
        running: true,
        state: 'connected',
        reconnectCount: 2,
      }))
      .mockResolvedValueOnce(json([installation]))
      .mockResolvedValueOnce(json({
        installationId: installation.installationId,
        running: false,
        state: 'stopped',
        reconnectCount: 2,
      }));
    const dependencies = {
      readEndpointRecord: () => endpoint,
      fetchImpl,
      stdout: (text: string) => output.push(text),
    };

    await expect(runChannelCli('lark', ['status'], dependencies)).resolves.toBe(0);
    await expect(runChannelCli('lark', ['stop'], dependencies)).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `http://127.0.0.1:7637/channels/installations/${installation.installationId}/health`,
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer control-secret' },
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      `http://127.0.0.1:7637/channels/installations/${installation.installationId}/stop`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(output).toEqual([
      'lark: connected (running) reconnects=2',
      'lark: stopped (stopped) reconnects=2',
    ]);
  });

  it('requires an explicit id for multiple tenants and never reads credentials', async () => {
    const errors: string[] = [];
    const second = {
      ...installation,
      installationId: 'channel_lark_abcdef0123456789abcdef01',
      tenantId: 'tenant-2',
    };
    const fetchImpl = vi.fn(async () => json([installation, second]));
    expect(await runChannelCli('lark', ['stop'], {
      readEndpointRecord: () => endpoint,
      fetchImpl,
      stderr: (text) => errors.push(text),
    })).toBe(2);
    expect(errors[0]).toContain('多个安装');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends through the shared idempotent write path', async () => {
    const output: string[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([installation]))
      .mockResolvedValueOnce(json({
        idempotencyKey: 'msg:0123456789abcdef',
        providerMessageId: 'om_message_1',
        committedAtMs: 1,
      }));
    const result = await runChannelCli('lark', [
      'send',
      installation.installationId,
      'chat-1',
      'long task completed',
      'msg:0123456789abcdef',
    ], {
      readEndpointRecord: () => endpoint,
      fetchImpl,
      stdout: (text) => output.push(text),
    });
    expect(result).toBe(0);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      target: 'chat-1',
      text: 'long task completed',
      idempotencyKey: 'msg:0123456789abcdef',
    });
    expect(output[0]).toContain('committed providerMessageId=om_message_1');
  });

  it('rejects missing control tokens and non-loopback endpoint records', async () => {
    const errors: string[] = [];
    expect(await runChannelCli('wecom', ['status'], {
      readEndpointRecord: () => ({ ...endpoint, controlToken: undefined }),
      stderr: (text) => errors.push(text),
    })).toBe(2);
    expect(await runChannelCli('wecom', ['status'], {
      readEndpointRecord: () => ({ ...endpoint, host: 'server.example.com' }),
      stderr: (text) => errors.push(text),
    })).toBe(2);
    expect(errors.join('\n')).toContain('控制令牌');
    expect(errors.join('\n')).toContain('非回环');
  });

  it('lists, binds and revokes identities through the same local control API', async () => {
    const output: string[] = [];
    const active = {
      provider: 'lark', installationId: installation.installationId, tenantId: 'tenant-1',
      providerUserId: 'ou_user_1', canonicalUserId: 'otto-user-1', active: true,
      revision: 1, approvalId: 'approval-1', approvedBy: 'admin-1',
      boundAtMs: 1, updatedAtMs: 1,
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json([installation])).mockResolvedValueOnce(json([active]))
      .mockResolvedValueOnce(json([installation])).mockResolvedValueOnce(json(active))
      .mockResolvedValueOnce(json([installation])).mockResolvedValueOnce(json({
        ...active, active: false, revision: 2, approvalId: 'approval-2',
      }));
    const dependencies = {
      readEndpointRecord: () => endpoint,
      fetchImpl,
      stdout: (text: string) => output.push(text),
    };
    await expect(runChannelCli('lark', ['identities', installation.installationId], dependencies))
      .resolves.toBe(0);
    await expect(runChannelCli('lark', [
      'bind-user', installation.installationId, 'ou_user_1', 'otto-user-1',
      'approval-1', 'admin-1', '0',
    ], dependencies)).resolves.toBe(0);
    await expect(runChannelCli('lark', [
      'revoke-user', installation.installationId, 'ou_user_1',
      'approval-2', 'admin-1', '1',
    ], dependencies)).resolves.toBe(0);
    expect(JSON.parse(String(fetchImpl.mock.calls[3][1]?.body))).toEqual({
      action: 'bind', providerUserId: 'ou_user_1', canonicalUserId: 'otto-user-1',
      approvalId: 'approval-1', approvedBy: 'admin-1', expectedRevision: 0,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[5][1]?.body))).toEqual({
      action: 'revoke', providerUserId: 'ou_user_1',
      approvalId: 'approval-2', approvedBy: 'admin-1', expectedRevision: 1,
    });
    expect(output.join('\n')).toContain('ou_user_1\totto-user-1\tactive\trevision=1');
    expect(output.join('\n')).toContain('已撤销 ou_user_1 -> otto-user-1 revision=2');
  });
});
