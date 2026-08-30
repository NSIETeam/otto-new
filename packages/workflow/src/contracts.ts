/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

export type WorkflowStepKind = 'agent' | 'tool' | 'approval' | 'condition';
export type WorkflowSideEffect = 'none' | 'idempotent' | 'external';
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown_outcome';
export type WorkflowStepStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown_outcome';

export interface WorkflowStepDefinition {
  id: string;
  kind: WorkflowStepKind;
  input: Record<string, unknown>;
  sideEffect: WorkflowSideEffect;
  requiresApproval?: boolean;
}

export interface WorkflowDefinition {
  id: string;
  version: 1;
  steps: readonly WorkflowStepDefinition[];
}

export interface WorkflowStepRun {
  stepId: string;
  kind: WorkflowStepKind;
  attempt: number;
  status: WorkflowStepStatus;
  idempotencyKey: string;
  input: Record<string, unknown>;
  sideEffect: WorkflowSideEffect;
  requiresApproval: boolean;
  approvalId?: string;
  approvedAt?: string;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowRun {
  id: string;
  definitionId: string;
  definitionVersion: 1;
  status: WorkflowRunStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowStepRun[];
  pauseRequestedAt?: string;
  cancelRequestedAt?: string;
}

export interface ClaimedWorkflowStep {
  run: WorkflowRun;
  step: WorkflowStepRun;
}

export interface WorkflowTraceEvent {
  eventId: string;
  timestamp: string;
  runId: string;
  stepId?: string;
  attempt?: number;
  idempotencyKey?: string;
  kind: 'run_started' | 'step_claimed' | 'step_succeeded' | 'step_failed' | 'step_cancelled' | 'approval_recorded' | 'recovery_unknown_outcome' | 'human_takeover' | 'run_paused' | 'run_resumed' | 'run_cancelled';
  status: WorkflowRunStatus | WorkflowStepStatus;
  summary: string;
}

export class WorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowConflictError';
  }
}
