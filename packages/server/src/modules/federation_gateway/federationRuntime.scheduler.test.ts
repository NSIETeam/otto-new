/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core';
import {
  startFederationRuntime,
  type FederationRuntimeServices,
} from './federationRuntime.js';

describe('federation resident runtime', () => {
  it('registers a named cycle and disposes it', () => {
    const registry = new RecurringTaskRegistry();
    const stop = startFederationRuntime({} as FederationRuntimeServices, {
      taskRegistry: registry,
      initialDelayMs: 60_000,
    });

    expect(registry.list()).toMatchObject([{
      name: 'server.federation-gateway-cycle',
      estimatedCostUsdPerRun: 0,
      paid: false,
    }]);
    stop();
    expect(registry.list()).toEqual([]);
  });
});
