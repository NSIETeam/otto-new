/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { BrokerChannelTaskBridgeV1 } from './brokerChannelTaskBridge.js';

const installation = {
  installationId: 'channel_lark_0123456789abcdef01234567', provider: 'lark' as const,
  tenantId: 'tenant-1', tenantName: 'Acme', botName: 'Otto',
  grantedScopes: ['im:message'], connectedAtMs: 1,
};
const message = {
  messageId: 'message-1', tenantId: 'tenant-1', userId: 'provider-user-1',
  text: '/cancel task-1', receivedAtMs: 2_000,
};

describe('BrokerChannelTaskBridgeV1', () => {
  it('holds unbound identities before task control', async () => {
    const gateway = { handle: vi.fn() };
    const replies = { send: vi.fn() };
    const bridge = new BrokerChannelTaskBridgeV1(
      { resolve: vi.fn().mockResolvedValue(null) }, gateway, replies,
    );
    await expect(bridge.handle(installation, message)).resolves.toBe('hold');
    expect(gateway.handle).not.toHaveBeenCalled();
    expect(replies.send).not.toHaveBeenCalled();
  });

  it('uses the canonical bound identity and ACKs only after a visible reply', async () => {
    const gateway = { handle: vi.fn().mockResolvedValue({ ok: true, message: '任务已取消。' }) };
    const replies = { send: vi.fn().mockResolvedValue(undefined) };
    const bridge = new BrokerChannelTaskBridgeV1(
      { resolve: vi.fn().mockResolvedValue({ canonicalUserId: 'otto-user-1', active: true }) },
      gateway,
      replies,
    );
    await expect(bridge.handle(installation, message)).resolves.toBe('ack');
    expect(gateway.handle).toHaveBeenCalledWith('/cancel task-1', expect.objectContaining({
      userId: 'otto-user-1', signatureVerified: true, identityBound: true,
    }));
    expect(replies.send).toHaveBeenCalledWith(expect.objectContaining({
      target: 'provider-user-1',
      idempotencyKey: `channel-reply:lark:${installation.installationId}:message-1`,
    }));
  });

  it('holds the broker ACK when the user-visible reply is not committed', async () => {
    const bridge = new BrokerChannelTaskBridgeV1(
      { resolve: vi.fn().mockResolvedValue({ canonicalUserId: 'otto-user-1', active: true }) },
      { handle: vi.fn().mockResolvedValue({ ok: false, message: '操作结果尚未确认。' }) },
      { send: vi.fn().mockRejectedValue(new Error('broker unavailable')) },
    );
    await expect(bridge.handle(installation, message)).resolves.toBe('hold');
  });
});
