/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChannelTaskControlPort,
  ChannelTaskMessageContext,
  ChannelTaskSummary,
} from './channelTaskControl.js';
import {
  type ResidentWorkflowSupervisor,
  type WorkflowRuntime,
} from 'otto-workflow';

const CHANNEL_APPROVAL_TTL_MS = 10 * 60_000;

export interface ControllableWorkflowRun {
  id: string;
  definitionId: string;
  status: string;
  updatedAt: string;
  steps: Array<{
    stepId: string;
    status: string;
    approvalId?: string;
    input: Record<string, unknown>;
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

/** Direct adapter over the authoritative durable workflow supervisor. */
export class ResidentWorkflowControlBackendV1 implements WorkflowControlBackend {
  constructor(private readonly supervisor: ResidentWorkflowSupervisor) {}

  list(): Promise<ControllableWorkflowRun[]> {
    return this.supervisor.list();
  }

  get(runId: string): Promise<ControllableWorkflowRun | null> {
    return this.supervisor.get(runId);
  }

  pause(runId: string): Promise<ControllableWorkflowRun | null> {
    return this.supervisor.pause(runId);
  }

  resume(runId: string): Promise<ControllableWorkflowRun | null> {
    return this.supervisor.resume(runId);
  }

  cancel(runId: string): Promise<ControllableWorkflowRun | null> {
    return this.supervisor.cancel(runId);
  }

  takeOver(runId: string, note: string): Promise<ControllableWorkflowRun | null> {
    return this.supervisor.takeOver(runId, note);
  }

  approve(
    runId: string,
    stepId: string,
    approvalId: string,
  ): Promise<ControllableWorkflowRun | null> {
    return this.supervisor.approve(runId, stepId, approvalId);
  }
}

/** Creates a persisted, approval-gated agent run for natural-language chat work. */
export class DurableChannelTaskProposalBackendV1 implements ChannelTaskProposalBackend {
  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: {
    request: string;
    idempotencyKey: string;
    context: ChannelTaskMessageContext;
  }): Promise<{ proposalId: string; preview: string; requiresApproval: true }> {
    const run = await this.runtime.start({
      id: 'channel-task-proposal-v1',
      version: 1,
      steps: [{
        id: 'execute-request',
        kind: 'agent',
        sideEffect: 'external',
        requiresApproval: true,
        input: {
          request: input.request,
          approvalExpiresAtMs: this.now() + CHANNEL_APPROVAL_TTL_MS,
          idempotencyKey: input.idempotencyKey,
          origin: {
            provider: input.context.provider,
            installationId: input.context.installationId,
            tenantId: input.context.tenantId,
            userId: input.context.userId,
            deviceId: input.context.deviceId,
            messageId: input.context.messageId,
            receivedAtMs: input.context.receivedAtMs,
          },
        },
      }],
    });
    const waiting = await this.runtime.runNext(run.id);
    const approvalId = waiting?.steps.find(
      (step) => step.status === 'waiting_approval',
    )?.approvalId;
    if (!approvalId) throw new Error('durable channel proposal did not enter approval state');
    return {
      proposalId: run.id,
      preview: `任务已持久化，尚未执行。请在 10 分钟内确认范围和费用后发送 /approve ${approvalId}`,
      requiresApproval: true,
    };
  }
}

function summary(run: ControllableWorkflowRun): ChannelTaskSummary {
  return {
    taskId: run.id,
    title: run.definitionId,
    state: run.status,
    updatedAtMs: Date.parse(run.updatedAt),
  };
}

function isOwnedByChannel(run: ControllableWorkflowRun, context: ChannelTaskMessageContext): boolean {
  return run.steps.some((step) => {
    const origin = step.input.origin;
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false;
    const record = origin as Record<string, unknown>;
    return record.provider === context.provider
      && record.installationId === context.installationId
      && record.tenantId === context.tenantId
      && record.userId === context.userId
      && typeof context.deviceId === 'string'
      && record.deviceId === context.deviceId;
  });
}

/** Bridges authenticated chat controls to the durable workflow supervisor. */
export class WorkflowTaskControlPort implements ChannelTaskControlPort {
  constructor(
    private readonly backend: WorkflowControlBackend,
    private readonly proposals: ChannelTaskProposalBackend,
    private readonly now: () => number = Date.now,
  ) {}

  async list(context: ChannelTaskMessageContext): Promise<ChannelTaskSummary[]> {
    return (await this.backend.list()).filter((run) => isOwnedByChannel(run, context)).map(summary);
  }

  async status(taskId: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary | null> {
    const run = await this.backend.get(taskId);
    return run && isOwnedByChannel(run, context) ? summary(run) : null;
  }

  pause(taskId: string, _idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    return this.mutateOwned(taskId, context, () => this.backend.pause(taskId));
  }

  resume(taskId: string, _idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    return this.mutateOwned(taskId, context, () => this.backend.resume(taskId));
  }

  cancel(taskId: string, _idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    return this.mutateOwned(taskId, context, () => this.backend.cancel(taskId));
  }

  takeOver(taskId: string, _idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    return this.mutateOwned(
      taskId,
      context,
      () => this.backend.takeOver(taskId, `Remote takeover by ${context.provider}:${context.userId}`),
    );
  }

  propose(request: string, idempotencyKey: string, context: ChannelTaskMessageContext) {
    return this.proposals.create({ request, idempotencyKey, context });
  }

  async approve(approvalId: string, _idempotencyKey: string, context: ChannelTaskMessageContext): Promise<ChannelTaskSummary> {
    const match = (await this.backend.list())
      .filter((run) => isOwnedByChannel(run, context))
      .flatMap((run) => run.steps.map((step) => ({ run, step })))
      .find(({ step }) => step.status === 'waiting_approval' && step.approvalId === approvalId);
    if (!match) throw new Error('workflow approval was not found');
    const expiresAtMs = match.step.input.approvalExpiresAtMs;
    if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs) || this.now() > expiresAtMs) {
      throw new Error('workflow approval has expired');
    }
    return this.mutate(
      () => this.backend.approve(match.run.id, match.step.stepId, approvalId),
      match.run.id,
    );
  }

  async deny(approvalId: string, _idempotencyKey: string, context: ChannelTaskMessageContext): Promise<void> {
    const match = (await this.backend.list())
      .filter((run) => isOwnedByChannel(run, context))
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

  private async mutateOwned(
    taskId: string,
    context: ChannelTaskMessageContext,
    operation: () => Promise<ControllableWorkflowRun | null>,
  ): Promise<ChannelTaskSummary> {
    const current = await this.backend.get(taskId);
    if (!current || !isOwnedByChannel(current, context)) throw new Error(`workflow was not found: ${taskId}`);
    return this.mutate(operation, taskId);
  }
}
