/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import type { RpaRun, RpaWorkflowV1 } from './contracts.js';
import { RpaRunner } from './runner.js';
import type { RpaRunStore } from './ports.js';

function memoryStore(): RpaRunStore {
  const runs = new Map<string, RpaRun>();
  return {
    async create(workflow) {
      const id = 'rpa-run-1';
      const timestamp = new Date().toISOString();
      const run: RpaRun = {
        id,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        workflow: structuredClone(workflow),
        state: 'pending',
        revision: 1,
        currentStepId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        receipts: workflow.steps.map((step) => ({
          stepId: step.id, attempt: 0, state: 'pending', idempotencyKey: `${id}:${step.id}:0`, artifactIds: [],
        })),
      };
      runs.set(id, run);
      return structuredClone(run);
    },
    async get(id) {
      const run = runs.get(id);
      return run ? structuredClone(run) : null;
    },
    async save(run, expectedRevision) {
      const current = runs.get(run.id);
      if (!current || current.revision !== expectedRevision) throw new Error('revision conflict');
      const next = structuredClone(run);
      next.revision += 1;
      next.updatedAt = new Date().toISOString();
      runs.set(next.id, next);
      return structuredClone(next);
    },
  };
}

const workflow: RpaWorkflowV1 = {
  id: 'download-report',
  version: 1,
  allowedHosts: ['example.com'],
  steps: [{ id: 'download', action: 'web.click', args: { selector: '#download' }, sideEffect: 'external' }],
};

