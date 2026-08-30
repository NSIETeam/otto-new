/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import type { ChannelTaskMessageContext } from './channelTaskControl.js';
import {
  channelApprovalPayloadHash,
  WorkflowTaskControlPort,
  type ControllableWorkflowRun,
  type WorkflowControlBackend,
} from './workflowTaskControlPort.js';

const context: ChannelTaskMessageContext = {
  provider: 'feishu',
  installationId: 'install-1',
  tenantId: 'tenant-1',
  providerUserId: 'provider-user-1',
  userId: 'user-1',
  deviceId: 'device-1',
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
  steps: [{
    stepId: 'send',
    status: 'waiting_approval',
    approvalId: 'approval-1',
    input: (() => {
      const origin = {
        provider: context.provider,
        installationId: context.installationId,
        tenantId: context.tenantId,
        providerUserId: context.providerUserId,
        userId: context.userId,
        deviceId: context.deviceId,
      };
      return {
      approvalExpiresAtMs: Number.MAX_SAFE_INTEGER,
      request: '执行每日巡检',
      origin,
      approvalPayloadHash: channelApprovalPayloadHash({
        request: '执行每日巡检', approvalExpiresAtMs: Number.MAX_SAFE_INTEGER, origin,
      }),
    }; })(),
  }],
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

  it('rejects approval when the persisted request changed after confirmation was issued', async () => {
    const control = backend();
    vi.mocked(control.list).mockResolvedValue([{
      ...run,
      steps: [{ ...run.steps[0]!, input: { ...run.steps[0]!.input, request: '被替换的请求' } }],
    }]);
    const port = new WorkflowTaskControlPort(control, { create: vi.fn() });

    await expect(port.approve('approval-1', 'idem-tampered', context))
      .rejects.toThrow('workflow approval payload has changed');
    expect(control.approve).not.toHaveBeenCalled();
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

  it('does not expose or mutate workflows owned by another channel identity', async () => {
    const control = backend();
    const port = new WorkflowTaskControlPort(control, { create: vi.fn() });
    const otherUser = { ...context, userId: 'user-2' };

    expect(await port.list(otherUser)).toEqual([]);
    expect(await port.status(run.id, otherUser)).toBeNull();
    await expect(port.pause(run.id, 'idem-pause', otherUser)).rejects.toThrow('workflow was not found');
    await expect(port.approve('approval-1', 'idem-approve', otherUser)).rejects.toThrow('workflow approval was not found');
    await expect(port.deny('approval-1', 'idem-deny', otherUser)).rejects.toThrow('workflow approval was not found');

    expect(control.pause).not.toHaveBeenCalled();
    expect(control.approve).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  });

  it('does not route a workflow to another Otto device for the same user', async () => {
    const control = backend();
    const port = new WorkflowTaskControlPort(control, { create: vi.fn() });
    const otherDevice = { ...context, deviceId: 'device-2' };

    expect(await port.status(run.id, otherDevice)).toBeNull();
    await expect(port.resume(run.id, 'idem-resume', otherDevice)).rejects.toThrow('workflow was not found');
    expect(control.resume).not.toHaveBeenCalled();
  });

  it('fails closed for local workflows without a persisted channel owner', async () => {
    const control = backend();
    vi.mocked(control.list).mockResolvedValue([{ ...run, steps: [{ stepId: 'send', status: 'queued', input: {} }] }]);
    vi.mocked(control.get).mockResolvedValue({ ...run, steps: [{ stepId: 'send', status: 'queued', input: {} }] });
    const port = new WorkflowTaskControlPort(control, { create: vi.fn() });

    expect(await port.list(context)).toEqual([]);
    expect(await port.status(run.id, context)).toBeNull();
    await expect(port.cancel(run.id, 'idem-cancel', context)).rejects.toThrow('workflow was not found');
    expect(control.cancel).not.toHaveBeenCalled();
  });
});
