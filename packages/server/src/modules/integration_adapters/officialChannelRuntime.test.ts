/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ wecom: [] as Array<EventEmitter & {
  connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn>;
}>, dingtalk: [] as Array<EventEmitter & {
  connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>;
  registerCallbackListener: ReturnType<typeof vi.fn>; socketCallBackResponse: ReturnType<typeof vi.fn>;
  connected: boolean; getEndpoint: () => Promise<unknown>;
}>, swallowConnectFailure: false }));

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: class extends EventEmitter {
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    sendMessage = vi.fn(async () => ({ headers: { req_id: 'wecom-message-1' } }));
    constructor() { super(); sdk.wecom.push(this); }
  },
}));

vi.mock('dingtalk-stream', () => ({
  DWClient: class extends EventEmitter {
    connected = false;
    dw_url: string | undefined;
    config: Record<string, unknown>;
    getEndpoint = vi.fn(async () => this);
    connect = vi.fn(async () => {
      if (sdk.swallowConnectFailure) return;
      await this.getEndpoint();
      this.connected = true;
    });
    disconnect = vi.fn(() => { this.connected = false; });
    registerCallbackListener = vi.fn();
    socketCallBackResponse = vi.fn();
    constructor(config: Record<string, unknown>) { super(); this.config = config; sdk.dingtalk.push(this); }
  },
  EventAck: { SUCCESS: 'SUCCESS', LATER: 'LATER' },
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));

import { bindDingTalkConnectionTransport, OfficialChannelRuntimeV1 } from './officialChannelRuntime.js';

const dingInstallation = {
  installationId: 'channel_dingtalk_0123456789abcdef01234567', provider: 'dingtalk' as const,
  tenantId: 'tenant', tenantName: 'DingTalk', botName: 'Otto', grantedScopes: ['im:message'], connectedAtMs: 1,
};
const dingCredential = JSON.stringify({ kind: 'dingtalk-stream-v1', clientId: 'client', clientSecret: 'secret' });
const dingSend = { target: 'user-1', text: 'hello', idempotencyKey: 'message:0001' };
const endpointBody = { endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect', ticket: 'synthetic-ticket' };
function providerFetch() {
  return vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(
    String(url).endsWith('/connections/open') ? endpointBody
      : String(url).endsWith('/accessToken') ? { accessToken: 'synthetic-access-token' }
        : { processQueryKey: 'receipt-1' },
  )));
}

