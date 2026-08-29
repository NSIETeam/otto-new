/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Shared lifecycle for Otto-managed Feishu, Lark and WeCom installations.
 * Provider OAuth/webhook exchange stays in provider adapters; this class owns
 * device-bound installation, credential custody and runtime lifecycle.
 */

import type { ChannelCredentialVaultV1 } from './channelCredentialVault.js';
import { createHash } from 'node:crypto';
import type {
  ChannelOutboundLedgerV1,
  ChannelOutboundReceipt,
} from './channelOutboundLedger.js';
import {
  type BeginPairingInput,
  type ChannelConnectorV1,
  type ChannelHealth,
  type ChannelBrokerPairingRegistration,
  type ChannelInstallation,
  type ChannelInstallationProof,
  ChannelPairingCoordinator,
  type ChannelProvider,
  type ChannelSendInput,
  type PairingAuthorization,
  type PairingSession,
} from './channelConnector.js';

export interface ChannelRuntimeAdapterV1 {
  start(
    installation: Readonly<ChannelInstallation>,
    plaintextCredential: string,
  ): Promise<ChannelHealth>;
  stop(installationId: string): Promise<ChannelHealth>;
  health(installationId: string): Promise<ChannelHealth>;
  revoke(
    installation: Readonly<ChannelInstallation>,
    plaintextCredential: string,
    context: { idempotencyKey: string },
  ): Promise<void>;
  send(
    installation: Readonly<ChannelInstallation>,
    plaintextCredential: string,
    input: Readonly<ChannelSendInput>,
  ): Promise<{ providerMessageId: string }>;
}

export interface ManagedProviderAuthorization {
  pairingId: string;
  nonce: string;
  authorization: PairingAuthorization;
  /** Provider token/credential returned by server-side code exchange. */
  plaintextCredential: string;
}

export type ChannelPairingBrokerStatus =
  | { status: 'waiting' }
  | { status: 'admin_approved' }
  | {
      status: 'authorized';
      authorization: PairingAuthorization;
      plaintextCredential: string;
    }
  | { status: 'denied'; reason?: string };

export interface ChannelPairingBrokerV1 {
  register(registration: ChannelBrokerPairingRegistration): Promise<void>;
  poll(pairingId: string): Promise<ChannelPairingBrokerStatus>;
  cancel(pairingId: string): Promise<void>;
}

export interface ManagedChannelConnectorOptions {
  provider: ChannelProvider;
  coordinator: ChannelPairingCoordinator;
  vault: ChannelCredentialVaultV1;
  runtime: ChannelRuntimeAdapterV1;
  broker: ChannelPairingBrokerV1;
  outboundLedger: ChannelOutboundLedgerV1;
}

