/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listActiveProcessWatchdogs,
  startProcessWatchdog,
} from './processWatchdog.js';

afterEach(() => vi.useRealTimers());

describe('process watchdog registry', () => {
  it('registers metadata, avoids overlap and unregisters on stop', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = startProcessWatchdog({
      name: 'test-watchdog', source: 'unit-test', intervalMs: 100, cost: 'none',
    }, task);
    expect(listActiveProcessWatchdogs()).toContainEqual(expect.objectContaining({
      name: 'test-watchdog', source: 'unit-test', intervalMs: 100, cost: 'none',
    }));
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
    release();
    await Promise.resolve();
    expect(listActiveProcessWatchdogs().some(({ name }) => name === 'test-watchdog')).toBe(false);
  });

  it('requires a named source and positive period', () => {
    expect(() => startProcessWatchdog({
      name: '', source: 'unit-test', intervalMs: 100, cost: 'none',
    }, () => undefined)).toThrow('name and source');
    expect(() => startProcessWatchdog({
      name: 'bad', source: 'unit-test', intervalMs: 0, cost: 'none',
    }, () => undefined)).toThrow('intervalMs');
  });
});
