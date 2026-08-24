/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import {
  DurableWorkflowExecutionError,
  type DurableWorkflowClaim,
} from './contracts.js';
import type { DurableWorkflowExecutor } from './worker.js';

export type DurableWorkflowTaskHandler = (input: {
  claim: DurableWorkflowClaim;
  signal: AbortSignal;
}) => Promise<unknown>;

/** Fail-closed registry for task implementations compiled into the Worker. */
export class DurableWorkflowTaskRegistry implements DurableWorkflowExecutor {
  private readonly handlers = new Map<string, DurableWorkflowTaskHandler>();

  register(taskType: string, handler: DurableWorkflowTaskHandler): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(taskType)) {
      throw new Error('Durable workflow task type is invalid');
    }
    if (this.handlers.has(taskType)) {
      throw new Error(
        `Durable workflow task is already registered: ${taskType}`,
      );
    }
    this.handlers.set(taskType, handler);
  }

  taskTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async execute(input: {
    claim: DurableWorkflowClaim;
    signal: AbortSignal;
  }): Promise<unknown> {
    const handler = this.handlers.get(input.claim.taskType);
    if (!handler) {
      throw new DurableWorkflowExecutionError(
        `Durable workflow task is not installed: ${input.claim.taskType}`,
        'confirmed_not_started',
      );
    }
    return handler(input);
  }
}

export function createDefaultDurableWorkflowTaskRegistry(): DurableWorkflowTaskRegistry {
  const registry = new DurableWorkflowTaskRegistry();
  registry.register('workflow.checkpoint', async ({ claim, signal }) => {
    if (signal.aborted) throw new Error('Workflow checkpoint cancelled');
    return {
      checkpoint: true,
      idempotencyKey: claim.idempotencyKey,
    };
  });
  registry.register('workflow.condition', async ({ claim, signal }) => {
    if (signal.aborted) throw new Error('Workflow condition cancelled');
    const operator = claim.input['operator'];
    const value = claim.input['value'];
    const passed =
      operator === 'exists'
        ? value !== null && value !== undefined
        : operator === 'equals'
          ? Object.is(value, claim.input['expected'])
          : false;
    if (!passed) {
      throw new DurableWorkflowExecutionError(
        'Workflow condition did not pass',
        'confirmed_not_started',
      );
    }
    return { operator, passed: true };
  });
  return registry;
}
