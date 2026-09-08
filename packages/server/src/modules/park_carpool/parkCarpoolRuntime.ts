/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';
import { RecurringTaskRegistry } from 'otto-core';
import type { EnterpriseSharedCache } from '../data_platform/index.js';
export function startCarpoolMaintenance(input: {
  run(signal: AbortSignal): Promise<unknown>;
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
  let active: AbortController | undefined;
  const run = async () => {
    if (closed || running) return;
    running = true;
    let leased = false;
    const controller = new AbortController();
    active = controller;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let renewing = false;
    let leaseStarted = performance.now();
    try {
      if (input.cache) {
        leased = await input.cache.acquireLease(
          'jobs:park-carpool-maintenance:v1',
          owner,
          120_000,
        );
        if (!leased) return;
        if (performance.now() - leaseStarted >= 120_000) throw new Error('Carpool maintenance lease response expired');
      }
      if (leased) {
        const lose = (error: unknown) => { controller.abort(); input.onError?.(error); };
        const armDeadline = (started: number) => {
          clearTimeout(deadline);
          const remaining = 120_000 - (performance.now() - started);
          if (remaining <= 0) { lose(new Error('Carpool maintenance lease expired')); return; }
          deadline = setTimeout(() => lose(new Error('Carpool maintenance lease expired')), remaining);
          deadline.unref();
        };
        armDeadline(leaseStarted);
        renewal = setInterval(() => {
          if (renewing || controller.signal.aborted) return;
          renewing = true;
          leaseStarted = performance.now();
          void input.cache!.renewLease('jobs:park-carpool-maintenance:v1', owner, 120_000)
            .then(ok => { if (!ok) lose(new Error('Carpool maintenance lease lost')); else if (!controller.signal.aborted) armDeadline(leaseStarted); })
            .catch(lose).finally(() => {renewing = false;});
        }, 40_000);
        renewal.unref();
      }
      await input.run(controller.signal);
    } finally {
      clearInterval(renewal);
      clearTimeout(deadline);
      controller.abort();
      active = undefined;
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
    active?.abort();
    clearImmediate(initial);
    stop?.();
  };
}
