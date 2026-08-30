/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { RecurringTaskRegistry } from '../services/recurringTaskRegistry.js';
import { EnterpriseSync } from './enterpriseSync.js';

describe('EnterpriseSync resident scheduling', () => {
  it('registers one named zero-cost task and exposes a reliable stop path', () => {
    const registry = new RecurringTaskRegistry();
    const sync = new EnterpriseSync(process.cwd());

    sync.startAutoSync(registry);
    sync.startAutoSync(registry);

    expect(registry.list()).toMatchObject([{
      name: 'enterprise-organization-sync',
      source: 'packages/core/src/orchestration/enterpriseSync.ts#auto-sync',
      intervalMs: 60 * 60 * 1000,
      estimatedCostUsdPerRun: 0,
      paid: false,
      running: false,
    }]);

    sync.stopAutoSync();
    expect(registry.list()).toEqual([]);
  });
});
