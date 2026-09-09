/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { RecurringTaskRegistry } from 'otto-core';
import type { PolicyStore } from './policyStore.js';
import type { EnterprisePolicyService } from './policyService.js';
import {
  policyCollectionSlot,
  POLICY_COLLECTION_PROGRESS_KEY,
  type PolicyCollectionProgress,
} from './policyCollectionCycle.js';
import { POLICY_BACKGROUND_RECORD_BYTES } from './policyStore.js';
export { policyCollectionSlot } from './policyCollectionCycle.js';
export function startPolicyRuntime(
  service: EnterprisePolicyService,
  store: PolicyStore,
  registry?: RecurringTaskRegistry,
): () => void {
  const collectionEnabled =
    process.env.OTTO_POLICY_COLLECTION_ENABLED !== 'false';
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
  const stopNotices = tasks.register({
    name: 'enterprise.policy-intelligence.notifications',
    source: 'packages/server/src/modules/policy_intelligence/policyRuntime.ts',
    intervalMs: 60_000,
    estimatedCostUsdPerRun: 0,
    getInputVersion: () => String(Math.floor(Date.now() / 60_000)),
    run: async () => {
      if (!controller.signal.aborted)
        await service.refreshNotifications(controller.signal);
    },
  });
  const stop = collectionEnabled
    ? tasks.register({
        name: 'enterprise.policy-intelligence.collection',
        source:
          'packages/server/src/modules/policy_intelligence/policyRuntime.ts',
        intervalMs: 60_000,
        estimatedCostUsdPerRun: 1,
        getInputVersion: async () => {
          const slot = policyCollectionSlot(new Date());
          const progress = await store.getBounded<
            PolicyCollectionProgress<unknown>
          >(POLICY_COLLECTION_PROGRESS_KEY, POLICY_BACKGROUND_RECORD_BYTES);
          if (
            progress?.status === 'needs-review' ||
            (progress?.slot === slot &&
              ['complete', 'awaiting-next-slot'].includes(progress.status))
          )
            return undefined;
          return `${slot}:${progress?.revision ?? 0}`;
        },
        run: async () => {
          if (!controller.signal.aborted)
            await service.collect(controller.signal);
        },
      })
    : undefined;
  return () => {
    controller.abort();
    stop?.();
    stopNotices?.();
  };
}
