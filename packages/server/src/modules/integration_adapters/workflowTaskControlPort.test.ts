/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import type { ChannelTaskMessageContext } from './channelTaskControl.js';
import {
  WorkflowTaskControlPort,
  type ControllableWorkflowRun,
  type WorkflowControlBackend,
} from './workflowTaskControlPort.js';

const context: ChannelTaskMessageContext = {
  provider: 'feishu',
  installationId: 'install-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  messageId: 'message-1',
  receivedAtMs: Date.now(),
  signatureVerified: true,
  installationConnected: true,
  identityBound: true,
  identityActive: true,
};

const run: ControllableWorkflowRun = {
  id: 'wf-00000000-0000-0000-0000-000000000001',
  definitionId: 'daily-inspection',
  status: 'waiting_approval',
  updatedAt: '2026-08-29T10:00:00.000Z',
  steps: [{ stepId: 'send', status: 'waiting_approval', approvalId: 'approval-1' }],
};

function backend(): WorkflowControlBackend {
  return {
    list: vi.fn(async () => [run]),
    get: vi.fn(async () => run),
    pause: vi.fn(async () => ({ ...run, status: 'paused' })),
    resume: vi.fn(async () => ({ ...run, status: 'queued' })),
    cancel: vi.fn(async () => ({ ...run, status: 'cancelled' })),
    takeOver: vi.fn(async () => ({ ...run, status: 'cancelled' })),
    approve: vi.fn(async () => ({ ...run, status: 'queued' })),
  };
}

describe('WorkflowTaskControlPort', () => {
  it('maps durable workflow state without exposing step inputs or outputs', async () => {
    const port = new WorkflowTaskControlPort(backend(), { create: vi.fn() });
    expect(await port.list(context)).toEqual([{
      taskId: run.id,
      title: 'daily-inspection',
      state: 'waiting_approval',
      updatedAtMs: Date.parse(run.updatedAt),
    }]);
  });

  it('routes approval by the persisted approval id and denial to cancellation', async () => {
    const control = backend();
    const port = new WorkflowTaskControlPort(control, { create: vi.fn() });

    expect(await port.approve('approval-1', 'idem-1', context)).toMatchObject({ state: 'queued' });
    expect(control.approve).toHaveBeenCalledWith(run.id, 'send', 'approval-1');
    await port.deny('approval-1', 'idem-2', context);
    expect(control.cancel).toHaveBeenCalledWith(run.id);
  });

  it('keeps natural language in an approval-required proposal backend', async () => {
    const create = vi.fn(async () => ({
      proposalId: 'proposal-1',
      preview: '待确认：执行每日巡检',
      requiresApproval: true as const,
    }));
    const port = new WorkflowTaskControlPort(backend(), { create });

    expect(await port.propose('执行每日巡检', 'idem-3', context)).toMatchObject({
      proposalId: 'proposal-1',
      requiresApproval: true,
    });
    expect(create).toHaveBeenCalledWith({ request: '执行每日巡检', idempotencyKey: 'idem-3', context });
  });
});
