/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonChannelIdentityRegistryV1 } from './channelIdentityRegistry.js';
import { createLocalOfficialChannelPlatform } from './localOfficialChannelPlatform.js';
import { WorkflowTaskControlPort } from './workflowTaskControlPort.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local official channel product composition', () => {
  it('persists free-text work and executes it only after the bound user approves', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-local-channel-'));
    roots.push(root);
    const executeWorkflowStep = vi.fn(async () => ({ sessionId: 'session-1' }));
    const bundle = createLocalOfficialChannelPlatform({
      userDirectory: root,
      identityRegistry: new JsonChannelIdentityRegistryV1({
        filePath: path.join(root, 'channel-identities.json'),
        audit: async () => {},
      }),
      executeWorkflowStep,
    });
    const control = new WorkflowTaskControlPort(
      bundle.workflowBackend,
      bundle.proposalBackend,
      () => 10_000,
    );
    const context = {
      provider: 'wecom' as const,
      installationId: 'channel_wecom_0123456789abcdef01234567',
      tenantId: 'tenant-1',
      providerUserId: 'provider-user-1',
      userId: 'otto-user-1',
      deviceId: 'device-1',
      messageId: 'message-1',
      receivedAtMs: 10_000,
      signatureVerified: true,
      installationConnected: true,
      identityBound: true,
      identityActive: true,
    };

    const proposal = await control.propose(
      '检查本机任务并汇报异常',
      'channel:wecom:installation-1:message-1',
      context,
    );
    expect(executeWorkflowStep).not.toHaveBeenCalled();
    const waiting = await bundle.supervisor.get(proposal.proposalId);
    expect(waiting?.status).toBe('waiting_approval');

    await control.approve(waiting!.steps[0].approvalId!, 'approval-key', context);
    await bundle.supervisor.tick();

    expect(executeWorkflowStep).toHaveBeenCalledOnce();
    expect(await bundle.supervisor.get(proposal.proposalId)).toMatchObject({
      status: 'succeeded',
    });
  });
});
