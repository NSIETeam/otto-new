/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import os from 'node:os';
import path from 'node:path';
import {
  FileWorkflowStore,
  FileWorkflowTraceSink,
  WorkflowRuntime,
  type WorkflowRun,
} from 'otto-workflow';

const ACTIVE_STATUSES = new Set<WorkflowRun['status']>([
  'queued',
  'running',
  'waiting_approval',
  'paused',
]);

export interface DurableWorkflowQuitReport {
  requested: string[];
  failed: Array<{ runId: string; error: string }>;
}

interface WorkflowQuitBackend {
  listRuns(): Promise<WorkflowRun[]>;
  cancel(runId: string): Promise<WorkflowRun | null>;
}

function workflowRoot(): string {
  const userDirectory = process.env['OTTO_USER_DIR']?.trim()
    || path.join(os.homedir(), '.otto-user');
  return path.join(userDirectory, 'durable-workflows');
}

function defaultBackend(): WorkflowQuitBackend {
  const root = workflowRoot();
  const store = new FileWorkflowStore(path.join(root, 'runs'));
  const runtime = new WorkflowRuntime(
    store,
    { execute: async () => { throw new Error('workflow steps cannot execute during application shutdown'); } },
    new FileWorkflowTraceSink(path.join(root, 'traces')),
  );
  return { listRuns: () => store.listRuns(), cancel: (runId) => runtime.cancel(runId) };
}

/** Persist cancellation before the host exits; never replays an active step. */
export async function cancelDurableWorkflowsForQuit(
  backend: WorkflowQuitBackend = defaultBackend(),
): Promise<DurableWorkflowQuitReport> {
  const report: DurableWorkflowQuitReport = { requested: [], failed: [] };
  let active: WorkflowRun[];
  try {
    active = (await backend.listRuns()).filter((run) => ACTIVE_STATUSES.has(run.status));
  } catch (error) {
    report.failed.push({
      runId: '*',
      error: error instanceof Error ? error.message : String(error),
    });
    return report;
  }
  for (const run of active) {
    try {
      const next = await backend.cancel(run.id);
      if (!next) throw new Error('workflow disappeared before cancellation was recorded');
      report.requested.push(run.id);
    } catch (error) {
      report.failed.push({
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