describe('OfficialChannelRuntimeV1', () => {
  beforeEach(() => { sdk.wecom.splice(0); sdk.dingtalk.splice(0); sdk.swallowConnectFailure = false; });
  afterEach(() => vi.restoreAllMocks());

  it('receives DingTalk robot CALLBACK frames and acknowledges only accepted work', async () => {
    const onInbound = vi.fn(async () => 'ack' as 'ack' | 'hold');
    const runtime = new OfficialChannelRuntimeV1({ onInbound, fetchImpl: providerFetch() });
    await runtime.start({
      installationId: 'channel_dingtalk_0123456789abcdef01234567', provider: 'dingtalk',
      tenantId: 'tenant', tenantName: 'DingTalk', botName: 'Otto',
      grantedScopes: ['im:message'], connectedAtMs: 1,
    }, JSON.stringify({ kind: 'dingtalk-stream-v1', clientId: 'client', clientSecret: 'secret' }));
    const client = sdk.dingtalk[0]!;
    expect(client.registerCallbackListener).toHaveBeenCalledWith('/v1.0/im/bot/messages/get', expect.any(Function));
    const callback = client.registerCallbackListener.mock.calls[0]![1];
    const event = { headers: { messageId: 'delivery-1' }, data: JSON.stringify({
      msgtype: 'text', msgId: 'message-1', senderStaffId: 'user-1', text: { content: '/tasks' },
    }) };
    await callback(event);
    expect(onInbound).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ userId: 'user-1', messageId: 'message-1' }));
    expect(client.socketCallBackResponse).toHaveBeenCalledWith('delivery-1', { status: 'SUCCESS' });
    onInbound.mockResolvedValueOnce('hold');
    client.socketCallBackResponse.mockClear();
    await callback(event);
    expect(client.socketCallBackResponse).not.toHaveBeenCalled();
  });

  it('disconnects a timed-out WeCom connection and ignores late callbacks', async () => {
    const onInbound = vi.fn(async () => 'ack' as const);
    const runtime = new OfficialChannelRuntimeV1({ onInbound, connectTimeoutMs: 5 });
    const installation = {
      installationId: 'channel_wecom_0123456789abcdef01234567', provider: 'wecom' as const,
      tenantId: 'tenant', tenantName: 'WeCom', botName: 'Otto', grantedScopes: [], connectedAtMs: 1,
    };
    await expect(runtime.start(installation, JSON.stringify({ kind: 'wecom-aibot-v1', botId: 'bot', secret: 'secret' })))
      .rejects.toThrow('timed out');
    const client = sdk.wecom[0]!;
    expect(client.disconnect).toHaveBeenCalledOnce();
    client.emit('authenticated');
    client.emit('message.text', { body: { msgid: 'late', from: { userid: 'user' }, text: { content: '/tasks' } } });
    expect(onInbound).not.toHaveBeenCalled();
    await expect(runtime.health(installation.installationId)).resolves.toMatchObject({ running: false, state: 'stopped' });
  });

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

  it('does not expose raw SDK error text through the public WeCom health state', async () => {
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold' });
    const installation = { ...dingInstallation, provider: 'wecom' as const, installationId: 'channel_wecom_0123456789abcdef01234567' };
    const starting = runtime.start(installation, JSON.stringify({ kind: 'wecom-aibot-v1', botId: 'bot', secret: 'secret' }));
    const client = sdk.wecom[0]!;
    client.emit('authenticated');
    await starting;
    client.emit('error', new Error('token=synthetic-sensitive-secret'));
    expect(JSON.stringify(await runtime.health(installation.installationId))).not.toContain('synthetic-sensitive');
    client.emit('disconnected', 'token=synthetic-sensitive-secret');
    expect(JSON.stringify(await runtime.health(installation.installationId))).not.toContain('synthetic-sensitive');
  });

  it('does not report connected when the pinned SDK resolves after swallowing a connection error', async () => {
    sdk.swallowConnectFailure = true;
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold', fetchImpl: providerFetch() });
    await expect(runtime.start(dingInstallation, dingCredential)).rejects.toThrow('connection failed');
    expect(sdk.dingtalk[0]!.disconnect).toHaveBeenCalled();
    await expect(runtime.health(dingInstallation.installationId)).resolves.toMatchObject({ running: false, state: 'stopped' });
  });

  it('uses no-redirect HTTPS transport for handshake, token and send, returning a real receipt', async () => {
    const fetchImpl = providerFetch();
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold', fetchImpl });
    await runtime.start(dingInstallation, dingCredential);
    await expect(runtime.send(dingInstallation, dingCredential, dingSend)).resolves.toEqual({ providerMessageId: 'receipt-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.dingtalk\.com\//);
      expect(init?.redirect).toBe('error');
    }
  });

  it.each([
    'ws://wss-open-connection.dingtalk.com/connect',
    'wss://127.0.0.1/connect',
    'wss://evil.invalid/connect',
    'wss://wss-open-connection.dingtalk.com.evil.invalid/connect',
    'wss://user:password@wss-open-connection.dingtalk.com/connect',
    'wss://wss-open-connection.dingtalk.com:444/connect',
    'wss://wss-open-connection.dingtalk.com/connect?ticket=attacker',
  ])('rejects unsafe provider WebSocket endpoint %s before connecting', async (endpoint) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...endpointBody, endpoint })));
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold', fetchImpl });
    await expect(runtime.start(dingInstallation, dingCredential)).rejects.toThrow();
    expect(sdk.dingtalk[0]!.connected).toBe(false);
  });

  it('encodes the opaque ticket as one query parameter and does not expose it via health', async () => {
    const ticket = 'opaque&injected=true#fragment';
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...endpointBody, ticket })));
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold', fetchImpl });
    await runtime.start(dingInstallation, dingCredential);
    const url = new URL(Reflect.get(sdk.dingtalk[0]!, 'dw_url'));
    expect([...url.searchParams.keys()]).toEqual(['ticket']);
    expect(url.searchParams.get('ticket')).toBe(ticket);
    expect(JSON.stringify(await runtime.health(dingInstallation.installationId))).not.toContain('opaque');
  });

  it.each(['redirect', 'oversized', 'slow-body'] as const)('rejects %s token responses before sending a message', async (mode) => {
    const fetchImpl = providerFetch();
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold', fetchImpl, requestTimeoutMs: 20 });
    await runtime.start(dingInstallation, dingCredential);
    const cancel = vi.fn();
    fetchImpl.mockImplementationOnce(async () => mode === 'redirect'
      ? new Response('', { status: 307, headers: { location: 'https://evil.invalid/collect' } })
      : mode === 'oversized'
        ? new Response(JSON.stringify({ accessToken: 'synthetic-access-token', padding: '中'.repeat(30_000) }))
        : new Response(new ReadableStream({ start() {}, cancel })));
    const result = runtime.send(dingInstallation, dingCredential, dingSend);
    await expect(Promise.race([
      result,
      new Promise((_, reject) => setTimeout(() => reject(new Error('test body deadline exceeded')), 150)),
    ])).rejects.toThrow(mode === 'slow-body' ? /request timed out/ : /request failed|too large/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    if (mode === 'slow-body') expect(cancel).toHaveBeenCalled();
  });

  it('reflects a lost SDK connection in health and refuses sends until reconnected', async () => {
    const fetchImpl = providerFetch();
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold', fetchImpl });
    await runtime.start(dingInstallation, dingCredential);
    sdk.dingtalk[0]!.connected = false;
    await expect(runtime.health(dingInstallation.installationId)).resolves.toMatchObject({ state: 'reconnecting' });
    await expect(runtime.send(dingInstallation, dingCredential, dingSend)).rejects.toThrow('not connected');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'x'.repeat(2_049), 'ticket\r\nheader'])(
    'rejects empty, oversized or control-character tickets', async (ticket) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ...endpointBody, ticket })));
      const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold', fetchImpl });
      await expect(runtime.start(dingInstallation, dingCredential)).rejects.toThrow('connection failed');
      expect(sdk.dingtalk[0]!.connected).toBe(false);
    },
  );

  it('does not return provider error bodies or credential-bearing transport errors', async () => {
    const fetchImpl = providerFetch();
    const runtime = new OfficialChannelRuntimeV1({ onInbound: async () => 'hold', fetchImpl });
    await runtime.start(dingInstallation, dingCredential);
    fetchImpl.mockRejectedValueOnce(new Error('appSecret=synthetic-sensitive-secret&ticket=private-ticket'));
    await expect(runtime.send(dingInstallation, dingCredential, dingSend)).rejects.toThrow(/^official channel request failed$/);
    expect(JSON.stringify(await runtime.health(dingInstallation.installationId))).not.toContain('private-ticket');
  });

  it('binds the pinned real SDK URL slot without using its unsafe HTTP method or the network', async () => {
    const { DWClient } = await vi.importActual<typeof import('dingtalk-stream')>('dingtalk-stream');
    const client = new DWClient({ clientId: 'synthetic', clientSecret: 'synthetic', autoReconnect: false });
    const request = vi.fn(async () => ({ ...endpointBody }));
    let active = true;
    bindDingTalkConnectionTransport(client, request, () => active);
    await client.getEndpoint();
    expect(Reflect.get(client, 'dw_url')).toBe('wss://wss-open-connection.dingtalk.com/connect?ticket=synthetic-ticket');
    expect(request).toHaveBeenCalledWith('https://api.dingtalk.com/v1.0/gateway/connections/open', expect.objectContaining({ method: 'POST' }));
    let finish!: (body: typeof endpointBody) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = client.getEndpoint();
    active = false;
    finish({ ...endpointBody, ticket: 'late-ticket' });
    await expect(pending).rejects.toThrow('cancelled');
    expect(Reflect.get(client, 'dw_url')).not.toContain('late-ticket');
  });
});