export class ManagedChannelConnectorV1 implements ChannelConnectorV1 {
  private readonly pendingCredentials = new Map<string, string>();
  private readonly brokerRegistrations = new Map<
    string,
    ChannelBrokerPairingRegistration
  >();
  private readonly lifecycleTails = new Map<string, Promise<unknown>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: ManagedChannelConnectorOptions) {}

  disposePendingPairings(): void {
    for (const pairingId of this.expiryTimers.keys()) {
      this.clearLocalPairingState(pairingId);
    }
  }

  listInstallations(): ChannelInstallation[] {
    return this.options.vault
      .listInstallations()
      .filter((installation) => installation.provider === this.options.provider);
  }

  async beginPairing(input: BeginPairingInput): Promise<PairingSession> {
    if (input.provider !== this.options.provider) {
      throw new Error('channel connector provider mismatch');
    }
    const { session, registration } =
      await this.options.coordinator.beginForBroker(input);
    try {
      await this.options.broker.register(registration);
    } catch (error) {
      await this.options.coordinator.deny(
        session.pairingId,
        'pairing broker registration failed',
      );
      throw error;
    }
    this.brokerRegistrations.set(session.pairingId, registration);
    this.scheduleLocalExpiry(session);
    return session;
  }

  async getPairingStatus(pairingId: string): Promise<PairingSession> {
    let pairing = await this.options.coordinator.get(pairingId);
    if (pairing.status === 'waiting_scan' || pairing.status === 'waiting_admin') {
      const remote = await this.options.broker.poll(pairingId);
      if (remote.status === 'authorized' && pairing.status === 'waiting_scan') {
        const nonce = this.requireBrokerNonce(pairingId);
        pairing = await this.acceptProviderAuthorization({
          pairingId,
          nonce,
          authorization: remote.authorization,
          plaintextCredential: remote.plaintextCredential,
        });
      } else if (remote.status === 'admin_approved' && pairing.status === 'waiting_admin') {
        pairing = await this.options.coordinator.approveAdmin(pairingId);
      } else if (remote.status === 'denied') {
        pairing = await this.options.coordinator.deny(
          pairingId,
          remote.reason ?? 'provider authorization denied',
        );
      }
    }
    if (['expired', 'denied', 'failed', 'revoked', 'connected'].includes(pairing.status)) {
      this.clearLocalPairingState(pairingId);
      await this.options.broker.cancel(pairingId).catch(() => undefined);
    }
    return pairing;
  }

  async acceptProviderAuthorization(
    input: ManagedProviderAuthorization,
  ): Promise<PairingSession> {
    if (!input.plaintextCredential) {
      throw new Error('provider credential is required');
    }
    const pairing = await this.options.coordinator.authorize(
      input.pairingId,
      input.nonce,
      input.authorization,
    );
    this.pendingCredentials.set(input.pairingId, input.plaintextCredential);
    return pairing;
  }

  async denyPairing(pairingId: string, reason?: string): Promise<PairingSession> {
    const pairing = await this.options.coordinator.deny(pairingId, reason);
    this.clearLocalPairingState(pairingId);
    await this.options.broker.cancel(pairingId).catch(() => undefined);
    const installationId = `channel_${this.options.provider}_${pairingId.slice(5)}`;
    const partial = this.options.vault
      .listInstallations()
      .find((installation) => installation.installationId === installationId);
    if (partial) {
      await this.options.vault.remove({
        installationId,
        provider: partial.provider,
        tenantId: partial.tenantId,
      });
    }
    return pairing;
  }

  async completeInstallation(
    pairingId: string,
    proof: ChannelInstallationProof,
  ): Promise<ChannelInstallation> {
    const credential = this.pendingCredentials.get(pairingId);
    if (!credential) throw new Error('provider credential is unavailable');
    const installation = await this.options.coordinator.complete(
      pairingId,
      proof,
      ({ installation: pendingInstallation }) =>
        this.options.vault.commit(pendingInstallation, credential),
    );
    this.clearLocalPairingState(pairingId);
    await this.options.broker.cancel(pairingId).catch(() => undefined);
    return installation;
  }

  async start(installationId: string): Promise<ChannelHealth> {
    return this.serializeLifecycle(installationId, async () => {
      const installation = this.requireInstallation(installationId);
      const credential = await this.options.vault.loadCredential({
        installationId,
        provider: installation.provider,
        tenantId: installation.tenantId,
      });
      return this.options.runtime.start(installation, credential);
    });
  }

  stop(installationId: string): Promise<ChannelHealth> {
    return this.serializeLifecycle(installationId, () => {
      this.requireInstallation(installationId);
      return this.options.runtime.stop(installationId);
    });
  }

  async revoke(installationId: string): Promise<void> {
    return this.serializeLifecycle(installationId, async () => {
      const installation = this.requireInstallation(installationId);
      const lookup = {
        installationId,
        provider: installation.provider,
        tenantId: installation.tenantId,
      };
      const credential = await this.options.vault.loadCredential(lookup);
      let remoteFailure: unknown;
      try {
        await this.options.runtime.revoke(installation, credential, {
          idempotencyKey: `channel-revoke:${installationId}`,
        });
      } catch (error) {
        remoteFailure = error;
      }
      // Local authorization is always removed. A remote timeout must never
      // allow this installation to reconnect on the next Otto start.
      await this.options.vault.remove(lookup);
      if (remoteFailure) {
        throw new Error(
          'provider revocation outcome is unknown; local authorization was removed and will not reconnect',
          { cause: remoteFailure },
        );
      }
    });
  }

  health(installationId: string): Promise<ChannelHealth> {
    this.requireInstallation(installationId);
    return this.options.runtime.health(installationId);
  }

  send(
    installationId: string,
    input: ChannelSendInput,
  ): Promise<ChannelOutboundReceipt> {
    return this.serializeLifecycle(installationId, async () => {
      const target = input.target.trim();
      const text = input.text.trim();
      if (!target || target.length > 500) throw new Error('channel message target is invalid');
      if (!text || text.length > 20_000) throw new Error('channel message text is invalid');
      const installation = this.requireInstallation(installationId);
      const requestHash = createHash('sha256')
        .update(JSON.stringify({ installationId, target, text }), 'utf8')
        .digest('hex');
      const prepared = await this.options.outboundLedger.prepare({
        idempotencyKey: input.idempotencyKey,
        installationId,
        provider: installation.provider,
        requestHash,
      });
      if (prepared.state === 'committed' && prepared.receipt) return prepared.receipt;
      if (prepared.state === 'unknown_outcome') {
        throw new Error('channel outbound outcome is unknown; reconcile before retrying');
      }
      let credential: string;
      try {
        credential = await this.options.vault.loadCredential({
          installationId,
          provider: installation.provider,
          tenantId: installation.tenantId,
        });
      } catch (error) {
        await this.options.outboundLedger.fail(
          input.idempotencyKey,
          requestHash,
          error instanceof Error ? error.name : 'credential_unavailable',
        ).catch(() => undefined);
        throw error;
      }
      try {
        const result = await this.options.runtime.send(
          installation,
          credential,
          { target, text, idempotencyKey: input.idempotencyKey },
        );
        const committed = await this.options.outboundLedger.commit(
          input.idempotencyKey,
          requestHash,
          result.providerMessageId,
        );
        if (!committed.receipt) throw new Error('channel outbound receipt is missing');
        return committed.receipt;
      } catch (error) {
        await this.options.outboundLedger.unknown(
          input.idempotencyKey,
          requestHash,
          error instanceof Error ? error.name : 'unknown',
        ).catch(() => undefined);
        throw error;
      }
    });
  }

  private requireInstallation(installationId: string): ChannelInstallation {
    const installation = this.options.vault
      .listInstallations()
      .find((candidate) => candidate.installationId === installationId);
    if (!installation || installation.provider !== this.options.provider) {
      throw new Error('channel installation was not found');
    }
    return installation;
  }

  private requireBrokerNonce(pairingId: string): string {
    const registration = this.brokerRegistrations.get(pairingId);
    if (!registration) throw new Error('channel broker registration is unavailable');
    return registration.nonce;
  }

  private scheduleLocalExpiry(pairing: PairingSession): void {
    const existing = this.expiryTimers.get(pairing.pairingId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      // The provider Broker owns its own TTL. Expiry here only erases local
      // plaintext and nonce material; it must not create an idle network call.
      this.pendingCredentials.delete(pairing.pairingId);
      this.brokerRegistrations.delete(pairing.pairingId);
      this.expiryTimers.delete(pairing.pairingId);
    }, Math.max(0, pairing.expiresAtMs - Date.now()));
    timer.unref?.();
    this.expiryTimers.set(pairing.pairingId, timer);
  }

  private clearLocalPairingState(pairingId: string): void {
    this.pendingCredentials.delete(pairingId);
    this.brokerRegistrations.delete(pairingId);
    const timer = this.expiryTimers.get(pairingId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(pairingId);
  }

  private serializeLifecycle<T>(
    installationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTails.get(installationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.lifecycleTails.set(installationId, current);
    void current.finally(() => {
      if (this.lifecycleTails.get(installationId) === current) {
        this.lifecycleTails.delete(installationId);
      }
    }).catch(() => undefined);
    return current;
  }
}
