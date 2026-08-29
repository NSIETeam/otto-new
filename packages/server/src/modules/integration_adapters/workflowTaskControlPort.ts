/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChannelTaskControlPort,
  ChannelTaskMessageContext,
  ChannelTaskSummary,
} from './channelTaskControl.js';

export interface ControllableWorkflowRun {
  id: string;
  definitionId: string;
  status: string;
  updatedAt: string;
  steps: Array<{
    stepId: string;
    status: string;
    approvalId?: string;
  }>;
}

export interface WorkflowControlBackend {
  list(): Promise<ControllableWorkflowRun[]>;
  get(runId: string): Promise<ControllableWorkflowRun | null>;
  pause(runId: string): Promise<ControllableWorkflowRun | null>;
  resume(runId: string): Promise<ControllableWorkflowRun | null>;
  cancel(runId: string): Promise<ControllableWorkflowRun | null>;
  takeOver(runId: string, note: string): Promise<ControllableWorkflowRun | null>;
  approve(runId: string, stepId: string, approvalId: string): Promise<ControllableWorkflowRun | null>;
}

export interface ChannelTaskProposalBackend {
  create(input: {
    request: string;
    idempotencyKey: string;
    context: ChannelTaskMessageContext;
  }): Promise<{ proposalId: string; preview: string; requiresApproval: true }>;
}

function summary(run: ControllableWorkflowRun): ChannelTaskSummary {
  return {
    taskId: run.id,
    title: run.definitionId,
    state: run.status,
    updatedAtMs: Date.parse(run.updatedAt),
  };
}

/** Bridges authenticated chat controls to the durable workflow supervisor. */
export class WorkflowTaskControlPort implements ChannelTaskControlPort {
  constructor(
    private readonly backend: WorkflowControlBackend,
    private readonly proposals: ChannelTaskProposalBackend,
  ) {}

  async list(_context: ChannelTaskMessageContext): Promise<ChannelTaskSummary[]> {
    return (await this.backend.list()).map(summary);
  }

  async status(taskId: string, _context: ChannelTaskMessageContext): Promise<ChannelTaskSummary | null> {
    const run = await this.backend.get(taskId);
    return run ? summary(run) : null;
  }

  pause(taskId: string, _idempotencyKey: string, _context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    return this.mutate(() => this.backend.pause(taskId), taskId);
  }

  resume(taskId: string, _idempotencyKey: string, _context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    return this.mutate(() => this.backend.resume(taskId), taskId);
  }

  cancel(taskId: string, _idempotencyKey: string, _context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    return this.mutate(() => this.backend.cancel(taskId), taskId);
  }

  takeOver(taskId: string, _idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    return this.mutate(
      () => this.backend.takeOver(taskId, `Remote takeover by ${context.provider}:${context.userId}`),
      taskId,
    );
  }

  propose(request: string, idempotencyKey: string, context: ChannelTaskMessageContext) {
    return this.proposals.create({ request, idempotencyKey, context });
  }

  async approve(approvalId: string, _idempotencyKey: string, _context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    const match = (await this.backend.list())
      .flatMap((run) => run.steps.map((step) => ({ run, step })))
      .find(({ step }) => step.status === 'waiting_approval' && step.approvalId === approvalId);
    if (!match) throw new Error('workflow approval was not found');
    return this.mutate(
      () => this.backend.approve(match.run.id, match.step.stepId, approvalId),
      match.run.id,
    );
  }

  async deny(approvalId: string, _idempotencyKey: string, _context: ChannelTaskMessageContext): Promise<void> {
    const match = (await this.backend.list())
      .find((run) => run.steps.some((step) => step.status === 'waiting_approval' && step.approvalId === approvalId));
    if (!match) throw new Error('workflow approval was not found');
    await this.mutate(() => this.backend.cancel(match.id), match.id);
  }

  private async mutate(
    operation: () => Promise<ControllableWorkflowRun | null>,
    taskId: string,
  ): Promise<ChannelTaskSummary> {
    const run = await operation();
    if (!run) throw new Error(`workflow was not found: ${taskId}`);
    return summary(run);
  }
}
