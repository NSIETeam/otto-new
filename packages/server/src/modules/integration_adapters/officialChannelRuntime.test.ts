/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ wecom: [] as Array<EventEmitter & {
  connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn>;
}> }));

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: class extends EventEmitter {
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    sendMessage = vi.fn(async () => ({ headers: { req_id: 'wecom-message-1' } }));
    constructor() { super(); sdk.wecom.push(this); }
  },
}));

vi.mock('dingtalk-stream', () => ({
  DWClient: class extends EventEmitter {},
  EventAck: { SUCCESS: 'SUCCESS', LATER: 'LATER' },
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));

import { OfficialChannelRuntimeV1 } from './officialChannelRuntime.js';

describe('OfficialChannelRuntimeV1', () => {
  beforeEach(() => sdk.wecom.splice(0));

  it('authenticates WeCom, normalizes inbound identity and sends through the official SDK', async () => {
    const onInbound = vi.fn(async () => 'ack' as const);
    const runtime = new OfficialChannelRuntimeV1({ onInbound, connectTimeoutMs: 1_000 });
    const installation = {
      installationId: 'channel_wecom_0123456789abcdef01234567', provider: 'wecom' as const,
      tenantId: 'corp-1', tenantName: 'Acme', botName: 'ClawMaster',
      grantedScopes: ['message.send'], connectedAtMs: 1,
    };
    const starting = runtime.start(installation, JSON.stringify({
      kind: 'wecom-aibot-v1', botId: 'bot-1', secret: 'secret-1',
    }));
    const client = sdk.wecom[0]!;
    client.emit('authenticated');
    await expect(starting).resolves.toMatchObject({ state: 'connected', running: true });

    client.emit('message.text', { body: {
      msgid: 'msg-1', from: { userid: 'wm-user-1' }, text: { content: '/tasks' },
      create_time: 10,
    } });
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledWith(
      installation,
      expect.objectContaining({ userId: 'wm-user-1', messageId: 'msg-1', receivedAtMs: 10_000 }),
    ));
    await expect(runtime.send(installation, JSON.stringify({
      kind: 'wecom-aibot-v1', botId: 'bot-1', secret: 'secret-1',
    }), { target: 'wm-user-1', text: 'ok', idempotencyKey: 'channel-reply:1234' }))
      .resolves.toEqual({ providerMessageId: 'wecom-message-1' });

    client.sendMessage.mockResolvedValueOnce({ headers: {} });
    await expect(runtime.send(installation, JSON.stringify({
      kind: 'wecom-aibot-v1', botId: 'bot-1', secret: 'secret-1',
    }), { target: 'wm-user-1', text: 'no receipt', idempotencyKey: 'channel-reply:5678' }))
      .rejects.toThrow('durable message receipt');
  });

  it('rejects provider-mismatched credentials before opening a connection', async () => {
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold' });
    await expect(runtime.start({
      installationId: 'channel_dingtalk_0123456789abcdef01234567', provider: 'dingtalk',
      tenantId: 'tenant', tenantName: 'DingTalk', botName: 'ClawMaster',
      grantedScopes: ['im:message'], connectedAtMs: 1,
    }, JSON.stringify({ kind: 'wecom-aibot-v1', botId: 'bot', secret: 'secret' })))
      .rejects.toThrow('provider mismatch');
  });
});
