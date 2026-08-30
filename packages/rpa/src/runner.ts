/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  RpaRun,
  RpaStepDefinition,
  RpaStepReceipt,
  RpaWorkflowV1,
} from './contracts.js';
import type { RpaArtifactStore, RpaDriver, RpaPolicyPort, RpaRunStore } from './ports.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function receiptFor(run: RpaRun, stepId: string): RpaStepReceipt | undefined {
  return run.receipts.find((receipt) => receipt.stepId === stepId);
}

const MAX_STEP_OUTPUT_BYTES = 64 * 1024;
const MAX_STEP_ARTIFACTS = 10;

function boundedOutput(value: unknown): unknown {
  if (value === undefined) return undefined;
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STEP_OUTPUT_BYTES) {
    throw new Error(`RPA step output exceeds ${MAX_STEP_OUTPUT_BYTES} bytes.`);
  }
  return clone(value);
}

class RpaExecutionInterruptedError extends Error {
  constructor() {
    super('RPA step was interrupted.');
    this.name = 'RpaExecutionInterruptedError';
  }
}

/** Durable, policy-gated RPA runner. It intentionally has no shell or raw coordinate action. */
export class RpaRunner {
  private readonly workflows = new Map<string, RpaWorkflowV1>();

  constructor(
    workflows: readonly RpaWorkflowV1[],
    private readonly store: RpaRunStore,
    private readonly policy: RpaPolicyPort,
    private readonly driver: RpaDriver,
    private readonly artifacts: RpaArtifactStore,
  ) {
    for (const workflow of workflows) {
      validateWorkflow(workflow);
      this.workflows.set(`${workflow.id}@${workflow.version}`, workflow);
    }
  }

  async start(workflowId: string, version = 1): Promise<RpaRun> {
    const workflow = this.workflow(workflowId, version);
    return this.store.create(workflow);
  }

