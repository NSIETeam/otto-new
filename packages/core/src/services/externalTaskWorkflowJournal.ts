/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import os from 'node:os';
import path from 'node:path';
import {
  FileWorkflowStore,
  FileWorkflowTraceSink,
  type WorkflowRun,
} from 'otto-workflow';

export type ExternalTaskWorkflowOutcome =
  | { status: 'succeeded'; sessionId?: string }
  | { status: 'failed'; error: string; sessionId?: string }
  | { status: 'cancelled'; sessionId?: string };

export interface ExternalTaskWorkflowCheckpoint {
  sessionId?: string;
  currentTool?: string;
  toolCallCount?: number;
  plan?: ReadonlyArray<{ content: string; status?: string }>;
  tokenUsed?: number;
  tokenSize?: number;
  lastActivityAt?: number;
}

export interface ExternalTaskWorkflowJournalV1 {
  start(input: {
    taskId: string;
    agent: 'claude-code' | 'codex';
    cwd: string;
    resumedSessionId?: string;
  }): Promise<string>;
  startShell(input: { taskId: string; cwd: string }): Promise<string>;
  checkpoint(runId: string, checkpoint: ExternalTaskWorkflowCheckpoint): Promise<void>;
  settle(runId: string, outcome: ExternalTaskWorkflowOutcome): Promise<void>;
  recover(runId: string): Promise<WorkflowRun | null>;
}

function defaultRoot(): string {
  const userRoot = process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user');
  return path.join(userRoot, 'durable-workflows');
}

/** Durable lifecycle journal for approved external background work. */
export class FileExternalTaskWorkflowJournalV1 implements ExternalTaskWorkflowJournalV1 {
  private readonly store: FileWorkflowStore;
  private readonly trace: FileWorkflowTraceSink;
  private readonly checkpointTails = new Map<string, Promise<void>>();

  constructor(root = defaultRoot()) {
    this.store = new FileWorkflowStore(path.join(root, 'runs'));
    this.trace = new FileWorkflowTraceSink(path.join(root, 'traces'));
  }

  async start(input: {
    taskId: string;
    agent: 'claude-code' | 'codex';
    cwd: string;
    resumedSessionId?: string;
  }): Promise<string> {
    return this.startExternal({
      definitionId: `delegate-${input.taskId}`,
      stepId: 'agent-turn',
      kind: 'agent',
      input: {
        agent: input.agent,
        cwd: input.cwd,
        ...(input.resumedSessionId ? { resumedSessionId: input.resumedSessionId } : {}),
      },
      summary: `delegate ${input.agent} task ${input.taskId}`,
    });
  }

  async startShell(input: { taskId: string; cwd: string }): Promise<string> {
    return this.startExternal({
      definitionId: `shell-${input.taskId}`,
      stepId: 'shell-process',
      kind: 'tool',
      input: { tool: 'shell', cwd: input.cwd },
      summary: `background shell task ${input.taskId}`,
    });
  }

  private async startExternal(input: {
    definitionId: string;
    stepId: string;
    kind: 'agent' | 'tool';
    input: Record<string, unknown>;
    summary: string;
  }): Promise<string> {
    const run = await this.store.createRun({
      id: input.definitionId,
      version: 1,
      steps: [{
        id: input.stepId,
        kind: input.kind,
        sideEffect: 'external',
        requiresApproval: true,
        input: input.input,
      }],
    });
    await this.trace.append({ runId: run.id, kind: 'run_started', status: run.status, summary: `Started ${input.summary}` });
    const waiting = await this.store.claimNextStep(run.id, run.revision);
    if (!waiting || waiting.step.status !== 'waiting_approval' || !waiting.step.approvalId) {
      throw new Error('external task workflow did not create an approval gate');
    }
    await this.trace.append({ runId: run.id, stepId: waiting.step.stepId, attempt: waiting.step.attempt, idempotencyKey: waiting.step.idempotencyKey, kind: 'step_claimed', status: waiting.step.status, summary: 'External task is covered by the outer tool approval' });
    const approved = await this.store.approveStep({
      runId: run.id,
      stepId: waiting.step.stepId,
      approvalId: waiting.step.approvalId,
      expectedRevision: waiting.run.revision,
    });
    await this.trace.append({ runId: run.id, stepId: waiting.step.stepId, kind: 'approval_recorded', status: approved.status, summary: 'Outer tool approval recorded' });
    const claimed = await this.store.claimNextStep(run.id, approved.revision);
    if (!claimed || claimed.step.status !== 'running') {
      throw new Error('external task workflow did not claim its step');
    }
    await this.trace.append({ runId: run.id, stepId: claimed.step.stepId, attempt: claimed.step.attempt, idempotencyKey: claimed.step.idempotencyKey, kind: 'step_claimed', status: claimed.step.status, summary: `Started ${input.summary}` });
    return run.id;
  }

