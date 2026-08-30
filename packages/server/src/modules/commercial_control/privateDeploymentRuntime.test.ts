/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core';
import {
  startPrivateDeploymentRuntime,
  type PrivateDeploymentRuntimeServices,
} from './privateDeploymentRuntime.js';

describe('private deployment resident runtime', () => {
  it('registers named control synchronization and disposes it', () => {
    const registry = new RecurringTaskRegistry();
    const stop = startPrivateDeploymentRuntime({} as PrivateDeploymentRuntimeServices, {
      taskRegistry: registry,
      initialDelayMs: 60_000,
    });

    expect(registry.list()).toMatchObject([{
      name: 'server.private-deployment-control-sync',
      estimatedCostUsdPerRun: 0,
      paid: false,
    }]);
    stop();
    expect(registry.list()).toEqual([]);
    vi.restoreAllMocks();
  });
});
