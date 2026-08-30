/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelWorkflowMilestoneNotifierV1 } from './channelWorkflowMilestones.js';
import type { ControllableWorkflowRun, WorkflowControlBackend } from './workflowTaskControlPort.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function run(status: string, updatedAt: string): ControllableWorkflowRun {
  return {
    id: 'wf-00000000-0000-0000-0000-000000000001',
    definitionId: 'sales-inspection', status, updatedAt,
    steps: [{ stepId: 'execute', status, input: { origin: {
      provider: 'lark', installationId: 'install-1', tenantId: 'tenant-1',
      providerUserId: 'provider-user-1', userId: 'user-1', deviceId: 'device-1',
    } } }],
  };
}

function harness(initial: ControllableWorkflowRun) {
  let current = initial;
  const backend = { list: vi.fn(async () => [current]) } as unknown as WorkflowControlBackend;
  const sender = { send: vi.fn(async () => undefined) };
  const root = mkdtempSync(path.join(os.tmpdir(), 'otto-channel-milestones-'));
  roots.push(root);
  const filePath = path.join(root, 'journal.json');
  return { backend, sender, filePath, set: (next: ControllableWorkflowRun) => { current = next; } };
}

describe('ChannelWorkflowMilestoneNotifierV1', () => {
  it('emits only meaningful state changes and survives restart without duplicates', async () => {
    const h = harness(run('waiting_approval', '2026-08-30T00:00:00.000Z'));
    const first = new ChannelWorkflowMilestoneNotifierV1(h.backend, h.sender, { filePath: h.filePath });
    await first.flush();
    expect(h.sender.send).not.toHaveBeenCalled();

    h.set(run('running', '2026-08-30T00:01:00.000Z'));
    await first.flush();
    await first.flush();
    expect(h.sender.send).toHaveBeenCalledOnce();
    expect(h.sender.send).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 'install-1', target: 'provider-user-1', text: 'sales-inspection：正在执行',
      idempotencyKey: expect.stringMatching(/^channel-milestone:[a-f0-9]{32}$/),
    }));

    h.set(run('running', '2026-08-30T00:01:30.000Z'));
    await first.flush();
    expect(h.sender.send).toHaveBeenCalledOnce();

    const restarted = new ChannelWorkflowMilestoneNotifierV1(h.backend, h.sender, { filePath: h.filePath });
    await restarted.flush();
    expect(h.sender.send).toHaveBeenCalledOnce();
  });

  it('does not advance its cursor when delivery fails and retries the identical write', async () => {
    const h = harness(run('failed', '2026-08-30T00:02:00.000Z'));
    h.sender.send.mockRejectedValueOnce(new Error('offline'));
    const notifier = new ChannelWorkflowMilestoneNotifierV1(h.backend, h.sender, { filePath: h.filePath });

    await expect(notifier.flush()).rejects.toThrow('offline');
    await notifier.flush();
    expect(h.sender.send).toHaveBeenCalledTimes(2);
    expect(h.sender.send.mock.calls[0]?.[0].idempotencyKey)
      .toBe(h.sender.send.mock.calls[1]?.[0].idempotencyKey);
  });

  it('ignores local workflows that have no complete persisted channel origin', async () => {
    const local = run('succeeded', '2026-08-30T00:03:00.000Z');
    local.steps[0]!.input = {};
    const h = harness(local);
    const notifier = new ChannelWorkflowMilestoneNotifierV1(h.backend, h.sender, { filePath: h.filePath });
    expect(await notifier.inputVersion()).toBeUndefined();
    await notifier.flush();
    expect(h.sender.send).not.toHaveBeenCalled();
  });
});
