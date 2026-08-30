/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileDelegateWorkflowJournalV1 } from './delegateWorkflowJournal.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function journal(): Promise<{ root: string; value: FileDelegateWorkflowJournalV1 }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'otto-delegate-workflow-'));
  roots.push(root);
  return { root, value: new FileDelegateWorkflowJournalV1(root) };
}

async function onlyRun(root: string): Promise<Record<string, unknown>> {
  const names = await readdir(path.join(root, 'runs'));
  return JSON.parse(await readFile(path.join(root, 'runs', names[0]), 'utf8')) as Record<string, unknown>;
}

describe('FileDelegateWorkflowJournalV1', () => {
  it('persists an approved external agent step before execution and settles success', async () => {
    const { root, value } = await journal();
    const runId = await value.start({ taskId: 'task-1', agent: 'codex', cwd: '/project' });
    expect(await onlyRun(root)).toMatchObject({ id: runId, status: 'running' });
    await value.settle(runId, { status: 'succeeded', sessionId: 'session-1' });
    expect(await onlyRun(root)).toMatchObject({ status: 'succeeded', steps: [{ status: 'succeeded', output: { status: 'succeeded', sessionId: 'session-1' } }] });
  });

  it('recovers an interrupted external agent as unknown without replaying it', async () => {
    const { root, value } = await journal();
    const runId = await value.start({ taskId: 'task-2', agent: 'claude-code', cwd: '/project' });
    const recovered = await new FileDelegateWorkflowJournalV1(root).recover(runId);
    expect(recovered).toMatchObject({ status: 'unknown_outcome', steps: [{ status: 'unknown_outcome', attempt: 2 }] });
  });

  it('records cancellation as a terminal workflow state', async () => {
    const { root, value } = await journal();
    const runId = await value.start({ taskId: 'task-3', agent: 'codex', cwd: '/project' });
    await value.settle(runId, { status: 'cancelled', sessionId: 'session-3' });
    expect(await onlyRun(root)).toMatchObject({ status: 'cancelled' });
  });
});
