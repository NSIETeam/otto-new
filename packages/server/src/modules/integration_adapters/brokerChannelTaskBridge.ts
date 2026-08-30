/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Fail-closed bridge from broker-authenticated channel messages to typed task
 * controls. Provider identities must be explicitly bound before any command is
 * parsed or executed.
 */

import type { ChannelInstallation } from './channelConnector.js';
import type { ChannelTaskControlGateway } from './channelTaskControl.js';
import type { BrokerInboundChannelMessage } from './brokerChannelRuntime.js';

export interface BoundChannelIdentity {
  canonicalUserId: string;
  active: boolean;
}

export interface ChannelIdentityResolverV1 {
  resolve(input: {
    provider: ChannelInstallation['provider'];
    installationId: string;
    tenantId: string;
    providerUserId: string;
  }): Promise<BoundChannelIdentity | null>;
}

export interface ChannelControlReplyPortV1 {
  send(input: {
    installation: Readonly<ChannelInstallation>;
    target: string;
    text: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export class BrokerChannelTaskBridgeV1 {
  constructor(
    private readonly identityResolver: ChannelIdentityResolverV1,
    private readonly gateway: Pick<ChannelTaskControlGateway, 'handle'>,
    private readonly replies: ChannelControlReplyPortV1,
  ) {}

  async handle(
    installation: Readonly<ChannelInstallation>,
    message: Readonly<BrokerInboundChannelMessage>,
  ): Promise<'ack' | 'hold'> {
    let identity: BoundChannelIdentity | null;
    try {
      identity = await this.identityResolver.resolve({
        provider: installation.provider,
        installationId: installation.installationId,
        tenantId: installation.tenantId,
        providerUserId: message.userId,
      });
    } catch {
      return 'hold';
    }
    if (!identity?.active || !identity.canonicalUserId.trim()) return 'hold';

    const result = await this.gateway.handle(message.text, {
      provider: installation.provider,
      installationId: installation.installationId,
      tenantId: installation.tenantId,
      userId: identity.canonicalUserId,
      deviceId: message.deviceId,
      messageId: message.messageId,
      receivedAtMs: message.receivedAtMs,
      signatureVerified: true,
      installationConnected: true,
      identityBound: true,
      identityActive: true,
    });
    try {
      await this.replies.send({
        installation,
        target: message.userId,
        text: result.message,
        idempotencyKey: `channel-reply:${installation.provider}:${installation.installationId}:${message.messageId}`,
      });
      return 'ack';
    } catch {
      return 'hold';
    }
  }
}
