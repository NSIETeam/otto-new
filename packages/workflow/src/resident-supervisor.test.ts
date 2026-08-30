/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileWorkflowStore } from './file-workflow-store.js';
import { ResidentWorkflowSupervisor } from './resident-supervisor.js';
import { WorkflowRuntime } from './runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(execute: (stepId: string) => Promise<unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'otto-resident-workflow-'));
  roots.push(root);
  const store = new FileWorkflowStore(root);
  const runtime = new WorkflowRuntime(store, {
    execute: ({ step }) => execute(step.stepId),
  });
  const supervisor = new ResidentWorkflowSupervisor(store, runtime, { maxConcurrentRuns: 1 });
  const run = await runtime.start({
    id: 'long-report',
    version: 1,
    steps: [
      { id: 'collect', kind: 'tool', input: {}, sideEffect: 'none' },
      { id: 'summarize', kind: 'agent', input: {}, sideEffect: 'none' },
    ],
  });
  return { store, runtime, supervisor, run };
}

describe('ResidentWorkflowSupervisor', () => {
  it('pauses only after the active step completes, then resumes from the next persisted step', async () => {
    let release!: () => void;
    const firstStep = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (stepId: string) => {
      if (stepId === 'collect') await firstStep;
      return { stepId };
    });
    const { supervisor, run } = await setup(execute);

    const ticking = supervisor.tick();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith('collect'));
    const requested = await supervisor.pause(run.id);
    expect(requested).toMatchObject({ status: 'running', pauseRequestedAt: expect.any(String) });
    release();
    await ticking;

    expect(await supervisor.get(run.id)).toMatchObject({ status: 'paused' });
    await supervisor.resume(run.id);
    await supervisor.tick();
    expect(await supervisor.get(run.id)).toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('records cancellation during an active step and never starts remaining work', async () => {
    let release!: () => void;
    const firstStep = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await firstStep;
      return { done: true };
    });
    const { supervisor, run } = await setup(execute);

    const ticking = supervisor.tick();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(await supervisor.cancel(run.id)).toMatchObject({
      status: 'running',
      cancelRequestedAt: expect.any(String),
    });
    release();
    await ticking;

    expect(await supervisor.get(run.id)).toMatchObject({
      status: 'cancelled',
      steps: [
        expect.objectContaining({ stepId: 'collect', status: 'succeeded' }),
        expect.objectContaining({ stepId: 'summarize', status: 'cancelled' }),
      ],
    });
    await supervisor.tick();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('exposes a stable input version only while runnable work exists', async () => {
    const { supervisor } = await setup(async () => ({ ok: true }));
    expect(await supervisor.inputVersion()).toMatch(/^wf-/u);
    await supervisor.tick();
    expect(await supervisor.inputVersion()).toMatch(/^wf-/u);
    await supervisor.tick();
    expect(await supervisor.inputVersion()).toBeUndefined();
  });

  it('records approval through the supervisor before executing protected work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-resident-workflow-approval-'));
    roots.push(root);
    const store = new FileWorkflowStore(root);
    const execute = vi.fn(async () => ({ ok: true }));
    const runtime = new WorkflowRuntime(store, { execute });
    const supervisor = new ResidentWorkflowSupervisor(store, runtime);
    const run = await runtime.start({
      id: 'remote-proposal', version: 1,
      steps: [{
        id: 'execute', kind: 'agent', input: { request: '巡检日报' },
        sideEffect: 'none', requiresApproval: true,
      }],
    });
    await supervisor.tick();
    const waiting = await supervisor.get(run.id);
    const approvalId = waiting!.steps[0].approvalId!;
    expect(waiting).toMatchObject({ status: 'waiting_approval' });
    expect(execute).not.toHaveBeenCalled();
    await supervisor.approve(run.id, 'execute', approvalId);
    await supervisor.tick();
    expect(await supervisor.get(run.id)).toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledOnce();
  });
});
