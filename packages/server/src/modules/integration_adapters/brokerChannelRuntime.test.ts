/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  BrokerChannelRuntimeV1,
  type BrokerChannelSocketV1,
} from './brokerChannelRuntime.js';

class FakeSocket extends EventEmitter implements BrokerChannelSocketV1 {
  readonly send = vi.fn();
  readonly close = vi.fn(() => this.emit('close'));

  override on(event: 'open' | 'close', listener: () => void): this;
  override on(event: 'error', listener: (error: Error) => void): this;
  override on(event: 'message', listener: (data: string) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener);
  }
}

const installation = {
  installationId: 'channel_lark_0123456789abcdef01234567',
  provider: 'lark' as const,
  tenantId: 'tenant-1',
  tenantName: 'Acme',
  botName: 'Otto',
  grantedScopes: ['im:message'],
  connectedAtMs: 1,
};
const credential = JSON.stringify({
  brokerAccessToken: 'device-access-token',
  deviceId: 'device-1',
});

describe('BrokerChannelRuntimeV1', () => {
  it('opens one authenticated outbound socket and ACKs only accepted tenant messages', async () => {
    const socket = new FakeSocket();
    const onInbound = vi.fn(async () => 'ack' as const);
    const createSocket = vi.fn(() => socket);
    const runtime = new BrokerChannelRuntimeV1({
      baseUrl: 'https://connect.otto.example',
      createSocket,
      onInbound,
    });
    const starting = runtime.start(installation, credential);
    socket.emit('open');
    await expect(starting).resolves.toMatchObject({ state: 'connected', running: true });
    expect(createSocket).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/channel-installations/${installation.installationId}/stream?device_id=device-1`),
      { authorization: 'Bearer device-access-token' },
    );

    socket.emit('message', JSON.stringify({
      type: 'message',
      messageId: 'message-wrong-tenant',
      tenantId: 'tenant-2',
      userId: 'user-1',
      text: '/status',
      receivedAtMs: Date.now(),
    }));
    await Promise.resolve();
    expect(onInbound).not.toHaveBeenCalled();
    socket.emit('message', JSON.stringify({
      type: 'message',
      messageId: 'message-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      text: '/status',
      receivedAtMs: Date.now(),
    }));
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'ack', messageId: 'message-1' }),
    ));
    expect(onInbound).toHaveBeenCalledWith(
      installation,
      expect.objectContaining({ messageId: 'message-1', tenantId: 'tenant-1' }),
    );
  });

  it('holds unconfirmed messages and sends outbound writes with the same idempotency key', async () => {
    const socket = new FakeSocket();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      providerMessageId: 'om_message_1',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const runtime = new BrokerChannelRuntimeV1({
      baseUrl: 'https://connect.otto.example',
      createSocket: () => socket,
      fetchImpl,
      onInbound: async () => 'hold',
    });
    const starting = runtime.start(installation, credential);
    socket.emit('open');
    await starting;
    socket.emit('message', JSON.stringify({
      type: 'message', messageId: 'message-1', tenantId: 'tenant-1',
      userId: 'user-1', text: '/cancel task-1', receivedAtMs: Date.now(),
    }));
    await Promise.resolve();
    expect(socket.send).not.toHaveBeenCalled();

    await expect(runtime.send(installation, credential, {
      target: 'chat-1',
      text: 'done',
      idempotencyKey: 'msg:0123456789abcdef',
    })).resolves.toEqual({ providerMessageId: 'om_message_1' });
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://connect.otto.example/v1/channel-installations/${installation.installationId}/messages`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer device-access-token',
          'idempotency-key': 'msg:0123456789abcdef',
        }),
      }),
    );
  });

  it('stops explicitly without reconnecting after the socket closes', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const runtime = new BrokerChannelRuntimeV1({
        baseUrl: 'https://connect.otto.example',
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        onInbound: async () => 'ack',
      });
      const starting = runtime.start(installation, credential);
      sockets[0].emit('open');
      await starting;
      await runtime.stop(installation.installationId);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sockets).toHaveLength(1);
      await expect(runtime.health(installation.installationId)).resolves.toMatchObject({
        state: 'stopped', running: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects after an unexpected close and aborts stalled broker writes', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));
      const runtime = new BrokerChannelRuntimeV1({
        baseUrl: 'https://connect.otto.example',
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        fetchImpl,
        requestTimeoutMs: 50,
        onInbound: async () => 'ack',
      });
      const starting = runtime.start(installation, credential);
      sockets[0].emit('open');
      await starting;
      sockets[0].emit('close');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
      sockets[1].emit('open');
      await expect(runtime.health(installation.installationId)).resolves.toMatchObject({
        state: 'connected', reconnectCount: 1,
      });

      const sending = runtime.send(installation, credential, {
        target: 'chat-1', text: 'hello', idempotencyKey: 'msg:0123456789abcdef',
      });
      const timedOut = expect(sending).rejects.toThrow('managed channel broker request timed out');
      await vi.advanceTimersByTimeAsync(50);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });
});
