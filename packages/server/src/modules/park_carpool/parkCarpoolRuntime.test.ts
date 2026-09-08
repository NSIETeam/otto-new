/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import { startCarpoolMaintenance } from './parkCarpoolRuntime.js';
import type { EnterpriseSharedCache } from '../data_platform/index.js';
it('continues scheduled maintenance after lease release fails', async () => {
  vi.useFakeTimers();
  let runs = 0;
  let releases = 0;
  const errors: unknown[] = [];
  const stop = startCarpoolMaintenance({
    run: async () => {
      runs++;
    },
    onError: (error) => errors.push(error),
    cache: {
      acquireLease: async () => true,
      releaseLease: async () => {
        if (++releases === 1) throw new Error('Redis connection interrupted');
      },
    } as unknown as EnterpriseSharedCache,
  });
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(2);
  } finally {
    stop();
    vi.useRealTimers();
  }
});
