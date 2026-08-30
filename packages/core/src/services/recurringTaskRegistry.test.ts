/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryRecurringTaskStateStore,
  RecurringTaskRegistry,
  type RecurringTaskState,
  type RecurringTaskStateStore,
} from './recurringTaskRegistry.js';

afterEach(() => vi.useRealTimers());

describe('RecurringTaskRegistry', () => {
  it('records ownership, cadence, cost and a stop function', () => {
    const registry = new RecurringTaskRegistry();
    registry.register({
      name: 'local-index',
      source: 'test',
      intervalMs: 60_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run: vi.fn(),
    });

    expect(registry.list()).toMatchObject([
      {
        name: 'local-index',
        source: 'test',
        intervalMs: 60_000,
        estimatedCostUsdPerRun: 0,
        paid: false,
        inputVersion: 'v1',
        stop: expect.any(Function),
      },
    ]);
    registry.stopAll();
  });

  it('keeps paid background work disabled unless explicitly enabled', () => {
    const registry = new RecurringTaskRegistry();
    const stop = registry.register({
      name: 'model-analysis',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0.01,
      getInputVersion: () => 'v1',
      run: vi.fn(),
    });

    expect(stop).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('does not rerun unchanged input and never overlaps executions', async () => {
    vi.useFakeTimers();
    let version = 'v1';
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const registry = new RecurringTaskRegistry({ allowPaidBackground: true });
    registry.register({
      name: 'analysis',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0.01,
      getInputVersion: () => version,
      run,
    });

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5_000);
    expect(run).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    version = 'v2';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    registry.stopAll();
  });

  it('restores completed input versions and skips unchanged work after restart', async () => {
    vi.useFakeTimers();
    const store = new InMemoryRecurringTaskStateStore();
    const firstRun = vi.fn();
    const first = new RecurringTaskRegistry({ stateStore: store });
    first.register({
      name: 'durable-index',
      source: 'test',
      definitionVersion: 2,
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'content-v1',
      run: firstRun,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstRun).toHaveBeenCalledOnce();
    first.stopAll();

    const restoredRun = vi.fn();
    const restored = new RecurringTaskRegistry({ stateStore: store });
    restored.register({
      name: 'durable-index',
      source: 'test',
      definitionVersion: 2,
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'content-v1',
      run: restoredRun,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restoredRun).not.toHaveBeenCalled();
    expect(restored.list()[0]?.lastCompletedInputVersion).toBe('content-v1');
    restored.stopAll();
  });

  it('runs one missed occurrence only when the task explicitly requests it', async () => {
    vi.useFakeTimers();
    const store = new InMemoryRecurringTaskStateStore();
    store.put({
      name: 'reconcile',
      source: 'test',
      definitionVersion: 1,
      nextRunAtMs: Date.now() - 60_000,
      updatedAtMs: Date.now() - 60_000,
    });
    const run = vi.fn();
    const registry = new RecurringTaskRegistry({ stateStore: store });
    registry.register({
      name: 'reconcile',
      source: 'test',
      intervalMs: 60_000,
      missedRunPolicy: 'run-once',
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    registry.stopAll();
  });

  it('resets stale completion state when source or definition version changes', () => {
    const store = new InMemoryRecurringTaskStateStore();
    store.put({
      name: 'index',
      source: 'old-source',
      definitionVersion: 1,
      lastCompletedInputVersion: 'old-input',
      nextRunAtMs: 1,
      updatedAtMs: 1,
    });
    const registry = new RecurringTaskRegistry({ stateStore: store });
    registry.register({
      name: 'index',
      source: 'new-source',
      definitionVersion: 2,
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'old-input',
      run: vi.fn(),
    });
    expect(registry.list()[0]?.lastCompletedInputVersion).toBeUndefined();
    registry.stopAll();
  });

  it('awaits asynchronous input versions and still skips unchanged work', async () => {
    vi.useFakeTimers();
    let version: string | undefined = 'workflow:1';
    const run = vi.fn();
    const registry = new RecurringTaskRegistry();
    registry.register({
      name: 'durable-workflow',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: async () => version,
      run,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    version = 'workflow:2';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    version = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    registry.stopAll();
  });

  it('reports a rejected input-version read and retries on the next cadence', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let reads = 0;
    const run = vi.fn();
    const registry = new RecurringTaskRegistry({
      onError: (_taskName, error) => errors.push(error),
    });
    registry.register({
      name: 'recovering-input',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => {
        reads += 1;
        if (reads === 1) return 'initial';
        if (reads === 2)
          return Promise.reject(new Error('temporary read failure'));
        return 'changed';
      },
      run,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    await registry.shutdown();
  });

  it('fails shutdown when an accepted effect cannot be completion-checkpointed', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const store: RecurringTaskStateStore = {
      get: () => undefined,
      put: (_state: RecurringTaskState) => {
        throw new Error('disk unavailable');
      },
    };
    const run = vi.fn();
    const registry = new RecurringTaskRegistry({
      stateStore: store,
      onError: (_taskName, error) => errors.push(error),
    });
    registry.register({
      name: 'flaky-state-store',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const shutdown = registry.shutdown({ timeoutMs: 500 });
    const assertion = expect(shutdown).rejects.toThrow(
      /failed completion checkpoint/u,
    );
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('recovers a transient completion checkpoint during shutdown without replaying the effect', async () => {
    vi.useFakeTimers();
    let remainingCheckpointFailures = 1;
    let saved: RecurringTaskState | undefined;
    const store: RecurringTaskStateStore = {
      get: () => undefined,
      put: (state) => {
        if (
          state.lastCompletedInputVersion &&
          remainingCheckpointFailures > 0
        ) {
          remainingCheckpointFailures -= 1;
          throw new Error('transient checkpoint failure');
        }
        saved = { ...state };
      },
    };
    const run = vi.fn();
    const registry = new RecurringTaskRegistry({ stateStore: store });
    registry.register({
      name: 'shutdown-checkpoint-recovery',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    await registry.shutdown({ timeoutMs: 500 });
    expect(run).toHaveBeenCalledOnce();
    expect(saved?.lastCompletedInputVersion).toBe('v1');
  });

  it('retries only a failed completion checkpoint and never replays the effect', async () => {
    vi.useFakeTimers();
    let checkpointAvailable = false;
    let saved: RecurringTaskState | undefined;
    const store: RecurringTaskStateStore = {
      get: () => undefined,
      put: (state) => {
        if (state.lastCompletedInputVersion && !checkpointAvailable) {
          throw new Error('checkpoint disk unavailable');
        }
        saved = { ...state };
      },
    };
    const run = vi.fn();
    const registry = new RecurringTaskRegistry({ stateStore: store });
    registry.register({
      name: 'recovering-checkpoint',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    checkpointAvailable = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    expect(saved?.lastCompletedInputVersion).toBe('v1');
    await registry.shutdown();
  });

  it('does not start or reschedule a run after stop while input evaluation is pending', async () => {
    vi.useFakeTimers();
    let release!: (version: string) => void;
    let reads = 0;
    const run = vi.fn();
    const registry = new RecurringTaskRegistry();
    registry.register({
      name: 'pending-input',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => {
        reads += 1;
        if (reads === 1) return 'initial';
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      run,
    });

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    const shutdown = registry.shutdown({ timeoutMs: 5_000 });
    release('changed');
    await shutdown;
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('drains a pending asynchronous initial getter without post-stop mutation', async () => {
    let release!: (version: string) => void;
    const run = vi.fn();
    const registry = new RecurringTaskRegistry();
    registry.register({
      name: 'pending-initial-input',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      run,
    });
    const task = registry.list()[0]!;
    let drained = false;
    const shutdown = registry.shutdown({ timeoutMs: 5_000 }).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(task.phase).toBe('stopping');
    release('late-version');
    await shutdown;
    expect(task.inputVersion).toBeUndefined();
    expect(task.phase).toBe('stopped');
    expect(run).not.toHaveBeenCalled();
  });

  it('drains an in-flight run and checkpoints it before shutdown resolves', async () => {
    vi.useFakeTimers();
    const store = new InMemoryRecurringTaskStateStore();
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const registry = new RecurringTaskRegistry({ stateStore: store });
    registry.register({
      name: 'external-write',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run,
    });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    let drained = false;
    const shutdown = registry.shutdown({ timeoutMs: 5_000 }).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await shutdown;
    expect(drained).toBe(true);
    expect(store.get('external-write')?.lastCompletedInputVersion).toBe('v1');
    expect(registry.list()).toEqual([]);
  });

  it('reserves a stopped task name until its in-flight run has drained', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const registry = new RecurringTaskRegistry();
    const definition = {
      name: 'same-name',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const stop = registry.register(definition)!;
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    stop();
    expect(() => registry.register({ ...definition, run: vi.fn() })).toThrow(
      /already registered/u,
    );
    release();
    await Promise.resolve();
    await Promise.resolve();
    const replacement = registry.register({ ...definition, run: vi.fn() });
    expect(replacement).toBeTypeOf('function');
    replacement?.();
  });

  it('validates shutdown options before stopping registered work', async () => {
    const registry = new RecurringTaskRegistry();
    registry.register({
      name: 'still-live',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run: vi.fn(),
    });
    await expect(registry.shutdown({ timeoutMs: 0 })).rejects.toThrow(
      /timeout must be positive/u,
    );
    expect(registry.list()).toHaveLength(1);
    registry.stopAll();
  });

  it('reports the active task when shutdown drain reaches its deadline and is idempotent', async () => {
    vi.useFakeTimers();
    const registry = new RecurringTaskRegistry();
    registry.register({
      name: 'blocked-write',
      source: 'test',
      intervalMs: 1_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1',
      run: () => new Promise<void>(() => undefined),
    });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    const first = registry.shutdown({ timeoutMs: 500 });
    const second = registry.shutdown({ timeoutMs: 5_000 });
    expect(second).toBe(first);
    const assertion = expect(first).rejects.toThrow(
      /blocked-write \(stopping\)/u,
    );
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });
});
