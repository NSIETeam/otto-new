/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryChannelMessageDedupJournal } from './channelTaskControl.js';
import type { BrokerChannelSocketV1 } from './brokerChannelRuntime.js';
import { ManagedChannelPlatformV1 } from './managedChannelPlatform.js';

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
  tenantId: 'tenant-1', tenantName: 'Acme', botName: 'Otto',
  grantedScopes: ['im:message'], connectedAtMs: 1,
};

describe('ManagedChannelPlatformV1', () => {
  it('connects an installed channel and routes an authenticated message through workflow and reply', async () => {
    const socket = new FakeSocket();
    const task = {
      id: 'task-1', definitionId: 'daily-check', status: 'cancelled',
      updatedAt: new Date(2_000).toISOString(), steps: [{
        stepId: 'execute', status: 'running', input: { origin: {
          provider: 'lark', installationId: installation.installationId,
          tenantId: 'tenant-1', providerUserId: 'provider-user-1',
          userId: 'otto-user-1', deviceId: 'device-1',
        } },
      }],
    };
    const cancel = vi.fn(async () => task);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      providerMessageId: 'om_reply_1',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const createSocket = vi.fn(() => socket);
    const outboundRecord = {
      idempotencyKey: 'channel-reply:lark:channel_lark_0123456789abcdef01234567:message-1',
      installationId: installation.installationId,
      provider: 'lark' as const,
      requestHash: 'a'.repeat(64), state: 'prepared' as const, attempts: 1, updatedAtMs: 1,
    };
    const platform = new ManagedChannelPlatformV1({
      brokerBaseUrl: 'https://connect.otto.example',
      pairingBearerToken: 'pairing-device-token',
      publicPairingOrigin: 'https://connect.otto.example/channel/pair',
      vault: {
        listInstallations: () => [installation],
        loadCredential: async () => JSON.stringify({
          brokerAccessToken: 'installation-token', deviceId: 'device-1',
        }),
        commit: async () => undefined,
        remove: async () => true,
      },
      outboundLedger: {
        prepare: vi.fn(async (input) => ({ ...outboundRecord, ...input })),
        commit: vi.fn(async (idempotencyKey, requestHash, providerMessageId) => ({
          ...outboundRecord, idempotencyKey, requestHash, state: 'committed' as const,
          receipt: { idempotencyKey, providerMessageId, committedAtMs: 2 },
        })),
        fail: vi.fn(async (_idempotencyKey, _requestHash, failureCode) => ({
          ...outboundRecord, state: 'failed' as const, failureCode,
        })),
        unknown: vi.fn(async (_idempotencyKey, _requestHash, failureCode) => ({
          ...outboundRecord, state: 'unknown_outcome' as const, failureCode,
        })),
      },
      identityRegistry: {
        list: () => [],
        bind: vi.fn(), revoke: vi.fn(),
        resolve: async () => ({ canonicalUserId: 'otto-user-1', active: true }),
      },
      workflowBackend: {
        list: async () => [task], get: async () => task,
        pause: async () => null, resume: async () => null, cancel,
        takeOver: async () => null, approve: async () => null,
      },
      proposalBackend: { create: vi.fn() },
      policy: { authorize: async () => ({ allowed: true }) },
      journal: new InMemoryChannelMessageDedupJournal(),
      auditPairing: vi.fn(),
      fetchImpl,
      createSocket,
      now: () => 2_000,
    });
    expect(Object.keys(platform.connectors).sort()).toEqual(['feishu', 'lark', 'wecom']);
    const starting = platform.connectors.lark!.start(installation.installationId);
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
    socket.emit('open');
    await expect(starting).resolves.toMatchObject({ state: 'connected' });

    socket.emit('message', JSON.stringify({
      type: 'message', messageId: 'message-1', tenantId: 'tenant-1',
      userId: 'provider-user-1', text: '/cancel task-1', receivedAtMs: 2_000,
    }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('task-1'));
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'ack', messageId: 'message-1' }),
    ));
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://connect.otto.example/v1/channel-installations/${installation.installationId}/messages`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
