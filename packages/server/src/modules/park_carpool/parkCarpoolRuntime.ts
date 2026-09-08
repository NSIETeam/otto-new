/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import { RecurringTaskRegistry } from 'otto-core';
import type { EnterpriseSharedCache } from '../data_platform/index.js';
export function startCarpoolMaintenance(input: {
  run(): Promise<unknown>;
  taskRegistry?: RecurringTaskRegistry;
  cache?: EnterpriseSharedCache;
  onError?(error: unknown): void;
}): () => void {
  const registry =
    input.taskRegistry ??
    new RecurringTaskRegistry({
      onError: (_name, error) => input.onError?.(error),
    });
  const owner = randomUUID();
  let running = false;
  let closed = false;
  const run = async () => {
    if (closed || running) return;
    running = true;
    let leased = false;
    try {
      if (input.cache) {
        leased = await input.cache.acquireLease(
          'jobs:park-carpool-maintenance:v1',
          owner,
          120_000,
        );
        if (!leased) return;
      }
      await input.run();
    } finally {
      try {
        if (leased)
          await input.cache!.releaseLease(
            'jobs:park-carpool-maintenance:v1',
            owner,
          );
      } finally {
        running = false;
      }
    }
  };
  const stop = registry.register({
    name: 'enterprise.park-carpool-maintenance',
    source: 'packages/server/src/modules/park_carpool/parkCarpoolRuntime.ts',
    intervalMs: 60_000,
    estimatedCostUsdPerRun: 0,
    getInputVersion: () => String(Math.floor(Date.now() / 60_000)),
    run,
  });
  const initial = setImmediate(
    () => void run().catch((error) => input.onError?.(error)),
  );
  initial.unref();
  return () => {
    closed = true;
    clearImmediate(initial);
    stop?.();
  };
}
