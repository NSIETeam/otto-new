/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Runs bounded MLS retention cleanup on one clustered replica at a time.
 */

import { randomUUID } from 'node:crypto';
import { RecurringTaskRegistry } from 'otto-core';

import type { EnterpriseSharedCache } from '../modules/data_platform/index.js';
import type { PostgresEnterpriseCoreRepository } from './postgresCoreRepository.js';

const MLS_MAINTENANCE_LEASE = 'jobs:mls-resource-maintenance:v1';

export function createClusteredMlsMaintenance(input: {
  cache: EnterpriseSharedCache;
  authority: Pick<PostgresEnterpriseCoreRepository, 'cleanupExpiredMlsResources'>;
  intervalMs?: number;
  owner?: string;
  onError?: (error: unknown) => void;
  taskRegistry?: RecurringTaskRegistry;
}) {
  const intervalMs = input.intervalMs ?? 15 * 60 * 1_000;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 60_000 ||
    intervalMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error('MLS maintenance interval is invalid');
  }
  const owner = input.owner?.trim() || randomUUID();
  const taskRegistry = input.taskRegistry ?? new RecurringTaskRegistry({
    onError: (_taskName, error) => input.onError?.(error),
  });
  let stopTask: (() => void) | undefined;
  let running = false;
  let closed = false;

  async function runOnce(): Promise<boolean> {
    if (closed || running) return false;
    running = true;
    let leased = false;
    try {
      leased = await input.cache.acquireLease(
        MLS_MAINTENANCE_LEASE,
        owner,
        Math.min(24 * 60 * 60 * 1_000, intervalMs * 2),
      );
      if (!leased) return false;
      await input.authority.cleanupExpiredMlsResources({
        before: new Date().toISOString(),
        limit: 500,
      });
      return true;
    } finally {
      if (leased) {
        await input.cache.releaseLease(MLS_MAINTENANCE_LEASE, owner);
      }
      running = false;
    }
  }

  function start(): void {
    if (closed || stopTask) return;
    stopTask = taskRegistry.register({
      name: `enterprise.mls-resource-maintenance.${owner}`,
      source: 'packages/server/src/enterprise/clusteredMlsMaintenance.ts',
      intervalMs,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => String(Math.floor(Date.now() / intervalMs)),
      run: async () => {
        await runOnce();
      },
    });
  }

  function close(): void {
    closed = true;
    stopTask?.();
    stopTask = undefined;
  }

  return { runOnce, start, close };
}
