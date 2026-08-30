/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core';
import {
  IDLE_EXTERNAL_ORIGINS,
  simulateFreshInstallIdle,
} from './idle-safety-simulation.js';

afterEach(() => {
  vi.useRealTimers();
});

describe.each([24, 72] as const)('%s-hour fresh-install idle simulation', (hours) => {
  it('makes zero paid or external calls with unchanged data', () => {
    const result = simulateFreshInstallIdle(hours);
    expect(result.paidCalls).toBe(0);
    for (const origin of IDLE_EXTERNAL_ORIGINS) {
      expect(result.intercepted[origin]).toBe(0);
    }
  });

  it('drives the real scheduler clock without reaching any intercepted boundary', async () => {
    vi.useFakeTimers();
    const interceptors = Object.fromEntries(
      IDLE_EXTERNAL_ORIGINS.map((origin) => [origin, vi.fn(() => {
        throw new Error(`idle boundary reached: ${origin}`);
      })]),
    );
    const errors: unknown[] = [];
    const registry = new RecurringTaskRegistry({
      allowPaidBackground: false,
      onError: (_name, error) => errors.push(error),
    });

    for (const origin of IDLE_EXTERNAL_ORIGINS) {
      registry.register({
        name: `idle-safety-${origin}`,
        source: 'packages/desktop/src/main/idle-safety-simulation.test.ts',
        intervalMs: 60_000,
        estimatedCostUsdPerRun: origin === 'model' ? 0.01 : 0,
        getInputVersion: () => undefined,
        run: interceptors[origin],
      });
    }

    await vi.advanceTimersByTimeAsync(hours * 60 * 60_000);

    for (const origin of IDLE_EXTERNAL_ORIGINS) {
      expect(interceptors[origin]).not.toHaveBeenCalled();
    }
    expect(registry.list().some((task) => task.paid)).toBe(false);
    expect(errors).toEqual([]);
    registry.stopAll();
  });
});
