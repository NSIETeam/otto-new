/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

export type RpaActionKind =
  | 'web.navigate'
  | 'web.fill'
  | 'web.click'
  | 'web.extract'
  | 'web.screenshot'
  | 'web.wait'
  | 'desktop.inspect'
  | 'desktop.click'
  | 'desktop.fill'
  | 'desktop.select'
  | 'desktop.scroll'
  | 'desktop.wait'
  | 'desktop.screenshot'
  | 'checkpoint';

export interface DesktopRpaTargetV1 {
  /** Semantic accessibility role, for example button or text-field. */
  role: string;
  /** Accessible name; exact matching is the default. */
  name: string;
  windowTitle?: string;
}
export type RpaRunState =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown_outcome';

export interface RpaStepDefinition {
  id: string;
  action: RpaActionKind;
  args: Record<string, unknown>;
  /** Actions with potential external effects are never auto-replayed. */
  sideEffect: 'none' | 'external';
  requiresApproval?: boolean;
}

export interface RpaWorkflowV1 {
  id: string;
  version: 1;
  steps: readonly RpaStepDefinition[];
}

export interface RpaArtifact {
  id: string;
  sha256: string;
  mediaType: string;
  redactedSummary: string;
}

export interface RpaStepReceipt {
  stepId: string;
  attempt: number;
  state: 'pending' | 'started' | 'succeeded' | 'failed' | 'unknown_outcome';
  idempotencyKey: string;
  artifactIds: string[];
  approvalId?: string;
  approvedAt?: string;
  output?: unknown;
  error?: string;
}

export interface RpaRun {
  id: string;
  workflowId: string;
  workflowVersion: 1;
  /** Persisted definition makes recovery independent of a process-local registry. */
  workflow: RpaWorkflowV1;
  state: RpaRunState;
  revision: number;
  currentStepId: string | null;
  approvalId?: string;
  takeoverNote?: string;
  pauseRequestedAt?: string;
  cancelRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  receipts: RpaStepReceipt[];
}

export class RpaConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpaConflictError';
  }
}
