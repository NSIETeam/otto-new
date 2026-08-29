/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelCredentialLookup,
  ChannelCredentialVaultV1,
} from './channelCredentialVault.js';
import type {
  ChannelOutboundLedgerV1,
  ChannelOutboundRecord,
} from './channelOutboundLedger.js';
import {
  channelInstallationProofPayload,
  ChannelPairingCoordinator,
  type ChannelInstallation,
} from './channelConnector.js';
import {
  ManagedChannelConnectorV1,
  type ChannelPairingBrokerStatus,
  type ChannelPairingBrokerV1,
  type ChannelRuntimeAdapterV1,
} from './managedChannelConnector.js';

afterEach(() => vi.useRealTimers());

function setup() {
  const entries = new Map<string, { installation: ChannelInstallation; credential: string }>();
  const vault: ChannelCredentialVaultV1 = {
    commit: vi.fn(async (installation, credential) => {
      if (!entries.has(installation.installationId)) {
        entries.set(installation.installationId, {
          installation: { ...installation, grantedScopes: [...installation.grantedScopes] },
          credential,
        });
      }
    }),
    loadCredential: vi.fn(async (lookup: ChannelCredentialLookup) => {
      const entry = entries.get(lookup.installationId);
      if (!entry || entry.installation.provider !== lookup.provider || entry.installation.tenantId !== lookup.tenantId) {
        throw new Error('tenant mismatch');
      }
      return entry.credential;
    }),
    remove: vi.fn(async (lookup: ChannelCredentialLookup) => entries.delete(lookup.installationId)),
    listInstallations: vi.fn(() => [...entries.values()].map((entry) => entry.installation)),
  };
  const runtime: ChannelRuntimeAdapterV1 = {
    start: vi.fn(async (installation) => ({
      installationId: installation.installationId,
      running: true,
      state: 'connected',
      reconnectCount: 0,
    })),
    stop: vi.fn(async (installationId) => ({
      installationId,
      running: false,
      state: 'stopped',
      reconnectCount: 0,
    })),
    health: vi.fn(async (installationId) => ({
      installationId,
      running: true,
      state: 'connected',
      reconnectCount: 0,
    })),
    revoke: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ providerMessageId: 'provider-message-1' })),
  };
  const outboundRecords = new Map<string, ChannelOutboundRecord>();
  const outboundLedger: ChannelOutboundLedgerV1 = {
    prepare: vi.fn(async (input) => {
      const existing = outboundRecords.get(input.idempotencyKey);
      if (existing?.state === 'committed') return existing;
      const record: ChannelOutboundRecord = existing
        ? { ...existing, state: 'prepared', attempts: existing.attempts + 1 }
        : { ...input, state: 'prepared', attempts: 1, updatedAtMs: 1 };
      outboundRecords.set(input.idempotencyKey, record);
      return record;
    }),
    commit: vi.fn(async (idempotencyKey, requestHash, providerMessageId) => {
      const record = outboundRecords.get(idempotencyKey)!;
      const committed: ChannelOutboundRecord = {
        ...record,
        requestHash,
        state: 'committed',
        receipt: { idempotencyKey, providerMessageId, committedAtMs: 2 },
      };
      outboundRecords.set(idempotencyKey, committed);
      return committed;
    }),
    fail: vi.fn(async (idempotencyKey, requestHash, failureCode) => {
      const failed: ChannelOutboundRecord = {
        ...outboundRecords.get(idempotencyKey)!,
        requestHash,
        state: 'failed',
        failureCode,
      };
      outboundRecords.set(idempotencyKey, failed);
      return failed;
    }),
  };
  const coordinator = new ChannelPairingCoordinator({
    publicPairingOrigin: 'https://connect.otto.example',
    randomToken: () => 'single-use-pairing-nonce-with-enough-entropy',
    audit: () => undefined,
  });
  let brokerStatus: ChannelPairingBrokerStatus = { status: 'waiting' };
  const broker: ChannelPairingBrokerV1 = {
    register: vi.fn(async () => undefined),
    poll: vi.fn(async () => brokerStatus),
    cancel: vi.fn(async () => undefined),
  };
  return {
    vault,
    runtime,
    broker,
    outboundLedger,
    setBrokerStatus(status: ChannelPairingBrokerStatus) {
      brokerStatus = status;
    },
    connector: new ManagedChannelConnectorV1({
      provider: 'lark',
      coordinator,
      vault,
      runtime,
      broker,
      outboundLedger,
    }),
  };
}

