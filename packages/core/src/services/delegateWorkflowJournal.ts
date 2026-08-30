/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import os from 'node:os';
import path from 'node:path';
import {
  FileWorkflowStore,
  FileWorkflowTraceSink,
  type WorkflowRun,
} from 'otto-workflow';

export type DelegateWorkflowOutcome =
  | { status: 'succeeded'; sessionId?: string }
  | { status: 'failed'; error: string; sessionId?: string }
  | { status: 'cancelled'; sessionId?: string };

export interface DelegateWorkflowJournalV1 {
  start(input: {
    taskId: string;
    agent: 'claude-code' | 'codex';
    cwd: string;
    resumedSessionId?: string;
  }): Promise<string>;
  settle(runId: string, outcome: DelegateWorkflowOutcome): Promise<void>;
  recover(runId: string): Promise<WorkflowRun | null>;
}

function defaultRoot(): string {
  const userRoot = process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user');
  return path.join(userRoot, 'durable-workflows');
}

/** Durable lifecycle journal for ACP delegate turns. */
export class FileDelegateWorkflowJournalV1 implements DelegateWorkflowJournalV1 {
  private readonly store: FileWorkflowStore;
  private readonly trace: FileWorkflowTraceSink;

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
    const run = await this.store.createRun({
      id: `delegate-${input.taskId}`,
      version: 1,
      steps: [{
        id: 'agent-turn',
        kind: 'agent',
        sideEffect: 'external',
        requiresApproval: true,
        input: {
          agent: input.agent,
          cwd: input.cwd,
          ...(input.resumedSessionId ? { resumedSessionId: input.resumedSessionId } : {}),
        },
      }],
    });
    await this.trace.append({ runId: run.id, kind: 'run_started', status: run.status, summary: `Started delegate ${input.agent} task ${input.taskId}` });
    const waiting = await this.store.claimNextStep(run.id, run.revision);
    if (!waiting || waiting.step.status !== 'waiting_approval' || !waiting.step.approvalId) {
      throw new Error('delegate workflow did not create an approval gate');
    }
    await this.trace.append({ runId: run.id, stepId: waiting.step.stepId, attempt: waiting.step.attempt, idempotencyKey: waiting.step.idempotencyKey, kind: 'step_claimed', status: waiting.step.status, summary: 'Delegate step is covered by the outer tool approval' });
    const approved = await this.store.approveStep({
      runId: run.id,
      stepId: waiting.step.stepId,
      approvalId: waiting.step.approvalId,
      expectedRevision: waiting.run.revision,
    });
    await this.trace.append({ runId: run.id, stepId: waiting.step.stepId, kind: 'approval_recorded', status: approved.status, summary: 'Outer delegate tool approval recorded' });
    const claimed = await this.store.claimNextStep(run.id, approved.revision);
    if (!claimed || claimed.step.status !== 'running') {
      throw new Error('delegate workflow did not claim the agent step');
    }
    await this.trace.append({ runId: run.id, stepId: claimed.step.stepId, attempt: claimed.step.attempt, idempotencyKey: claimed.step.idempotencyKey, kind: 'step_claimed', status: claimed.step.status, summary: 'External delegate agent turn started' });
    return run.id;
  }

  async settle(runId: string, outcome: DelegateWorkflowOutcome): Promise<void> {
    const run = await this.store.getRun(runId);
    const step = run?.steps.find((candidate) => candidate.status === 'running');
    if (!run || !step) throw new Error(`delegate workflow is not running: ${runId}`);
    if (outcome.status === 'cancelled') await this.store.cancelRun(run.id, run.revision);
    const completed = await this.store.completeStep({
      runId: run.id,
      stepId: step.stepId,
      expectedRevision: run.revision,
      ...(outcome.status === 'failed'
        ? { error: outcome.error.slice(0, 1_000) }
        : { output: { status: outcome.status, sessionId: outcome.sessionId } }),
    });
    await this.trace.append({ runId: run.id, stepId: step.stepId, attempt: step.attempt, idempotencyKey: step.idempotencyKey, kind: outcome.status === 'failed' ? 'step_failed' : 'step_succeeded', status: completed.status, summary: `Delegate turn ${outcome.status}` });
  }

  async recover(runId: string): Promise<WorkflowRun | null> {
    const run = await this.store.getRun(runId);
    if (!run || run.status !== 'running') return run;
    const recovered = await this.store.recoverInterruptedRun(run.id, run.revision);
    const active = recovered.steps.find((step) => step.status === 'unknown_outcome');
    await this.trace.append({ runId: run.id, stepId: active?.stepId, attempt: active?.attempt, idempotencyKey: active?.idempotencyKey, kind: 'recovery_unknown_outcome', status: recovered.status, summary: 'Interrupted delegate requires explicit session resume or human takeover' });
    return recovered;
  }
}
