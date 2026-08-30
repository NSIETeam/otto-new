/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { WorkflowRun } from './contracts.js';
import type { WorkflowRuntime } from './runtime.js';
import type { WorkflowStore } from './store.js';

export interface ResidentWorkflowSupervisorOptions {
  maxConcurrentRuns?: number;
}

/**
 * Drives durable workflows one persisted step at a time. Scheduling belongs
 * to the host's recurring-task registry; this class deliberately owns no
 * timer, process daemon, UI, or channel adapter.
 */
export class ResidentWorkflowSupervisor {
  private readonly maxConcurrentRuns: number;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: WorkflowStore,
    private readonly runtime: WorkflowRuntime,
    options: ResidentWorkflowSupervisorOptions = {},
  ) {
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 2;
    if (!Number.isSafeInteger(this.maxConcurrentRuns) || this.maxConcurrentRuns < 1 || this.maxConcurrentRuns > 16) {
      throw new Error('resident workflow concurrency must be between 1 and 16');
    }
  }

  async list(): Promise<WorkflowRun[]> {
    return this.store.listRuns();
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    return this.store.getRun(runId);
  }

  async inputVersion(): Promise<string | undefined> {
    const active = (await this.store.listRuns())
      .filter((run) => run.status === 'queued')
      .map((run) => `${run.id}:${run.revision}`)
      .sort();
    return active.length > 0 ? active.join('|') : undefined;
  }

  async recoverInterrupted(): Promise<WorkflowRun[]> {
    const interrupted = (await this.store.listRuns())
      .filter((run) => run.status === 'running');
    const recovered: WorkflowRun[] = [];
    for (const run of interrupted) {
      const next = await this.runtime.recover(run.id);
      if (next) recovered.push(next);
    }
    return recovered;
  }

  async tick(): Promise<WorkflowRun[]> {
    const candidates = (await this.store.listRuns())
      .filter((run) => run.status === 'queued' && !this.inFlight.has(run.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.maxConcurrentRuns);
    return Promise.all(candidates.map(async (run) => {
      this.inFlight.add(run.id);
      try {
        return await this.runtime.runNext(run.id) ?? run;
      } finally {
        this.inFlight.delete(run.id);
      }
    }));
  }

  pause(runId: string): Promise<WorkflowRun | null> {
    return this.runtime.pause(runId);
  }

  resume(runId: string): Promise<WorkflowRun | null> {
    return this.runtime.resume(runId);
  }

  cancel(runId: string): Promise<WorkflowRun | null> {
    return this.runtime.cancel(runId);
  }

  approve(runId: string, stepId: string, approvalId: string): Promise<WorkflowRun | null> {
    return this.runtime.approve(runId, stepId, approvalId);
  }

  takeOver(runId: string, note: string): Promise<WorkflowRun | null> {
    return this.runtime.takeOver(runId, note);
  }
}
