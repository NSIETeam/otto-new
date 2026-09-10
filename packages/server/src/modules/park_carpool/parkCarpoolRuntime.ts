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
    let renewals: RecurringTaskRegistry | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let activeRenewal: Promise<void> | undefined;
    let leaseStarted = performance.now();
    try {
      if (input.cache) {
        leased = await input.cache.acquireLease(
          'jobs:park-carpool-maintenance:v1',
          owner,
          120_000,
        );
        if (!leased) return;
        if (performance.now() - leaseStarted >= 120_000)
          throw new Error('Carpool maintenance lease response expired');
      }
      // An outstanding lease request can resolve after shutdown cancelled this
      // run. Release the acquired lease in finally without starting new work.
      if (closed || controller.signal.aborted) return;
      if (leased) {
        const lose = (error: unknown) => {
          controller.abort();
          input.onError?.(error);
        };
        const armDeadline = (started: number) => {
          clearTimeout(deadline);
          const remaining = 120_000 - (performance.now() - started);
          if (remaining <= 0) {
            lose(new Error('Carpool maintenance lease expired'));
            return;
          }
          deadline = setTimeout(
            () => lose(new Error('Carpool maintenance lease expired')),
            remaining,
          );
          deadline.unref();
        };
        armDeadline(leaseStarted);
        // Each lease owns a child registry: draining the parent from inside its
        // maintenance task would wait on this very task. The child also prevents
        // overlapping renewals without an unmanaged repeating timer.
        renewals = new RecurringTaskRegistry({
          onError: (_name, error) => lose(error),
        });
        controller.signal.addEventListener('abort', () => renewals!.stopAll(), {
          once: true,
        });
        renewals.register({
          name: 'enterprise.park-carpool-lease-renewal',
          source:
            'packages/server/src/modules/park_carpool/parkCarpoolRuntime.ts',
          intervalMs: 40_000,
          initialDelayMs: 40_000,
          estimatedCostUsdPerRun: 0,
          getInputVersion: () => String(leaseStarted),
          run: async () => {
            if (controller.signal.aborted) return;
            const renewalStarted = performance.now();
            leaseStarted = renewalStarted;
            activeRenewal = (async () => {
              try {
                const ok = await input.cache!.renewLease(
                  'jobs:park-carpool-maintenance:v1',
                  owner,
                  120_000,
                );
                if (!ok) lose(new Error('Carpool maintenance lease lost'));
                else if (!controller.signal.aborted)
                  armDeadline(renewalStarted);
              } catch (error) {
                lose(error);
              }
            })();
            await activeRenewal;
          },
        });
      }
      await input.run(controller.signal);
    } finally {
      renewals?.stopAll();
      clearTimeout(deadline);
      controller.abort();
      active = undefined;
      try {
        // The registry must also drain an already-issued Redis operation;
        // clearing its timer alone does not cancel an in-flight renewal.
        await activeRenewal;
        await renewals?.shutdown();
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
    initialDelayMs: 30_000,
    missedRunPolicy: 'run-once',
    estimatedCostUsdPerRun: 0,
    getInputVersion: () => String(Math.floor(Date.now() / 60_000)),
    run,
  });
  return () => {
    closed = true;
    active?.abort();
    stop?.();
  };
}
