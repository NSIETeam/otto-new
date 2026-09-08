/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { RecurringTaskRegistry } from 'otto-core';
import type { RecruitmentSourceStore } from './recruitmentSourceStore.js';

/** Server-owned, bounded cleanup. Never fetches candidates or invokes a model. */
export function startRecruitmentCacheMaintenance(
  store: Pick<RecruitmentSourceStore, 'purgeExpired'>,
  registry: RecurringTaskRegistry,
): () => void {
  return registry.register({
    name: 'enterprise.recruitment-cache-maintenance',
    source: 'packages/server/src/modules/recruitment_intelligence/recruitmentCacheMaintenance.ts',
    intervalMs: 60_000,
    initialDelayMs: 0,
    missedRunPolicy: 'run-once',
    estimatedCostUsdPerRun: 0,
    getInputVersion: () => String(Math.floor(Date.now() / 60_000)),
    run: async () => {
      try { await store.purgeExpired(500); }
      catch { throw new Error('招聘临时缓存清理失败，将在下次维护时重试'); }
    },
  }) ?? (() => undefined);
}
