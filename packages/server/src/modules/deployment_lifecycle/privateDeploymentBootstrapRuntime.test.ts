/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it, vi } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core/recurring-tasks';
import { startPrivateDeploymentBootstrapRuntime } from './privateDeploymentBootstrap.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('uses a managed zero-cost lifecycle even without an injected registry, never overlaps, and stops cleanly', async () => {
  vi.useFakeTimers();
  const register = vi.spyOn(RecurringTaskRegistry.prototype, 'register');
  let complete!: () => void;
  const prepare = vi.fn(() => new Promise<never>((resolve) => { complete = () => resolve(undefined as never); }));
  const stop = startPrivateDeploymentBootstrapRuntime({ prepare }, { initialDelayMs: 500, intervalMs: 30_000 });
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 30_000, estimatedCostUsdPerRun: 0 }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(prepare).toHaveBeenCalledOnce();
  stop(); complete();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(prepare).toHaveBeenCalledOnce();
  expect((register.mock.contexts[0] as RecurringTaskRegistry).list()).toEqual([]);
});
