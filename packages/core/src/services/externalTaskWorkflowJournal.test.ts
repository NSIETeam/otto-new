/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileExternalTaskWorkflowJournalV1 } from './externalTaskWorkflowJournal.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function journal(): Promise<{ root: string; value: FileExternalTaskWorkflowJournalV1 }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'otto-delegate-workflow-'));
  roots.push(root);
  return { root, value: new FileExternalTaskWorkflowJournalV1(root) };
}

async function onlyRun(root: string): Promise<Record<string, unknown>> {
  const names = await readdir(path.join(root, 'runs'));
  return JSON.parse(await readFile(path.join(root, 'runs', names[0]), 'utf8')) as Record<string, unknown>;
}

async function traceKinds(root: string): Promise<string[]> {
  const names = await readdir(path.join(root, 'traces'));
  const content = await readFile(path.join(root, 'traces', names[0]), 'utf8');
  return content.trim().split('\n').map((line) => (JSON.parse(line) as { kind: string }).kind);
}

describe('FileExternalTaskWorkflowJournalV1', () => {
  it('persists an approved external agent step before execution and settles success', async () => {
    const { root, value } = await journal();
    const runId = await value.start({ taskId: 'task-1', agent: 'codex', cwd: '/project' });
    expect(await onlyRun(root)).toMatchObject({ id: runId, status: 'running' });
    await value.settle(runId, { status: 'succeeded', sessionId: 'session-1' });
    expect(await onlyRun(root)).toMatchObject({ status: 'succeeded', steps: [{ status: 'succeeded', output: { status: 'succeeded', sessionId: 'session-1' } }] });
  });

  it('serializes durable ACP progress checkpoints before terminal settlement', async () => {
    const { root, value } = await journal();
    const runId = await value.start({ taskId: 'task-progress', agent: 'codex', cwd: '/project' });
    const first = value.checkpoint(runId, { sessionId: 'native-1', currentTool: 'read_file', toolCallCount: 1 });
    const second = value.checkpoint(runId, { sessionId: 'native-1', currentTool: 'edit_file', toolCallCount: 2, tokenUsed: 120 });
    await Promise.all([first, second]);
    await value.settle(runId, { status: 'succeeded', sessionId: 'native-1' });
    expect(await onlyRun(root)).toMatchObject({
      status: 'succeeded',
      steps: [{
        status: 'succeeded',
        checkpoint: { sessionId: 'native-1', currentTool: 'edit_file', toolCallCount: 2, tokenUsed: 120 },
        output: { status: 'succeeded', sessionId: 'native-1' },
      }],
    });
  });

  it('recovers an interrupted external agent as unknown without replaying it', async () => {
    const { root, value } = await journal();
    const runId = await value.start({ taskId: 'task-2', agent: 'claude-code', cwd: '/project' });
    const recovered = await new FileExternalTaskWorkflowJournalV1(root).recover(runId);
    expect(recovered).toMatchObject({ status: 'unknown_outcome', steps: [{ status: 'unknown_outcome', attempt: 2 }] });
  });

  it('records cancellation as a terminal workflow state', async () => {
    const { root, value } = await journal();
    const runId = await value.start({ taskId: 'task-3', agent: 'codex', cwd: '/project' });
    await value.settle(runId, { status: 'cancelled', sessionId: 'session-3' });
    expect(await onlyRun(root)).toMatchObject({
      status: 'cancelled',
      steps: [{ status: 'cancelled', output: { status: 'cancelled', sessionId: 'session-3' } }],
    });
    expect(await traceKinds(root)).toContain('step_cancelled');
    expect(await traceKinds(root)).not.toContain('step_succeeded');
  });

  it('journals a background shell as the same approved external lifecycle', async () => {
    const { root, value } = await journal();
    const runId = await value.startShell({ taskId: 'shell-1', cwd: '/project' });
    expect(await onlyRun(root)).toMatchObject({
      id: runId,
      definitionId: 'shell-shell-1',
      status: 'running',
      steps: [{
        kind: 'tool',
        status: 'running',
        input: { tool: 'shell', cwd: '/project' },
        sideEffect: 'external',
      }],
    });
  });
});
