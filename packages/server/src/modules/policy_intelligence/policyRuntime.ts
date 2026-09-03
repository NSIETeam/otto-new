/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { RecurringTaskRegistry } from 'otto-core';
import type { PolicyStore } from './policyStore.js';
import type { EnterprisePolicyService } from './policyService.js';
export function policyCollectionSlot(now: Date): string {
  const local = new Date(now.getTime() + 8 * 3600_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (minute < 180) local.setUTCDate(local.getUTCDate() - 1);
  return `${local.toISOString().slice(0, 10)}:${minute >= 180 && minute < 1110 ? '03:00' : '18:30'}`;
}
export function startPolicyRuntime(
  service: EnterprisePolicyService,
  store: PolicyStore,
  registry?: RecurringTaskRegistry,
): () => void {
  if (process.env.OTTO_POLICY_COLLECTION_ENABLED === 'false')
    return () => undefined;
  const tasks =
    registry ??
    new RecurringTaskRegistry({
      allowPaidBackground: true,
      onError: () =>
        console.error(
          '[Otto Policy] scheduled collection failed; see policy source status',
        ),
    });
  const controller = new AbortController();
  const stop = tasks.register({
    name: 'enterprise.policy-intelligence.collection',
    source: 'packages/server/src/modules/policy_intelligence/policyRuntime.ts',
    intervalMs: 60_000,
    estimatedCostUsdPerRun: 1,
    getInputVersion: () => policyCollectionSlot(new Date()),
    run: async () => {
      let accepted = false;
      const slot = policyCollectionSlot(new Date());
      await store.update<{ slot: string }>('collection:schedule', (current) => {
        if (current?.slot === slot) return current;
        accepted = true;
        return { slot };
      });
      if (accepted && !controller.signal.aborted)
        await service.collect(
          AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
        );
    },
  });
  return () => {
    controller.abort();
    stop?.();
  };
}