describe('RpaRunner', () => {
  it('does not invoke the driver when policy denies an action', async () => {
    const execute = vi.fn();
    const runner = new RpaRunner([workflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'approval required' }),
    }, { execute }, { put: vi.fn() });
    const run = await runner.start(workflow.id);

    const result = await runner.runNext(run.id);

    expect(result).toMatchObject({ state: 'failed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('records evidence and never replays an interrupted external action', async () => {
    const store = memoryStore();
    const execute = vi.fn().mockResolvedValue({ output: { downloaded: true } });
    const runner = new RpaRunner([workflow], store, { authorize: vi.fn().mockResolvedValue({ decision: 'allow' }) }, { execute }, {
      put: vi.fn().mockResolvedValue({ id: 'artifact-1', sha256: 'a'.repeat(64), mediaType: 'image/png', redactedSummary: 'page screenshot' }),
    });
    const run = await runner.start(workflow.id);
    const claimed = await store.get(run.id);
    claimed!.state = 'running';
    claimed!.currentStepId = 'download';
    claimed!.receipts[0].state = 'started';
    claimed!.receipts[0].attempt = 1;
    await store.save(claimed!, claimed!.revision);

    const recovered = await runner.recover(run.id);
    const afterResume = await runner.runNext(run.id);

    expect(recovered).toMatchObject({ state: 'unknown_outcome' });
    expect(afterResume).toMatchObject({ state: 'unknown_outcome' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a matching human approval before resuming a paused step', async () => {
    const store = memoryStore();
    const authorize = vi.fn()
      .mockResolvedValueOnce({ decision: 'awaiting_approval', approvalId: 'approval-1' })
      .mockResolvedValueOnce({ decision: 'allow' });
    const execute = vi.fn().mockResolvedValue({ output: { downloaded: true } });
    const runner = new RpaRunner([workflow], store, { authorize }, { execute }, { put: vi.fn() });
    const run = await runner.start(workflow.id);

    const waiting = await runner.runNext(run.id);
    await expect(runner.approve(run.id, 'wrong')).rejects.toThrow('not waiting');
    const approved = await runner.approve(run.id, 'approval-1');
    const completed = await runner.runNext(run.id);

    expect(waiting).toMatchObject({ state: 'awaiting_approval' });
    expect(approved?.receipts[0]).toMatchObject({ approvalId: 'approval-1' });
    expect(completed).toMatchObject({ state: 'succeeded', receipts: [{ state: 'succeeded' }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('cancels a resumable run and releases its run-scoped resources', async () => {
    const closeRun = vi.fn();
    const runner = new RpaRunner([workflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute: vi.fn(), closeRun }, { put: vi.fn() });
    const run = await runner.start(workflow.id);

    const cancelled = await runner.cancel(run.id);

    expect(cancelled).toMatchObject({ state: 'cancelled', currentStepId: null });
    expect(closeRun).toHaveBeenCalledWith(run.id);
    expect(await runner.runNext(run.id)).toMatchObject({ state: 'cancelled' });
  });

  it('does not allow cancellation to hide an unknown external outcome', async () => {
    const store = memoryStore();
    const runner = new RpaRunner([workflow], store, {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute: vi.fn() }, { put: vi.fn() });
    const run = await runner.start(workflow.id);
    const interrupted = await store.get(run.id);
    interrupted!.state = 'running';
    interrupted!.currentStepId = 'download';
    interrupted!.receipts[0].state = 'started';
    await store.save(interrupted!, interrupted!.revision);
    await runner.recover(run.id);

    await expect(runner.cancel(run.id)).rejects.toThrow('human reconciliation');
  });

  it('passes cancellation through to the driver and closes resources after completion', async () => {
    const safeWorkflow: RpaWorkflowV1 = {
      id: 'read-report', version: 1,
      allowedHosts: ['example.com'],
      steps: [{ id: 'read', action: 'web.extract', args: { selector: '#report' }, sideEffect: 'none' }],
    };
    const execute = vi.fn().mockResolvedValue({ output: { text: 'done' } });
    const closeRun = vi.fn();
    const runner = new RpaRunner([safeWorkflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute, closeRun }, { put: vi.fn() });
    const run = await runner.start(safeWorkflow.id);
    const controller = new AbortController();

    const completed = await runner.runNext(run.id, controller.signal);

    expect(completed).toMatchObject({ state: 'succeeded' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(closeRun).toHaveBeenCalledWith(run.id);
  });

  it('runs safe steps until completion and supports an explicit human pause and resume', async () => {
    const safeWorkflow: RpaWorkflowV1 = {
      id: 'two-steps', version: 1, allowedHosts: ['example.com'],
      steps: [
        { id: 'one', action: 'checkpoint', args: {}, sideEffect: 'none' },
        { id: 'two', action: 'checkpoint', args: {}, sideEffect: 'none' },
      ],
    };
    const execute = vi.fn().mockResolvedValue({ output: {} });
    const closeRun = vi.fn();
    const runner = new RpaRunner([safeWorkflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute, closeRun }, { put: vi.fn() });
    const run = await runner.start(safeWorkflow.id);

    const paused = await runner.pause(run.id, 'Solve captcha');
    const resumed = await runner.resume(run.id);
    const completed = await runner.runUntilBlocked(run.id);

    expect(paused).toMatchObject({ state: 'paused', takeoverNote: 'Solve captcha' });
    expect(resumed).toMatchObject({ state: 'pending', takeoverNote: undefined });
    expect(completed).toMatchObject({ state: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('records cancellation without replaying an in-flight step', async () => {
    const safeWorkflow: RpaWorkflowV1 = {
      id: 'cancel-safe', version: 1, allowedHosts: ['example.com'],
      steps: [{ id: 'wait', action: 'web.wait', args: { selector: '#done' }, sideEffect: 'none' }],
    };
    const controller = new AbortController();
    const execute = vi.fn().mockImplementation(async () => {
      controller.abort(new Error('cancelled'));
      throw controller.signal.reason;
    });
    const closeRun = vi.fn();
    const runner = new RpaRunner([safeWorkflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute, closeRun }, { put: vi.fn() });
    const run = await runner.start(safeWorkflow.id);

    const cancelled = await runner.runNext(run.id, controller.signal);

    expect(cancelled).toMatchObject({ state: 'cancelled', receipts: [{ state: 'failed', error: 'Execution was cancelled by the user.' }] });
    expect(closeRun).toHaveBeenCalledWith(run.id);
  });
});
