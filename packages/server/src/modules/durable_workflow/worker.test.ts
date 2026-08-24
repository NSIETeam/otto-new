/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  DurableWorkflowExecutionError,
  type DurableWorkflowClaim,
  type DurableWorkflowQueueStore,
} from './contracts.js';
import { DurableWorkflowWorker } from './worker.js';

function claim(
  overrides: Partial<DurableWorkflowClaim> = {},
): DurableWorkflowClaim {
  return {
    mode: 'forward',
    runId: 'wf-00000000-0000-4000-8000-000000000001',
    organizationId: 'org-1',
    definitionId: 'monthly-report',
    stepId: 'compile',
    taskType: 'report.compile',
    input: {},
    sideEffect: 'none',
    attempt: 1,
    maxAttempts: 3,
    idempotencyKey: 'workflow-step-key',
    workerId: 'worker-1',
    leaseToken: 'lease-1',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function storeStub(
  nextClaim: DurableWorkflowClaim | null,
): DurableWorkflowQueueStore {
  let pending = nextClaim;
  return {
    createRun: vi.fn(),
    claimNext: vi.fn(async () => {
      const result = pending;
      pending = null;
      return result;
    }),
    renewLease: vi.fn().mockResolvedValue(true),
    succeedClaim: vi.fn().mockResolvedValue(undefined),
    failClaim: vi.fn().mockResolvedValue(undefined),
    recoverExpiredWork: vi.fn().mockResolvedValue(0),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    approve: vi.fn(),
    retryDeadLetter: vi.fn(),
    resolveUnknown: vi.fn(),
    requestCompensation: vi.fn(),
    cancel: vi.fn(),
  };
}

describe('DurableWorkflowWorker', () => {
  it('publishes a result only through the fenced queue claim', async () => {
    const store = storeStub(claim());
    const executor = {
      execute: vi.fn().mockResolvedValue({ reportId: 'r-1' }),
    };
    const worker = new DurableWorkflowWorker(store, executor, 'worker-1');

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: expect.objectContaining({ leaseToken: 'lease-1' }),
      }),
    );
    expect(store.succeedClaim).toHaveBeenCalledWith(
      expect.objectContaining({ output: { reportId: 'r-1' } }),
    );
  });

  it('preserves executor certainty when recording a failure', async () => {
    const store = storeStub(claim({ sideEffect: 'external' }));
    const executor = {
      execute: vi
        .fn()
        .mockRejectedValue(
          new DurableWorkflowExecutionError(
            'connection refused before send',
            'confirmed_not_started',
          ),
        ),
    };
    const worker = new DurableWorkflowWorker(store, executor, 'worker-1');

    await worker.runOnce();

    expect(store.failClaim).toHaveBeenCalledWith(
      expect.objectContaining({ certainty: 'confirmed_not_started' }),
    );
  });

  it('recovers expired work before accepting new claims on startup', async () => {
    const store = storeStub(null);
    vi.mocked(store.recoverExpiredWork)
      .mockResolvedValueOnce(4)
      .mockResolvedValue(0);
    const worker = new DurableWorkflowWorker(
      store,
      { execute: vi.fn() },
      'worker-1',
      { pollMs: 25 },
    );

    await worker.start();
    expect(store.recoverExpiredWork).toHaveBeenCalledWith({ limit: 500 });
    expect(worker.status()).toMatchObject({
      running: true,
      recoveredAtStartup: 4,
    });
    await worker.close();
  });

  it('keeps sweeping expired leases and approvals under continuous load', async () => {
    const store = storeStub(null);
    vi.mocked(store.claimNext).mockImplementation(async () => claim());
    const worker = new DurableWorkflowWorker(
      store,
      {
        execute: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { ok: true };
        }),
      },
      'worker-1',
      { concurrency: 1, pollMs: 25, recoverySweepMs: 100 },
    );

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 230));
    await worker.close();

    expect(store.recoverExpiredWork).toHaveBeenCalledWith({ limit: 500 });
    expect(store.recoverExpiredWork).toHaveBeenCalledWith({ limit: 100 });
    expect(vi.mocked(store.recoverExpiredWork).mock.calls.length).toBeGreaterThan(
      1,
    );
  });
});