  async settle(runId: string, outcome: ExternalTaskWorkflowOutcome): Promise<void> {
    await this.checkpointTails.get(runId)?.catch(() => undefined);
    this.checkpointTails.delete(runId);
    const run = await this.store.getRun(runId);
    const step = run?.steps.find((candidate) => candidate.status === 'running');
    if (!run || !step) throw new Error(`external task workflow is not running: ${runId}`);
    if (outcome.status === 'cancelled') await this.store.cancelRun(run.id, run.revision);
    const completed = await this.store.completeStep({
      runId: run.id,
      stepId: step.stepId,
      expectedRevision: run.revision,
      ...(outcome.status === 'cancelled' ? { cancelled: true } : {}),
      ...(outcome.status === 'failed'
        ? { error: outcome.error.slice(0, 1_000) }
        : { output: { status: outcome.status, sessionId: outcome.sessionId } }),
    });
    const traceKind = outcome.status === 'failed'
      ? 'step_failed'
      : outcome.status === 'cancelled'
        ? 'step_cancelled'
        : 'step_succeeded';
    await this.trace.append({ runId: run.id, stepId: step.stepId, attempt: step.attempt, idempotencyKey: step.idempotencyKey, kind: traceKind, status: completed.status, summary: `External task ${outcome.status}` });
  }

  async checkpoint(runId: string, checkpoint: ExternalTaskWorkflowCheckpoint): Promise<void> {
    const previous = this.checkpointTails.get(runId) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const run = await this.store.getRun(runId);
      const step = run?.steps.find((candidate) => candidate.status === 'running');
      if (!run || !step) throw new Error(`external task workflow is not running: ${runId}`);
      await this.store.checkpointRunningStep({
        runId,
        stepId: step.stepId,
        expectedRevision: run.revision,
        checkpoint: {
          ...(checkpoint.sessionId ? { sessionId: checkpoint.sessionId.slice(0, 500) } : {}),
          ...(checkpoint.currentTool ? { currentTool: checkpoint.currentTool.slice(0, 500) } : {}),
          ...(Number.isSafeInteger(checkpoint.toolCallCount) && checkpoint.toolCallCount! >= 0
            ? { toolCallCount: checkpoint.toolCallCount }
            : {}),
          ...(checkpoint.plan ? {
            plan: checkpoint.plan.slice(0, 100).map((entry) => ({
              content: entry.content.slice(0, 1_000),
              ...(entry.status ? { status: entry.status.slice(0, 100) } : {}),
            })),
          } : {}),
          ...(Number.isFinite(checkpoint.tokenUsed) && checkpoint.tokenUsed! >= 0 ? { tokenUsed: checkpoint.tokenUsed } : {}),
          ...(Number.isFinite(checkpoint.tokenSize) && checkpoint.tokenSize! >= 0 ? { tokenSize: checkpoint.tokenSize } : {}),
          ...(Number.isFinite(checkpoint.lastActivityAt) ? { lastActivityAt: checkpoint.lastActivityAt } : {}),
        },
      });
    });
    this.checkpointTails.set(runId, pending);
    try {
      await pending;
    } finally {
      if (this.checkpointTails.get(runId) === pending) this.checkpointTails.delete(runId);
    }
  }

  async recover(runId: string): Promise<WorkflowRun | null> {
    const run = await this.store.getRun(runId);
    if (!run || run.status !== 'running') return run;
    const recovered = await this.store.recoverInterruptedRun(run.id, run.revision);
    const active = recovered.steps.find((step) => step.status === 'unknown_outcome');
    await this.trace.append({ runId: run.id, stepId: active?.stepId, attempt: active?.attempt, idempotencyKey: active?.idempotencyKey, kind: 'recovery_unknown_outcome', status: recovered.status, summary: 'Interrupted external task requires reconciliation or human takeover' });
    return recovered;
  }
}