  async runNext(runId: string, signal?: AbortSignal): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run || ['awaiting_approval', 'paused', 'unknown_outcome', 'failed', 'cancelled', 'succeeded'].includes(run.state)) {
      return run;
    }
    const workflow = this.workflowForRun(run);
    if (signal?.aborted) return run;
    const step = workflow.steps.find((candidate) => receiptFor(run, candidate.id)?.state === 'pending');
    if (!step) return this.finish(run);

    const authorization = await this.policy.authorize({ run: clone(run), step });
    if (authorization.decision === 'deny') return this.fail(run, step, authorization.reason);
    if (authorization.decision === 'awaiting_approval') {
      run.state = 'awaiting_approval';
      run.currentStepId = step.id;
      run.approvalId = authorization.approvalId;
      return this.store.save(run, run.revision);
    }

    const receipt = receiptFor(run, step.id)!;
    receipt.state = 'started';
    receipt.attempt += 1;
    receipt.idempotencyKey = `${run.id}:${step.id}:${receipt.attempt}`;
    run.currentStepId = step.id;
    run.state = 'running';
    const claimed = await this.store.save(run, run.revision);

    try {
      const execution = this.driver.execute({
        run: clone(claimed),
        step,
        idempotencyKey: receiptFor(claimed, step.id)!.idempotencyKey,
        signal,
      });
      let abortListener: (() => void) | undefined;
      const interrupted = signal
        ? new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(new RpaExecutionInterruptedError());
            if (signal.aborted) abortListener();
            else signal.addEventListener('abort', abortListener, { once: true });
          })
        : undefined;
      let outcome;
      try {
        outcome = interrupted ? await Promise.race([execution, interrupted]) : await execution;
      } finally {
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      }
      const saved = await this.store.get(runId);
      if (!saved) return null;
      const completed = receiptFor(saved, step.id)!;
      const output = boundedOutput(outcome.output);
      completed.artifactIds = [];
      const artifacts = outcome.artifacts ?? [];
      if (artifacts.length > MAX_STEP_ARTIFACTS) {
        throw new Error(`RPA step produced more than ${MAX_STEP_ARTIFACTS} artifacts.`);
      }
      for (const artifact of artifacts) {
        completed.artifactIds.push((await this.artifacts.put(artifact)).id);
      }
      completed.output = output;
      completed.state = 'succeeded';
      saved.currentStepId = null;
      if (saved.cancelRequestedAt) {
        saved.state = 'cancelled';
      } else if (saved.pauseRequestedAt) {
        saved.state = 'paused';
        saved.pauseRequestedAt = undefined;
      } else {
        saved.state = 'pending';
      }
      return this.store.save(saved, saved.revision);
    } catch (error) {
      const saved = await this.store.get(runId);
      if (!saved) return null;
      if (error instanceof RpaExecutionInterruptedError) {
        const interrupted = receiptFor(saved, step.id)!;
        if (step.sideEffect === 'external') {
          interrupted.state = 'unknown_outcome';
          interrupted.error = 'RPA execution was cancelled after an external action began; reconciliation or human takeover is required.';
          saved.state = 'unknown_outcome';
        } else {
          interrupted.state = 'pending';
          interrupted.error = undefined;
          saved.currentStepId = null;
          saved.state = 'pending';
        }
        return this.store.save(saved, saved.revision);
      }
      return this.fail(saved, step, error instanceof Error ? error.message : String(error));
    }
  }

  async recover(runId: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    const workflow = this.workflowForRun(run);
    const active = run.currentStepId ? receiptFor(run, run.currentStepId) : undefined;
    if (!active || active.state !== 'started') return run;
    const step = workflow.steps.find((candidate) => candidate.id === active.stepId);
    if (!step) throw new Error(`Unknown RPA step: ${active.stepId}`);
    if (step.sideEffect === 'external') {
      active.state = 'unknown_outcome';
      active.error = 'Execution was interrupted after an external action began; human takeover or reconciliation is required.';
      run.state = 'unknown_outcome';
      return this.store.save(run, run.revision);
    }
    active.state = 'pending';
    active.error = undefined;
    run.currentStepId = null;
    run.state = 'pending';
    return this.store.save(run, run.revision);
  }

  /** Records an explicit human approval; policy is still checked again before execution. */
  async approve(runId: string, approvalId: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    if (run.state !== 'awaiting_approval' || run.approvalId !== approvalId || !run.currentStepId) {
      throw new Error('RPA run is not waiting for this approval.');
    }
    const receipt = receiptFor(run, run.currentStepId);
    if (!receipt) throw new Error(`RPA receipt is missing for ${run.currentStepId}.`);
    receipt.approvalId = approvalId;
    receipt.approvedAt = new Date().toISOString();
    run.approvalId = undefined;
    run.currentStepId = null;
    run.state = 'pending';
    return this.store.save(run, run.revision);
  }

  /** Human takeover is explicit and auditable; it never silently retries an unknown external action. */
  async takeOver(runId: string, note: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    if (run.state !== 'unknown_outcome') {
      throw new Error('Only a run with unknown external outcome can be taken over.');
    }
    run.state = 'paused';
    run.takeoverNote = note.trim().slice(0, 500) || 'Human takeover requested.';
    return this.store.save(run, run.revision);
  }

  async pause(runId: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    if (run.state === 'paused') return run;
    if (run.state === 'running') {
      run.pauseRequestedAt = new Date().toISOString();
      return this.store.save(run, run.revision);
    }
    if (run.state !== 'pending' && run.state !== 'awaiting_approval') {
      throw new Error(`RPA run cannot be paused from ${run.state}.`);
    }
    run.state = 'paused';
    return this.store.save(run, run.revision);
  }

  async resume(runId: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    if (run.state !== 'paused') throw new Error(`RPA run cannot be resumed from ${run.state}.`);
    run.pauseRequestedAt = undefined;
    run.state = run.approvalId ? 'awaiting_approval' : 'pending';
    return this.store.save(run, run.revision);
  }

  async cancel(runId: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    if (run.state === 'cancelled') return run;
    if (run.state === 'running') {
      run.cancelRequestedAt = new Date().toISOString();
      run.pauseRequestedAt = undefined;
      return this.store.save(run, run.revision);
    }
    if (run.state === 'succeeded' || run.state === 'failed' || run.state === 'unknown_outcome') {
      throw new Error(`RPA run cannot be cancelled from ${run.state}.`);
    }
    run.state = 'cancelled';
    run.cancelRequestedAt = new Date().toISOString();
    run.pauseRequestedAt = undefined;
    return this.store.save(run, run.revision);
  }

  private async finish(run: RpaRun): Promise<RpaRun> {
    run.state = 'succeeded';
    run.currentStepId = null;
    return this.store.save(run, run.revision);
  }

  private async fail(run: RpaRun, step: RpaStepDefinition, error: string): Promise<RpaRun> {
    const receipt = receiptFor(run, step.id)!;
    receipt.state = 'failed';
    receipt.error = error;
    run.state = 'failed';
    run.currentStepId = step.id;
    return this.store.save(run, run.revision);
  }

  private workflow(id: string, version: number): RpaWorkflowV1 {
    const workflow = this.workflows.get(`${id}@${version}`);
    if (!workflow) throw new Error(`RPA workflow is not installed: ${id}@${version}`);
    return workflow;
  }

  private workflowForRun(run: RpaRun): RpaWorkflowV1 {
    if (run.workflow.id !== run.workflowId || run.workflow.version !== run.workflowVersion) {
      throw new Error(`Persisted RPA workflow binding is invalid for ${run.id}.`);
    }
    return run.workflow;
  }
}

const FORBIDDEN_DESKTOP_ARGUMENTS = new Set([
  'x', 'y', 'coordinate', 'coordinates', 'script', 'javascript', 'shell',
  'command', 'password', 'secret', 'token',
]);

function validateWorkflow(workflow: RpaWorkflowV1): void {
  if (workflow.steps.length === 0 || workflow.steps.length > 100) {
    throw new Error('RPA workflows must contain between 1 and 100 steps.');
  }
  const ids = new Set<string>();
  for (const step of workflow.steps) {
    if (!step.id.trim() || ids.has(step.id)) throw new Error('RPA step ids must be unique and non-empty.');
    ids.add(step.id);
    if (!step.action.startsWith('desktop.')) continue;
    const forbidden = findForbiddenDesktopArgument(step.args);
    if (forbidden) throw new Error(`Desktop RPA argument is forbidden: ${forbidden}`);
    if (step.sideEffect === 'external' && step.requiresApproval !== true) {
      throw new Error(`External desktop RPA step must require approval: ${step.id}`);
    }
  }
}

function findForbiddenDesktopArgument(value: unknown, path = ''): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findForbiddenDesktopArgument(value[index], `${path}[${index}]`);
      if (nested) return nested;
    }
    return undefined;
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_DESKTOP_ARGUMENTS.has(key.toLowerCase())) return nestedPath;
    const nested = findForbiddenDesktopArgument(nestedValue, nestedPath);
    if (nested) return nested;
  }
  return undefined;
}
