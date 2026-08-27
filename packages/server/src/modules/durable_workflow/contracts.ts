/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Server-owned durable workflow contracts. The desktop FileWorkflowStore stays
 * the authority for local/offline runs; these contracts describe the shared
 * PostgreSQL queue used by enterprise workers.
 */

export type DurableWorkflowSideEffect = 'none' | 'idempotent' | 'external';
export type DurableWorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown_outcome'
  | 'dead_letter'
  | 'compensating'
  | 'compensated';
export type DurableWorkflowStepStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown_outcome'
  | 'dead_letter';

export interface DurableWorkflowCompensationDefinition {
  taskType: string;
  input: Record<string, unknown>;
  maxAttempts?: number;
}

export interface DurableWorkflowStepDefinition {
  id: string;
  taskType: string;
  input: Record<string, unknown>;
  sideEffect: DurableWorkflowSideEffect;
  requiresApproval?: boolean;
  approvalTimeoutSeconds?: number;
  maxAttempts?: number;
  compensation?: DurableWorkflowCompensationDefinition;
}

export interface DurableWorkflowDefinition {
  id: string;
  version: 1;
  steps: readonly DurableWorkflowStepDefinition[];
}

export interface DurableWorkflowActor {
  organizationId: string;
  accountId: string | null;
  display: string;
}

export interface DurableWorkflowClaim {
  mode: 'forward' | 'compensation';
  runId: string;
  organizationId: string;
  definitionId: string;
  stepId: string;
  taskType: string;
  input: Record<string, unknown>;
  sideEffect: DurableWorkflowSideEffect;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export type DurableWorkflowFailureCertainty =
  'confirmed_not_started' | 'known_failure' | 'unknown_outcome';

export interface DurableWorkflowRunListItem {
  id: string;
  organizationId: string;
  definitionId: string;
  status: DurableWorkflowRunStatus;
  priority: number;
  createdByAccountId: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DurableWorkflowRunDetail extends DurableWorkflowRunListItem {
  steps: Array<{
    stepId: string;
    sequence: number;
    taskType: string;
    status: DurableWorkflowStepStatus;
    sideEffect: DurableWorkflowSideEffect;
    attempt: number;
    maxAttempts: number;
    requiresApproval: boolean;
    approvalId: string | null;
    approvalExpiresAt: string | null;
    approvedAt: string | null;
    errorSummary: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
  compensations: Array<{
    stepId: string;
    taskType: string;
    status: 'queued' | 'running' | 'succeeded' | 'dead_letter' | 'cancelled';
    attempt: number;
    maxAttempts: number;
    errorSummary: string | null;
    completedAt: string | null;
  }>;
  deadLetters: Array<{
    id: string;
    stepId: string;
    mode: 'forward' | 'compensation';
    reason: string;
    attempt: number;
    createdAt: string;
    resolvedAt: string | null;
  }>;
}

export interface DurableWorkflowQueueStore {
  createRun(input: {
    definition: DurableWorkflowDefinition;
    actor: DurableWorkflowActor;
    submissionIdempotencyKey: string;
    priority?: number;
  }): Promise<DurableWorkflowRunDetail>;
  claimNext(input: {
    workerId: string;
    leaseMs: number;
  }): Promise<DurableWorkflowClaim | null>;
  renewLease(input: {
    claim: DurableWorkflowClaim;
    leaseMs: number;
  }): Promise<boolean>;
  succeedClaim(input: {
    claim: DurableWorkflowClaim;
    output: unknown;
  }): Promise<void>;
  failClaim(input: {
    claim: DurableWorkflowClaim;
    error: string;
    certainty: DurableWorkflowFailureCertainty;
  }): Promise<void>;
  recoverExpiredWork(input?: { limit?: number }): Promise<number>;
  listRuns(input: {
    organizationId: string;
    createdByAccountId?: string;
    statuses?: readonly DurableWorkflowRunStatus[];
    limit?: number;
  }): Promise<DurableWorkflowRunListItem[]>;
  getRun(input: {
    organizationId: string;
    runId: string;
  }): Promise<DurableWorkflowRunDetail | null>;
  approve(input: {
    organizationId: string;
    runId: string;
    stepId: string;
    approvalId: string;
    actor: DurableWorkflowActor;
  }): Promise<void>;
  retryDeadLetter(input: {
    organizationId: string;
    runId: string;
    stepId: string;
    actor: DurableWorkflowActor;
    note: string;
    mode?: 'forward' | 'compensation';
    confirmedExternalNotExecuted: boolean;
  }): Promise<void>;
  resolveUnknown(input: {
    organizationId: string;
    runId: string;
    stepId: string;
    resolution: 'mark_succeeded' | 'mark_failed' | 'cancel';
    actor: DurableWorkflowActor;
    note: string;
  }): Promise<void>;
  requestCompensation(input: {
    organizationId: string;
    runId: string;
    actor: DurableWorkflowActor;
    note: string;
  }): Promise<void>;
  cancel(input: {
    organizationId: string;
    runId: string;
    actor: DurableWorkflowActor;
    note: string;
  }): Promise<void>;
}

export class DurableWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableWorkflowConflictError';
  }
}

export class DurableWorkflowRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DurableWorkflowRequestError';
  }
}

export class DurableWorkflowLeaseLostError extends Error {
  constructor(message = 'Durable workflow lease was lost') {
    super(message);
    this.name = 'DurableWorkflowLeaseLostError';
  }
}

export class DurableWorkflowExecutionError extends Error {
  constructor(
    message: string,
    readonly certainty: DurableWorkflowFailureCertainty,
  ) {
    super(message);
    this.name = 'DurableWorkflowExecutionError';
  }
}
