/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Production composition boundary for QR-installed managed channels. Provider
 * adapters share one broker runtime, credential vault, outbound ledger,
 * identity resolver, workflow supervisor and message journal.
 */

import {
  ChannelPairingCoordinator,
  type ChannelConnectorV1,
  type ChannelPairingAuditEvent,
  type ChannelProvider,
} from './channelConnector.js';
import type { ChannelCredentialVaultV1 } from './channelCredentialVault.js';
import type { ChannelOutboundLedgerV1 } from './channelOutboundLedger.js';
import {
  BrokerChannelRuntimeV1,
  type BrokerChannelRuntimeOptions,
} from './brokerChannelRuntime.js';
import { BrokerChannelTaskBridgeV1 } from './brokerChannelTaskBridge.js';
import type { ChannelIdentityRegistryV1 } from './channelIdentityRegistry.js';
import {
  ChannelTaskControlGateway,
  type ChannelMessageDedupJournal,
  type ChannelTaskControlPolicy,
} from './channelTaskControl.js';
import { HttpChannelPairingBrokerV1 } from './httpChannelPairingBroker.js';
import { ManagedChannelConnectorV1 } from './managedChannelConnector.js';
import { ChannelWorkflowMilestoneNotifierV1 } from './channelWorkflowMilestones.js';
import { OfficialChannelRuntimeV1 } from './officialChannelRuntime.js';
import {
  DingTalkOfficialQrPairingBrokerV1,
  WeComOfficialQrPairingBrokerV1,
} from './officialQrPairingBrokers.js';
import {
  WorkflowTaskControlPort,
  type ChannelTaskProposalBackend,
  type WorkflowControlBackend,
} from './workflowTaskControlPort.js';

const PROVIDERS: readonly ChannelProvider[] = ['feishu', 'lark', 'wecom', 'dingtalk'];

export interface ManagedChannelPlatformOptions {
  brokerBaseUrl: string;
  pairingBearerToken: string;
  publicPairingOrigin: string;
  vault: ChannelCredentialVaultV1;
  outboundLedger: ChannelOutboundLedgerV1;
  identityRegistry: ChannelIdentityRegistryV1;
  workflowBackend: WorkflowControlBackend;
  proposalBackend: ChannelTaskProposalBackend;
  policy: ChannelTaskControlPolicy;
  journal: ChannelMessageDedupJournal;
  auditPairing: (event: Readonly<ChannelPairingAuditEvent>) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  createSocket?: BrokerChannelRuntimeOptions['createSocket'];
  now?: () => number;
  milestoneFilePath?: string;
  /** Disable only for deployments that intentionally route all providers through a managed Broker. */
  useOfficialProviderConnections?: boolean;
  providers?: readonly ChannelProvider[];
}

export interface ManagedChannelPlatformStartResult {
  installationId: string;
  provider: ChannelProvider;
  state: 'connected' | 'failed';
  message?: string;
}

export class ManagedChannelPlatformV1 {
  readonly connectors: Readonly<Partial<Record<ChannelProvider, ChannelConnectorV1>>>;
  private readonly managedConnectors: readonly ManagedChannelConnectorV1[];
  private readonly milestones: ChannelWorkflowMilestoneNotifierV1;

  constructor(private readonly options: ManagedChannelPlatformOptions) {
    const connectorMap: Partial<Record<ChannelProvider, ManagedChannelConnectorV1>> = {};
    const control = new ChannelTaskControlGateway(
      new WorkflowTaskControlPort(options.workflowBackend, options.proposalBackend),
      options.policy,
      options.journal,
      options.now,
    );
    const bridge = new BrokerChannelTaskBridgeV1(
      options.identityRegistry,
      control,
      {
        send: async ({ installation, target, text, idempotencyKey }) => {
          const connector = connectorMap[installation.provider];
          if (!connector) throw new Error('managed channel connector is unavailable');
          await connector.send(installation.installationId, { target, text, idempotencyKey });
        },
      },
    );
    const runtime = new BrokerChannelRuntimeV1({
      baseUrl: options.brokerBaseUrl,
      fetchImpl: options.fetchImpl,
      createSocket: options.createSocket,
      onInbound: (installation, message) => bridge.handle(installation, message),
    });
    const broker = new HttpChannelPairingBrokerV1({
      baseUrl: options.brokerBaseUrl,
      bearerToken: options.pairingBearerToken,
      fetchImpl: options.fetchImpl,
    });
    const coordinator = new ChannelPairingCoordinator({
      publicPairingOrigin: options.publicPairingOrigin,
      audit: options.auditPairing,
      now: options.now,
    });
    const officialRuntime = new OfficialChannelRuntimeV1({
      fetchImpl: options.fetchImpl,
      onInbound: (installation, message) => bridge.handle(installation, message),
    });
    const useOfficial = options.useOfficialProviderConnections !== false;
    const wecomBroker = new WeComOfficialQrPairingBrokerV1({ fetchImpl: options.fetchImpl });
    const dingtalkBroker = new DingTalkOfficialQrPairingBrokerV1({ fetchImpl: options.fetchImpl });
    const providers = options.providers ?? PROVIDERS;
    for (const provider of providers) {
      const isOfficialDirect = useOfficial && (provider === 'wecom' || provider === 'dingtalk');
      connectorMap[provider] = new ManagedChannelConnectorV1({
        provider,
        coordinator,
        vault: options.vault,
        runtime: isOfficialDirect ? officialRuntime : runtime,
        broker: provider === 'wecom' && useOfficial
          ? wecomBroker
          : provider === 'dingtalk' && useOfficial
            ? dingtalkBroker
            : broker,
        outboundLedger: options.outboundLedger,
      });
    }
    this.connectors = connectorMap;
    this.managedConnectors = Object.values(connectorMap);
    this.milestones = new ChannelWorkflowMilestoneNotifierV1(
      options.workflowBackend,
      {
        send: async ({ provider, installationId, target, text, idempotencyKey }) => {
          const connector = connectorMap[provider];
          if (!connector) throw new Error('managed channel connector is unavailable');
          await connector.send(installationId, { target, text, idempotencyKey });
        },
      },
      { ...(options.milestoneFilePath ? { filePath: options.milestoneFilePath } : {}) },
    );
  }

  milestoneInputVersion(): Promise<string | undefined> {
    return this.milestones.inputVersion();
  }

  flushMilestones(): Promise<void> {
    return this.milestones.flush();
  }

  async startInstalled(): Promise<ManagedChannelPlatformStartResult[]> {
    const results: ManagedChannelPlatformStartResult[] = [];
    for (const provider of Object.keys(this.connectors) as ChannelProvider[]) {
      const connector = this.connectors[provider];
      if (!connector) continue;
      for (const installation of connector.listInstallations()) {
        try {
          await connector.start(installation.installationId);
          results.push({ installationId: installation.installationId, provider, state: 'connected' });
        } catch (error) {
          results.push({
            installationId: installation.installationId,
            provider,
            state: 'failed',
            message: error instanceof Error ? error.message : 'managed channel start failed',
          });
        }
      }
    }
    return results;
  }

  async stopAll(): Promise<void> {
    const operations: Array<Promise<unknown>> = [];
    for (const provider of Object.keys(this.connectors) as ChannelProvider[]) {
      const connector = this.connectors[provider];
      if (!connector) continue;
      for (const installation of connector.listInstallations()) {
        operations.push(connector.stop(installation.installationId).catch(() => undefined));
      }
    }
    await Promise.all(operations);
    for (const connector of this.managedConnectors) connector.disposePendingPairings();
  }
}
