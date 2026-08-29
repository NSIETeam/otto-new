/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryRecurringTaskStateStore,
  RecurringTaskRegistry,
} from './recurringTaskRegistry.js';

afterEach(() => vi.useRealTimers());

describe('RecurringTaskRegistry', () => {
  it('records ownership, cadence, cost and a stop function', () => {
    const registry = new RecurringTaskRegistry();
    registry.register({
      name: 'local-index', source: 'test', intervalMs: 60_000,
      estimatedCostUsdPerRun: 0, getInputVersion: () => 'v1', run: vi.fn(),
    });

    expect(registry.list()).toMatchObject([{
      name: 'local-index', source: 'test', intervalMs: 60_000,
      estimatedCostUsdPerRun: 0, paid: false, inputVersion: 'v1',
      stop: expect.any(Function),
    }]);
    registry.stopAll();
  });

  it('keeps paid background work disabled unless explicitly enabled', () => {
    const registry = new RecurringTaskRegistry();
    const stop = registry.register({
      name: 'model-analysis', source: 'test', intervalMs: 1_000,
      estimatedCostUsdPerRun: 0.01, getInputVersion: () => 'v1', run: vi.fn(),
    });

    expect(stop).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('does not rerun unchanged input and never overlaps executions', async () => {
    vi.useFakeTimers();
    let version = 'v1';
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const registry = new RecurringTaskRegistry({ allowPaidBackground: true });
    registry.register({
      name: 'analysis', source: 'test', intervalMs: 1_000,
      estimatedCostUsdPerRun: 0.01, getInputVersion: () => version, run,
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
      name: 'durable-index', source: 'test', definitionVersion: 2,
      intervalMs: 1_000, estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'content-v1', run: firstRun,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstRun).toHaveBeenCalledOnce();
    first.stopAll();

    const restoredRun = vi.fn();
    const restored = new RecurringTaskRegistry({ stateStore: store });
    restored.register({
      name: 'durable-index', source: 'test', definitionVersion: 2,
      intervalMs: 1_000, estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'content-v1', run: restoredRun,
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
      name: 'reconcile', source: 'test', definitionVersion: 1,
      nextRunAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 60_000,
    });
    const run = vi.fn();
    const registry = new RecurringTaskRegistry({ stateStore: store });
    registry.register({
      name: 'reconcile', source: 'test', intervalMs: 60_000,
      missedRunPolicy: 'run-once', estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'v1', run,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    registry.stopAll();
  });

  it('resets stale completion state when source or definition version changes', () => {
    const store = new InMemoryRecurringTaskStateStore();
    store.put({
      name: 'index', source: 'old-source', definitionVersion: 1,
      lastCompletedInputVersion: 'old-input', nextRunAtMs: 1, updatedAtMs: 1,
    });
    const registry = new RecurringTaskRegistry({ stateStore: store });
    registry.register({
      name: 'index', source: 'new-source', definitionVersion: 2,
      intervalMs: 1_000, estimatedCostUsdPerRun: 0,
      getInputVersion: () => 'old-input', run: vi.fn(),
    });
    expect(registry.list()[0]?.lastCompletedInputVersion).toBeUndefined();
    registry.stopAll();
  });
});
