/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WorkflowConflictError,
  type ClaimedWorkflowStep,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStepRun,
} from './contracts.js';
import { cloneRun, nextQueuedStep, type WorkflowStore } from './store.js';

function now(): string {
  return new Date().toISOString();
}

function createStepRun(runId: string, step: WorkflowDefinition['steps'][number]): WorkflowStepRun {
  return {
    stepId: step.id,
    kind: step.kind,
    attempt: 0,
    status: 'queued',
    idempotencyKey: `${runId}:${step.id}:0`,
    input: structuredClone(step.input),
    sideEffect: step.sideEffect,
    requiresApproval: step.requiresApproval === true || step.sideEffect === 'external',
  };
}

/**
 * File-backed workflow state for local execution. Every update is written to a
 * temporary file then atomically renamed; a per-run exclusive lease prevents
 * two local workers from claiming or completing the same step.
 */
export class FileWorkflowStore implements WorkflowStore {
  private readonly maxRuns: number;
  private readonly terminalRetentionMs: number;
  private createTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly rootDir: string,
    options: { maxRuns?: number; terminalRetentionMs?: number } = {},
  ) {
    this.maxRuns = options.maxRuns ?? 10_000;
    this.terminalRetentionMs = options.terminalRetentionMs ?? 30 * 24 * 60 * 60_000;
    if (!Number.isSafeInteger(this.maxRuns) || this.maxRuns < 1 || this.maxRuns > 100_000) {
      throw new Error('workflow run file limit is invalid');
    }
    if (!Number.isSafeInteger(this.terminalRetentionMs) || this.terminalRetentionMs < 60_000) {
      throw new Error('workflow terminal retention is invalid');
    }
  }

  async createRun(definition: WorkflowDefinition): Promise<WorkflowRun> {
    this.assertDefinition(definition);
    let result!: WorkflowRun;
    const pending = this.createTail.then(async () => {
      result = await this.createRunExclusive(definition);
    });
    this.createTail = pending.catch(() => undefined);
    await pending;
    return result;
  }

  private async createRunExclusive(definition: WorkflowDefinition): Promise<WorkflowRun> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await this.maintainRunCapacity();
    const id = `wf-${randomUUID()}`;
    const timestamp = now();
    const run: WorkflowRun = {
      id,
      definitionId: definition.id,
      definitionVersion: definition.version,
      status: 'queued',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      steps: definition.steps.map((step) => createStepRun(id, step)),
    };
    await this.writeRun(run);
    return cloneRun(run);
  }

  private async maintainRunCapacity(): Promise<void> {
    const names = (await readdir(this.rootDir))
      .filter((entry) => /^wf-[0-9a-f-]{36}\.json$/u.test(entry));
    // Stay on the cheap directory-count path during ordinary operation. Full
    // run parsing is reserved for actual capacity pressure.
    if (names.length < this.maxRuns) return;
    const runs = await Promise.all(names.map((name) => this.readRun(name.slice(0, -5))));
    const terminal = runs
      .filter((run) => ['succeeded', 'failed', 'cancelled'].includes(run.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    const cutoff = Date.now() - this.terminalRetentionMs;
    const removed = new Set<string>();
    for (const run of terminal) {
      if (Date.parse(run.updatedAt) >= cutoff) continue;
      await unlink(path.join(this.rootDir, `${run.id}.json`));
      removed.add(run.id);
    }
    let count = runs.length - removed.size;
    for (const run of terminal) {
      if (count < this.maxRuns) break;
      if (removed.has(run.id)) continue;
      await unlink(path.join(this.rootDir, `${run.id}.json`));
      removed.add(run.id);
      count -= 1;
    }
    if (count >= this.maxRuns) {
      throw new Error('workflow run file limit reached with no terminal run to prune');
    }
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    this.assertRunId(runId);
    try {
      return cloneRun(await this.readRun(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async listRuns(): Promise<WorkflowRun[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const runs: WorkflowRun[] = [];
    for (const name of names.filter((entry) => /^wf-[0-9a-f-]{36}\.json$/u.test(entry)).sort()) {
      runs.push(cloneRun(await this.readRun(name.slice(0, -5))));
    }
    return runs;
  }

  async claimNextStep(runId: string, expectedRevision: number): Promise<ClaimedWorkflowStep | null> {
    return this.withLease(runId, async () => {
      const run = await this.readRun(runId);
      this.assertRevision(run, expectedRevision);
      if (run.status !== 'queued') return null;
      const step = nextQueuedStep(run);
      if (!step) return null;

      step.status = step.requiresApproval && !step.approvedAt ? 'waiting_approval' : 'running';
      step.attempt += 1;
      step.idempotencyKey = `${run.id}:${step.stepId}:${step.attempt}`;
      step.approvalId = step.status === 'waiting_approval' ? `approval-${run.id}-${step.stepId}-${step.attempt}` : undefined;
      step.startedAt = now();
      run.status = step.status === 'waiting_approval' ? 'waiting_approval' : 'running';
      const saved = await this.saveRevision(run);
      return { run: cloneRun(saved), step: structuredClone(step) };
    });
  }

  async completeStep(input: {
    runId: string;
    stepId: string;
    expectedRevision: number;
    output?: unknown;
    error?: string;
  }): Promise<WorkflowRun> {
    return this.withLease(input.runId, async () => {
      const run = await this.readRun(input.runId);
      // Pause/cancel requests may advance the run revision while the claimed
      // step is executing. The running step identity remains the completion
      // lease; a duplicate completion is rejected by its status below.
      const revisionAdvancedOnlyByControl =
        input.expectedRevision < run.revision
        && Boolean(run.pauseRequestedAt || run.cancelRequestedAt);
      if (input.expectedRevision !== run.revision && !revisionAdvancedOnlyByControl) {
        throw new WorkflowConflictError(
          `Workflow revision conflict: expected ${input.expectedRevision}, found ${run.revision}.`,
        );
      }
      const step = run.steps.find((candidate) => candidate.stepId === input.stepId);
      if (!step || step.status !== 'running') {
        throw new WorkflowConflictError(`Workflow step is not running: ${input.stepId}`);
      }
      step.status = input.error ? 'failed' : 'succeeded';
      step.output = input.output === undefined ? undefined : structuredClone(input.output);
      step.error = input.error;
      step.completedAt = now();
      if (input.error) {
        run.status = 'failed';
      } else if (run.cancelRequestedAt) {
        for (const candidate of run.steps) {
          if (candidate.status === 'queued' || candidate.status === 'waiting_approval') {
            candidate.status = 'cancelled';
            candidate.completedAt = now();
          }
        }
        run.status = 'cancelled';
      } else if (run.pauseRequestedAt && nextQueuedStep(run)) {
        run.status = 'paused';
        run.pauseRequestedAt = undefined;
      } else {
        run.status = nextQueuedStep(run) ? 'queued' : 'succeeded';
      }
      return cloneRun(await this.saveRevision(run));
    });
  }

  async approveStep(input: { runId: string; stepId: string; approvalId: string; expectedRevision: number }): Promise<WorkflowRun> {
    return this.withLease(input.runId, async () => {
      const run = await this.readRun(input.runId);
      this.assertRevision(run, input.expectedRevision);
      const step = run.steps.find((candidate) => candidate.stepId === input.stepId);
      if (run.status !== 'waiting_approval' || !step || step.status !== 'waiting_approval' || step.approvalId !== input.approvalId) {
        throw new WorkflowConflictError(`Workflow step is not waiting for this approval: ${input.stepId}`);
      }
      step.status = 'queued';
      step.approvedAt = now();
      step.approvalId = undefined;
      run.status = 'queued';
      return cloneRun(await this.saveRevision(run));
    });
  }

  async recoverInterruptedRun(runId: string, expectedRevision: number): Promise<WorkflowRun> {
    return this.withLease(runId, async () => {
      const run = await this.readRun(runId);
      this.assertRevision(run, expectedRevision);
      const running = run.steps.find((step) => step.status === 'running');
      if (!running) return cloneRun(run);

      if (running.sideEffect === 'external') {
        running.status = 'unknown_outcome';
        running.error = 'Execution was interrupted after an external side effect began; reconciliation or human takeover is required.';
        run.status = 'unknown_outcome';
      } else {
        running.status = 'queued';
        running.error = undefined;
        running.startedAt = undefined;
        run.status = 'queued';
      }
      return cloneRun(await this.saveRevision(run));
    });
  }

  async takeOverUnknownRun(input: { runId: string; note: string; expectedRevision: number }): Promise<WorkflowRun> {
    return this.withLease(input.runId, async () => {
      const run = await this.readRun(input.runId);
      this.assertRevision(run, input.expectedRevision);
      if (run.status !== 'unknown_outcome') throw new WorkflowConflictError('Workflow run is not in unknown_outcome.');
      const active = run.steps.find((step) => step.status === 'unknown_outcome');
      if (!active) throw new WorkflowConflictError('Workflow run has no unknown step to take over.');
      active.status = 'cancelled';
      active.error = `Human takeover: ${input.note.trim().slice(0, 500) || 'reconciliation required'}`;
      active.completedAt = now();
      run.status = 'cancelled';
      return cloneRun(await this.saveRevision(run));
    });
  }

  async pauseRun(runId: string, expectedRevision: number): Promise<WorkflowRun> {
    return this.withLease(runId, async () => {
      const run = await this.readRun(runId);
      this.assertRevision(run, expectedRevision);
      if (run.status === 'paused') return cloneRun(run);
      if (run.status === 'running') {
        run.pauseRequestedAt = now();
        return cloneRun(await this.saveRevision(run));
      }
      if (run.status !== 'queued' && run.status !== 'waiting_approval') {
        throw new WorkflowConflictError(`Workflow run cannot be paused from ${run.status}.`);
      }
      run.status = 'paused';
      return cloneRun(await this.saveRevision(run));
    });
  }

  async resumeRun(runId: string, expectedRevision: number): Promise<WorkflowRun> {
    return this.withLease(runId, async () => {
      const run = await this.readRun(runId);
      this.assertRevision(run, expectedRevision);
      if (run.status !== 'paused') {
        throw new WorkflowConflictError(`Workflow run cannot be resumed from ${run.status}.`);
      }
      run.pauseRequestedAt = undefined;
      run.status = run.steps.some((step) => step.status === 'waiting_approval')
        ? 'waiting_approval'
        : 'queued';
      return cloneRun(await this.saveRevision(run));
    });
  }

  async cancelRun(runId: string, expectedRevision: number): Promise<WorkflowRun> {
    return this.withLease(runId, async () => {
      const run = await this.readRun(runId);
      this.assertRevision(run, expectedRevision);
      if (run.status === 'cancelled') return cloneRun(run);
      if (run.status === 'running') {
        run.cancelRequestedAt = now();
        run.pauseRequestedAt = undefined;
        return cloneRun(await this.saveRevision(run));
      }
      if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'unknown_outcome') {
        throw new WorkflowConflictError(`Workflow run cannot be cancelled from ${run.status}.`);
      }
      for (const step of run.steps) {
        if (step.status === 'queued' || step.status === 'waiting_approval') {
          step.status = 'cancelled';
          step.completedAt = now();
        }
      }
      run.status = 'cancelled';
      run.pauseRequestedAt = undefined;
      run.cancelRequestedAt = now();
      return cloneRun(await this.saveRevision(run));
    });
  }

  private async withLease<T>(runId: string, action: () => Promise<T>): Promise<T> {
    this.assertRunId(runId);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.rootDir, `${runId}.lock`);
    let lease;
    try {
      lease = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new WorkflowConflictError(`Workflow run is already leased: ${runId}`);
      }
      throw error;
    }
    try {
      return await action();
    } finally {
      await lease.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async readRun(runId: string): Promise<WorkflowRun> {
    const target = this.runPath(runId);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Workflow run record is unsafe.');
    const parsed = JSON.parse(await readFile(target, 'utf8')) as WorkflowRun;
    this.assertRun(parsed);
    return parsed;
  }

  private async saveRevision(run: WorkflowRun): Promise<WorkflowRun> {
    run.revision += 1;
    run.updatedAt = now();
    await this.writeRun(run);
    return run;
  }

  private async writeRun(run: WorkflowRun): Promise<void> {
    const target = this.runPath(run.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  private runPath(runId: string): string {
    this.assertRunId(runId);
    return path.join(this.rootDir, `${runId}.json`);
  }

  private assertDefinition(definition: WorkflowDefinition): void {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(definition.id) || definition.steps.length === 0) {
      throw new Error('Workflow definition is invalid.');
    }
    const ids = new Set<string>();
    for (const step of definition.steps) {
      if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(step.id) || ids.has(step.id)) {
        throw new Error('Workflow step ids must be unique and stable.');
      }
      ids.add(step.id);
    }
  }

  private assertRunId(runId: string): void {
    if (!/^wf-[0-9a-f-]{36}$/u.test(runId)) throw new Error('Workflow run id is invalid.');
  }

  private assertRevision(run: WorkflowRun, expectedRevision: number): void {
    if (run.revision !== expectedRevision) {
      throw new WorkflowConflictError(`Workflow revision conflict: expected ${expectedRevision}, found ${run.revision}.`);
    }
  }

  private assertRun(run: WorkflowRun): void {
    if (!run.id || !Number.isSafeInteger(run.revision) || !Array.isArray(run.steps)) {
      throw new Error('Workflow run record is invalid.');
    }
  }
}
