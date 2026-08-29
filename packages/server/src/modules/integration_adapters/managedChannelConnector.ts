/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Shared lifecycle for Otto-managed Feishu, Lark and WeCom installations.
 * Provider OAuth/webhook exchange stays in provider adapters; this class owns
 * device-bound installation, credential custody and runtime lifecycle.
 */

import type { ChannelCredentialVaultV1 } from './channelCredentialVault.js';
import {
  type BeginPairingInput,
  type ChannelConnectorV1,
  type ChannelHealth,
  type ChannelInstallation,
  type ChannelInstallationProof,
  ChannelPairingCoordinator,
  type ChannelProvider,
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
  ): Promise<void>;
}

export interface ManagedProviderAuthorization {
  pairingId: string;
  nonce: string;
  authorization: PairingAuthorization;
  /** Provider token/credential returned by server-side code exchange. */
  plaintextCredential: string;
}

export interface ManagedChannelConnectorOptions {
  provider: ChannelProvider;
  coordinator: ChannelPairingCoordinator;
  vault: ChannelCredentialVaultV1;
  runtime: ChannelRuntimeAdapterV1;
}

export class ManagedChannelConnectorV1 implements ChannelConnectorV1 {
  private readonly pendingCredentials = new Map<string, string>();

  constructor(private readonly options: ManagedChannelConnectorOptions) {}

  beginPairing(input: BeginPairingInput): Promise<PairingSession> {
    if (input.provider !== this.options.provider) {
      throw new Error('channel connector provider mismatch');
    }
    return this.options.coordinator.begin(input);
  }

  async getPairingStatus(pairingId: string): Promise<PairingSession> {
    const pairing = await this.options.coordinator.get(pairingId);
    if (['expired', 'denied', 'failed', 'revoked', 'connected'].includes(pairing.status)) {
      this.pendingCredentials.delete(pairingId);
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

  approveAdmin(pairingId: string): Promise<PairingSession> {
    return this.options.coordinator.approveAdmin(pairingId);
  }

  async denyPairing(pairingId: string, reason?: string): Promise<PairingSession> {
    const pairing = await this.options.coordinator.deny(pairingId, reason);
    this.pendingCredentials.delete(pairingId);
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
    this.pendingCredentials.delete(pairingId);
    return installation;
  }

  async start(installationId: string): Promise<ChannelHealth> {
    const installation = this.requireInstallation(installationId);
    const credential = await this.options.vault.loadCredential({
      installationId,
      provider: installation.provider,
      tenantId: installation.tenantId,
    });
    return this.options.runtime.start(installation, credential);
  }

  stop(installationId: string): Promise<ChannelHealth> {
    this.requireInstallation(installationId);
    return this.options.runtime.stop(installationId);
  }

  async revoke(installationId: string): Promise<void> {
    const installation = this.requireInstallation(installationId);
    const lookup = {
      installationId,
      provider: installation.provider,
      tenantId: installation.tenantId,
    };
    const credential = await this.options.vault.loadCredential(lookup);
    await this.options.runtime.revoke(installation, credential);
    await this.options.vault.remove(lookup);
  }

  health(installationId: string): Promise<ChannelHealth> {
    this.requireInstallation(installationId);
    return this.options.runtime.health(installationId);
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
}
