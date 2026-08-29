/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelCredentialLookup,
  ChannelCredentialVaultV1,
} from './channelCredentialVault.js';
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
    setBrokerStatus(status: ChannelPairingBrokerStatus) {
      brokerStatus = status;
    },
    connector: new ManagedChannelConnectorV1({
      provider: 'lark',
      coordinator,
      vault,
      runtime,
      broker,
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
});
