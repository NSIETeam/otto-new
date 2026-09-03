/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Desktop/CLI composition for official direct channels. The channel adapter
 * stays outside the kernel while all remote work is persisted, approval-gated
 * and driven by the shared resident workflow supervisor.
 */

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  FileWorkflowStore,
  FileWorkflowTraceSink,
  ResidentWorkflowSupervisor,
  WorkflowRuntime,
  type ClaimedWorkflowStep,
} from 'otto-workflow';
import {
  FileKeyChannelCredentialProtectorV1,
  JsonChannelCredentialVaultV1,
} from './channelCredentialVault.js';
import type { ChannelIdentityRegistryV1 } from './channelIdentityRegistry.js';
import { JsonChannelMessageDedupJournal } from './jsonChannelMessageJournal.js';
import { JsonChannelOutboundLedgerV1 } from './channelOutboundLedger.js';
import { ManagedChannelPlatformV1 } from './managedChannelPlatform.js';
import {
  DurableChannelTaskProposalBackendV1,
  ResidentWorkflowControlBackendV1,
} from './workflowTaskControlPort.js';

export interface LocalOfficialChannelPlatformBundle {
  platform: ManagedChannelPlatformV1;
  supervisor: ResidentWorkflowSupervisor;
  workflowBackend: ResidentWorkflowControlBackendV1;
  proposalBackend: DurableChannelTaskProposalBackendV1;
}

export function createLocalOfficialChannelPlatform(input: {
  userDirectory: string;
  identityRegistry: ChannelIdentityRegistryV1;
  executeWorkflowStep: (input: ClaimedWorkflowStep) => Promise<unknown>;
}): LocalOfficialChannelPlatformBundle {
  const workflowRoot = path.join(input.userDirectory, 'durable-workflows');
  const workflowStore = new FileWorkflowStore(path.join(workflowRoot, 'runs'));
  const workflowRuntime = new WorkflowRuntime(
    workflowStore,
    { execute: input.executeWorkflowStep },
    new FileWorkflowTraceSink(path.join(workflowRoot, 'traces')),
  );
  const supervisor = new ResidentWorkflowSupervisor(
    workflowStore,
    workflowRuntime,
    { maxConcurrentRuns: 2 },
  );
  const workflowBackend = new ResidentWorkflowControlBackendV1(supervisor);
  const proposalBackend = new DurableChannelTaskProposalBackendV1(workflowRuntime);

  const platform = new ManagedChannelPlatformV1({
    providers: ['wecom', 'dingtalk'],
    useOfficialProviderConnections: true,
    // Official direct providers do not use these broker values. Keep them
    // syntactically valid so a future provider cannot silently become active.
    brokerBaseUrl: 'https://connect.clawmaster.local',
    pairingBearerToken: randomBytes(32).toString('base64url'),
    publicPairingOrigin: 'https://connect.clawmaster.local/channel/pair',
    vault: new JsonChannelCredentialVaultV1(
      path.join(input.userDirectory, 'channel-credentials.json'),
      new FileKeyChannelCredentialProtectorV1(
        path.join(input.userDirectory, 'channel-credentials-key'),
      ),
    ),
    outboundLedger: new JsonChannelOutboundLedgerV1(
      path.join(input.userDirectory, 'channel-outbound-ledger.json'),
    ),
    identityRegistry: input.identityRegistry,
    workflowBackend,
    proposalBackend,
    // The gateway has already required a connected installation, a current
    // active identity binding and a fresh signed provider message. Mutations
    // remain explicit slash commands; free text can only create an approval.
    policy: { authorize: async () => ({ allowed: true as const }) },
    journal: new JsonChannelMessageDedupJournal({
      filePath: path.join(input.userDirectory, 'channel-task-message-journal.json'),
    }),
    milestoneFilePath: path.join(
      input.userDirectory,
      'channel-workflow-milestones.json',
    ),
    auditPairing: async (event) => {
      await mkdir(input.userDirectory, { recursive: true, mode: 0o700 });
      await appendFile(
        path.join(input.userDirectory, 'channel-pairing-audit.jsonl'),
        `${JSON.stringify(event)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    },
  });

  return { platform, supervisor, workflowBackend, proposalBackend };
}
