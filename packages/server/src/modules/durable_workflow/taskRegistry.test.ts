/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import {
  DurableWorkflowExecutionError,
  type DurableWorkflowClaim,
} from './contracts.js';
import { createDefaultDurableWorkflowTaskRegistry } from './taskRegistry.js';

function claim(
  taskType: string,
  input: Record<string, unknown>,
): DurableWorkflowClaim {
  return {
    mode: 'forward',
    runId: 'wf-00000000-0000-4000-8000-000000000001',
    organizationId: 'org-1',
    definitionId: 'safe-workflow',
    stepId: 'step-1',
    taskType,
    input,
    sideEffect: 'none',
    attempt: 1,
    maxAttempts: 3,
    idempotencyKey: 'wf-1:step-1',
    workerId: 'worker-1',
    leaseToken: '00000000-0000-4000-8000-000000000002',
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

describe('DurableWorkflowTaskRegistry', () => {
  it('fails closed before execution when a task type is not installed', async () => {
    const registry = createDefaultDurableWorkflowTaskRegistry();
    const failure = await registry
      .execute({
        claim: claim('finance.pay', {}),
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DurableWorkflowExecutionError);
    expect(failure).toMatchObject({ certainty: 'confirmed_not_started' });
  });

  it('executes deterministic built-in conditions without external effects', async () => {
    const registry = createDefaultDurableWorkflowTaskRegistry();
    await expect(
      registry.execute({
        claim: claim('workflow.condition', {
          operator: 'equals',
          value: 'ready',
          expected: 'ready',
        }),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ operator: 'equals', passed: true });
  });
});
