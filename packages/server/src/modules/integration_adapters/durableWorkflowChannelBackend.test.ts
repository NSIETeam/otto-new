/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileWorkflowStore,
  ResidentWorkflowSupervisor,
  WorkflowRuntime,
} from 'otto-workflow';
import {
  DurableChannelTaskProposalBackendV1,
  ResidentWorkflowControlBackendV1,
  WorkflowTaskControlPort,
} from './workflowTaskControlPort.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const context = {
  provider: 'lark' as const,
  installationId: 'channel_lark_0123456789abcdef01234567',
  tenantId: 'tenant-1', userId: 'otto-user-1', messageId: 'message-1',
  deviceId: 'device-1',
  receivedAtMs: 2_000, signatureVerified: true, installationConnected: true,
  identityBound: true, identityActive: true,
};

describe('durable channel workflow adapters', () => {
  it('persists a proposal, exposes its real approval and executes only after approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-channel-workflow-'));
    roots.push(root);
    const store = new FileWorkflowStore(root);
    const execute = vi.fn(async () => ({ completed: true }));
    const runtime = new WorkflowRuntime(store, { execute });
    const supervisor = new ResidentWorkflowSupervisor(store, runtime, { maxConcurrentRuns: 1 });
    const proposals = new DurableChannelTaskProposalBackendV1(runtime);
    const control = new WorkflowTaskControlPort(
      new ResidentWorkflowControlBackendV1(supervisor),
      proposals,
    );
    const proposal = await control.propose(
      '巡检销售后台并汇报异常',
      'channel:lark:installation-1:message-1',
      context,
    );
    expect(proposal).toMatchObject({ requiresApproval: true });
    expect(proposal.preview).toContain('/approve approval-');
    expect(execute).not.toHaveBeenCalled();
    const waiting = await supervisor.get(proposal.proposalId);
    expect(waiting).toMatchObject({
      status: 'waiting_approval',
      steps: [expect.objectContaining({
        sideEffect: 'external',
        input: expect.objectContaining({
          request: '巡检销售后台并汇报异常',
          origin: expect.objectContaining({ tenantId: 'tenant-1', userId: 'otto-user-1', deviceId: 'device-1' }),
        }),
      })],
    });
    const approvalId = waiting!.steps[0].approvalId!;
    await control.approve(approvalId, 'approval-message-key', context);
    expect(execute).not.toHaveBeenCalled();
    await supervisor.tick();
    expect(execute).toHaveBeenCalledOnce();
    expect(await supervisor.get(proposal.proposalId)).toMatchObject({ status: 'succeeded' });

    const restored = new FileWorkflowStore(root);
    expect(await restored.getRun(proposal.proposalId)).toMatchObject({ status: 'succeeded' });
  });
});
