/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import type { RpaRun, RpaWorkflowV1 } from './contracts.js';
import { RpaRunner } from './runner.js';
import type { RpaDriver, RpaRunStore } from './ports.js';

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
  steps: [{ id: 'download', action: 'web.click', args: { selector: '#download' }, sideEffect: 'external' }],
};

describe('RpaRunner', () => {
  it('rejects workflows large enough to create unbounded resident work', () => {
    expect(() => new RpaRunner([{
      id: 'too-large',
      version: 1,
      steps: Array.from({ length: 101 }, (_, index) => ({
        id: `step-${index}`,
        action: 'checkpoint' as const,
        args: {},
        sideEffect: 'none' as const,
      })),
    }], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute: vi.fn() }, { put: vi.fn() })).toThrow('between 1 and 100 steps');
  });

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
    expect(completed).toMatchObject({ state: 'pending', receipts: [{ state: 'succeeded' }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('persists pause during an active step and resumes only after the step boundary', async () => {
    const store = memoryStore();
    let finish!: (value: { output: { downloaded: boolean } }) => void;
    const execute = vi.fn(() => new Promise<{ output: { downloaded: boolean } }>((resolve) => {
      finish = resolve;
    }));
    const runner = new RpaRunner([workflow], store, {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute }, { put: vi.fn() });
    const run = await runner.start(workflow.id);

    const running = runner.runNext(run.id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const requested = await runner.pause(run.id);
    finish({ output: { downloaded: true } });
    const paused = await running;
    const resumed = await runner.resume(run.id);
    const completed = await runner.runNext(run.id);

    expect(requested).toMatchObject({ state: 'running', pauseRequestedAt: expect.any(String) });
    expect(paused).toMatchObject({ state: 'paused', receipts: [{ state: 'succeeded' }] });
    expect(resumed).toMatchObject({ state: 'pending' });
    expect(completed).toMatchObject({ state: 'succeeded' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('persists cancellation during an active step and never starts another step', async () => {
    const store = memoryStore();
    let finish!: (value: { output: { downloaded: boolean } }) => void;
    const execute = vi.fn(() => new Promise<{ output: { downloaded: boolean } }>((resolve) => {
      finish = resolve;
    }));
    const runner = new RpaRunner([workflow], store, {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute }, { put: vi.fn() });
    const run = await runner.start(workflow.id);

    const running = runner.runNext(run.id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const requested = await runner.cancel(run.id);
    finish({ output: { downloaded: true } });
    const cancelled = await running;
    const afterCancel = await runner.runNext(run.id);

    expect(requested).toMatchObject({ state: 'running', cancelRequestedAt: expect.any(String) });
    expect(cancelled).toMatchObject({ state: 'cancelled', receipts: [{ state: 'succeeded' }] });
    expect(afterCancel).toMatchObject({ state: 'cancelled' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('marks an aborted external action unknown and never replays it', async () => {
    const store = memoryStore();
    let observedSignal: AbortSignal | undefined;
    const execute = vi.fn((input: Parameters<RpaDriver['execute']>[0]) => {
      observedSignal = input.signal;
      return new Promise<{ output: { downloaded: boolean } }>(() => {});
    });
    const runner = new RpaRunner([workflow], store, {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute }, { put: vi.fn() });
    const run = await runner.start(workflow.id);
    const controller = new AbortController();

    const running = runner.runNext(run.id, controller.signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(observedSignal).toBe(controller.signal);
    controller.abort();
    const interrupted = await running;
    const afterAbort = await runner.runNext(run.id);

    expect(interrupted).toMatchObject({
      state: 'unknown_outcome',
      receipts: [{ state: 'unknown_outcome', error: expect.stringContaining('reconciliation') }],
    });
    expect(afterAbort).toMatchObject({ state: 'unknown_outcome' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not claim or execute a step when already cancelled before run_next', async () => {
    const execute = vi.fn();
    const runner = new RpaRunner([workflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute }, { put: vi.fn() });
    const run = await runner.start(workflow.id);
    const controller = new AbortController();
    controller.abort();

    await expect(runner.runNext(run.id, controller.signal)).resolves.toMatchObject({
      state: 'pending',
      receipts: [{ state: 'pending', attempt: 0 }],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails a step whose persisted output exceeds the bounded run record', async () => {
    const runner = new RpaRunner([workflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, {
      execute: vi.fn().mockResolvedValue({ output: { text: 'x'.repeat(70 * 1024) } }),
    }, { put: vi.fn() });
    const run = await runner.start(workflow.id);

    await expect(runner.runNext(run.id)).resolves.toMatchObject({
      state: 'failed',
      receipts: [{ state: 'failed', error: expect.stringContaining('65536 bytes') }],
    });
  });

  it('rejects artifact floods before writing any artifact', async () => {
    const put = vi.fn();
    const artifacts = Array.from({ length: 11 }, () => ({
      mediaType: 'image/png', bytes: new Uint8Array([1]), redactedSummary: 'shot',
    }));
    const runner = new RpaRunner([workflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute: vi.fn().mockResolvedValue({ artifacts }) }, { put });
    const run = await runner.start(workflow.id);

    await expect(runner.runNext(run.id)).resolves.toMatchObject({
      state: 'failed',
      receipts: [{ state: 'failed', error: expect.stringContaining('more than 10 artifacts') }],
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('persists earlier evidence references when a later artifact write hits quota', async () => {
    const store = memoryStore();
    const put = vi.fn()
      .mockResolvedValueOnce({ id: 'artifact-1', sha256: 'a'.repeat(64), mediaType: 'image/png', redactedSummary: 'first' })
      .mockRejectedValueOnce(new Error('RPA artifact store exceeds its byte limit.'));
    const runner = new RpaRunner([workflow], store, {
      authorize: vi.fn().mockResolvedValue({ decision: 'allow' }),
    }, { execute: vi.fn().mockResolvedValue({ artifacts: [
      { mediaType: 'image/png', bytes: new Uint8Array([1]), redactedSummary: 'first' },
      { mediaType: 'image/png', bytes: new Uint8Array([2]), redactedSummary: 'second' },
    ] }) }, { put });
    const run = await runner.start(workflow.id);

    await expect(runner.runNext(run.id)).resolves.toMatchObject({
      state: 'failed',
      receipts: [{ state: 'failed', artifactIds: ['artifact-1'], error: expect.stringContaining('byte limit') }],
    });
  });
});
