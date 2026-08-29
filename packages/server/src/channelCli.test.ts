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
});