describe('ManagedChannelConnectorV1', () => {
  it('shares one protected installation across start, health, stop and revoke', async () => {
    const { connector, runtime, vault } = setup();
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pairing = await connector.beginPairing({
      provider: 'lark',
      installationPublicKey: publicKey.trim(),
      requestedScopes: ['im:message'],
    });
    await connector.acceptProviderAuthorization({
      pairingId: pairing.pairingId,
      nonce: 'single-use-pairing-nonce-with-enough-entropy',
      plaintextCredential: 'provider-refresh-token',
      authorization: {
        tenantId: 'tenant-1',
        tenantName: 'Acme',
        botName: 'Otto',
        grantedScopes: ['im:message'],
      },
    });
    const installation = await connector.completeInstallation(pairing.pairingId, {
      installationPublicKey: publicKey,
      signature: sign(
        null,
        channelInstallationProofPayload(pairing.pairingId),
        keys.privateKey,
      ).toString('base64url'),
    });

    await connector.start(installation.installationId);
    await connector.health(installation.installationId);
    await connector.stop(installation.installationId);
    await connector.revoke(installation.installationId);

    expect(vault.commit).toHaveBeenCalledWith(installation, 'provider-refresh-token');
    expect(runtime.start).toHaveBeenCalledWith(installation, 'provider-refresh-token');
    expect(runtime.revoke).toHaveBeenCalledWith(installation, 'provider-refresh-token');
    expect(vault.listInstallations()).toEqual([]);
  });

  it('does not expose or persist a credential before device proof succeeds', async () => {
    const { connector, vault } = setup();
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pairing = await connector.beginPairing({
      provider: 'lark',
      installationPublicKey: publicKey,
      requestedScopes: ['im:message'],
    });
    await connector.acceptProviderAuthorization({
      pairingId: pairing.pairingId,
      nonce: 'single-use-pairing-nonce-with-enough-entropy',
      plaintextCredential: 'provider-refresh-token',
      authorization: {
        tenantId: 'tenant-1', tenantName: 'Acme', botName: 'Otto', grantedScopes: ['im:message'],
      },
    });
    await expect(connector.completeInstallation(pairing.pairingId, {
      installationPublicKey: publicKey,
      signature: Buffer.alloc(64).toString('base64url'),
    })).rejects.toThrow('device proof');
    expect(vault.commit).not.toHaveBeenCalled();
    expect(vault.listInstallations()).toEqual([]);
  });

  it('cancels after provider authorization and discards the pending credential', async () => {
    const { connector, vault } = setup();
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pairing = await connector.beginPairing({
      provider: 'lark',
      installationPublicKey: publicKey,
      requestedScopes: ['im:message'],
    });
    await connector.acceptProviderAuthorization({
      pairingId: pairing.pairingId,
      nonce: 'single-use-pairing-nonce-with-enough-entropy',
      plaintextCredential: 'provider-refresh-token',
      authorization: {
        tenantId: 'tenant-1', tenantName: 'Acme', botName: 'Otto', grantedScopes: ['im:message'],
      },
    });

    expect((await connector.denyPairing(pairing.pairingId)).status).toBe('denied');
    await expect(connector.completeInstallation(pairing.pairingId, {
      installationPublicKey: publicKey,
      signature: sign(
        null,
        channelInstallationProofPayload(pairing.pairingId),
        keys.privateKey,
      ).toString('base64url'),
    })).rejects.toThrow('credential is unavailable');
    expect(vault.commit).not.toHaveBeenCalled();
  });

  it('erases abandoned plaintext at expiry without making an idle broker call', async () => {
    vi.useFakeTimers();
    const { connector, broker } = setup();
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pairing = await connector.beginPairing({
      provider: 'lark', installationPublicKey: publicKey, requestedScopes: ['im:message'],
    });
    await connector.acceptProviderAuthorization({
      pairingId: pairing.pairingId,
      nonce: 'single-use-pairing-nonce-with-enough-entropy',
      plaintextCredential: 'must-be-erased',
      authorization: {
        tenantId: 'tenant-1', tenantName: 'Acme', botName: 'Otto', grantedScopes: ['im:message'],
      },
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(connector.completeInstallation(pairing.pairingId, {
      installationPublicKey: publicKey,
      signature: sign(
        null,
        channelInstallationProofPayload(pairing.pairingId),
        keys.privateKey,
      ).toString('base64url'),
    })).rejects.toThrow('credential is unavailable');
    expect(broker.cancel).not.toHaveBeenCalled();
  });

  it('registers outbound and consumes an authorized broker result without a public local callback', async () => {
    const { connector, broker, setBrokerStatus } = setup();
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pairing = await connector.beginPairing({
      provider: 'lark',
      installationPublicKey: publicKey,
      requestedScopes: ['im:message'],
    });
    expect(broker.register).toHaveBeenCalledWith(expect.objectContaining({
      pairingId: pairing.pairingId,
      provider: 'lark',
      installationPublicKey: publicKey.trim(),
      nonce: 'single-use-pairing-nonce-with-enough-entropy',
    }));
    setBrokerStatus({
      status: 'authorized',
      plaintextCredential: 'broker-refresh-token',
      authorization: {
        tenantId: 'tenant-1',
        tenantName: 'Acme',
        botName: 'Otto',
        grantedScopes: ['im:message'],
      },
    });

    expect((await connector.getPairingStatus(pairing.pairingId)).status)
      .toBe('user_authorized');
    expect((await connector.getPairingStatus(pairing.pairingId)).status)
      .toBe('user_authorized');
    expect(broker.poll).toHaveBeenCalledTimes(1);
  });

  it('serializes competing lifecycle writes for one installation', async () => {
    const { connector, runtime, vault } = setup();
    const installation = {
      installationId: 'channel_lark_0123456789abcdef01234567',
      provider: 'lark' as const,
      tenantId: 'tenant-1',
      tenantName: 'Acme',
      botName: 'Otto',
      grantedScopes: ['im:message'],
      connectedAtMs: 100,
    };
    await vault.commit(installation, 'credential');
    let releaseStart: (() => void) | undefined;
    const startMock = vi.mocked(runtime.start);
    const stopMock = vi.mocked(runtime.stop);
    startMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseStart = () => resolve({
          installationId: installation.installationId,
          running: true,
          state: 'connected',
          reconnectCount: 0,
        });
      }),
    );

    const starting = connector.start(installation.installationId);
    const stopping = connector.stop(installation.installationId);
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'));
    expect(stopMock).not.toHaveBeenCalled();
    releaseStart!();
    await starting;
    await stopping;
    expect(startMock.mock.invocationCallOrder[0])
      .toBeLessThan(stopMock.mock.invocationCallOrder[0]);
  });

  it('waits for broker-confirmed administrator approval', async () => {
    const { connector, broker, setBrokerStatus } = setup();
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pairing = await connector.beginPairing({
      provider: 'lark',
      installationPublicKey: publicKey,
      requestedScopes: ['im:message'],
    });
    setBrokerStatus({
      status: 'authorized',
      plaintextCredential: 'broker-refresh-token',
      authorization: {
        tenantId: 'tenant-1',
        tenantName: 'Acme',
        botName: 'Otto',
        grantedScopes: ['im:message'],
        requiresAdminApproval: true,
      },
    });
    expect((await connector.getPairingStatus(pairing.pairingId)).status)
      .toBe('waiting_admin');
    setBrokerStatus({ status: 'waiting' });
    expect((await connector.getPairingStatus(pairing.pairingId)).status)
      .toBe('waiting_admin');
    setBrokerStatus({ status: 'admin_approved' });
    expect((await connector.getPairingStatus(pairing.pairingId)).status)
      .toBe('user_authorized');
    expect(broker.poll).toHaveBeenCalledTimes(3);
  });

  it('recovers message delivery with the same provider idempotency key', async () => {
    const { connector, runtime, vault, outboundLedger } = setup();
    const installation = {
      installationId: 'channel_lark_0123456789abcdef01234567',
      provider: 'lark' as const,
      tenantId: 'tenant-1',
      tenantName: 'Acme',
      botName: 'Otto',
      grantedScopes: ['im:message'],
      connectedAtMs: 100,
    };
    await vault.commit(installation, 'credential');
    const sendMock = vi.mocked(runtime.send);
    sendMock.mockRejectedValueOnce(new Error('provider timeout'));
    const input = {
      target: 'chat-1',
      text: 'long task completed',
      idempotencyKey: 'msg:0123456789abcdef',
    };

    await expect(connector.send(installation.installationId, input))
      .rejects.toThrow('provider timeout');
    await expect(connector.send(installation.installationId, input))
      .resolves.toMatchObject({
        idempotencyKey: input.idempotencyKey,
        providerMessageId: 'provider-message-1',
      });
    await expect(connector.send(installation.installationId, input))
      .resolves.toMatchObject({ providerMessageId: 'provider-message-1' });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenLastCalledWith(
      installation,
      'credential',
      input,
    );
    expect(outboundLedger.fail).toHaveBeenCalledOnce();
  });
});
