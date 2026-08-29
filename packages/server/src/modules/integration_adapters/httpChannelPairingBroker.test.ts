/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { HttpChannelPairingBrokerV1 } from './httpChannelPairingBroker.js';

const registration = {
  pairingId: 'pair_0123456789abcdef01234567',
  provider: 'wecom' as const,
  nonce: 'single-use-secret',
  installationPublicKey: 'public-key',
  requestedScopes: ['message.send'],
  expiresAtMs: 123,
  qrPayload: 'https://connect.otto.example/channel/pair?opaque',
};

describe('HttpChannelPairingBrokerV1', () => {
  it('uses an idempotent authenticated registration without leaking credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const broker = new HttpChannelPairingBrokerV1({
      baseUrl: 'https://connect.otto.example/',
      bearerToken: 'device-broker-secret',
      fetchImpl,
    });
    await broker.register(registration);

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://connect.otto.example/v1/channel-pairings/${registration.pairingId}`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          authorization: 'Bearer device-broker-secret',
          'idempotency-key': registration.pairingId,
        }),
      }),
    );
  });

  it('strictly parses authorized status and does not include response secrets in errors', async () => {
    const success = vi.fn(async () => new Response(JSON.stringify({
      status: 'authorized',
      plaintextCredential: 'provider-token',
      authorization: {
        tenantId: 'corp-1',
        tenantName: 'Acme',
        botName: 'Otto',
        grantedScopes: ['message.send'],
        requiresAdminApproval: true,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const broker = new HttpChannelPairingBrokerV1({
      baseUrl: 'https://connect.otto.example', bearerToken: 'secret', fetchImpl: success,
    });
    await expect(broker.poll(registration.pairingId)).resolves.toMatchObject({
      status: 'authorized',
      plaintextCredential: 'provider-token',
      authorization: { tenantId: 'corp-1', requiresAdminApproval: true },
    });

    const failure = new HttpChannelPairingBrokerV1({
      baseUrl: 'https://connect.otto.example',
      bearerToken: 'secret',
      fetchImpl: vi.fn(async () => new Response('provider-token-in-error', { status: 502 })),
    });
    await expect(failure.poll(registration.pairingId)).rejects.toThrow('(502)');
    await expect(failure.poll(registration.pairingId)).rejects.not.toThrow('provider-token-in-error');
  });

  it('rejects insecure remote origins and aborts hung requests', async () => {
    expect(() => new HttpChannelPairingBrokerV1({
      baseUrl: 'http://connect.otto.example', bearerToken: 'secret',
    })).toThrow('must use HTTPS');
    const broker = new HttpChannelPairingBrokerV1({
      baseUrl: 'https://connect.otto.example',
      bearerToken: 'secret',
      timeoutMs: 100,
      fetchImpl: vi.fn((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })),
    });
    await expect(broker.poll(registration.pairingId)).rejects.toThrow('timed out');
  });
});
