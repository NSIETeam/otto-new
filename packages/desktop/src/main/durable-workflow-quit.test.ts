/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import type { WorkflowRun } from 'otto-workflow';
import { cancelDurableWorkflowsForQuit } from './durable-workflow-quit.js';

function run(id: string, status: WorkflowRun['status']): WorkflowRun {
  return {
    id,
    definitionId: 'test',
    definitionVersion: 1,
    status,
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    steps: [],
  };
}

describe('durable workflow quit policy', () => {
  it('records cancellation only for non-terminal workflows', async () => {
    const cancel = vi.fn(async (id: string) => run(id, 'cancelled'));
    const result = await cancelDurableWorkflowsForQuit({
      listRuns: async () => [
        run('queued', 'queued'),
        run('running', 'running'),
        run('approval', 'waiting_approval'),
        run('paused', 'paused'),
        run('done', 'succeeded'),
      ],
      cancel,
    });

    expect(cancel.mock.calls.map(([id]) => id)).toEqual(['queued', 'running', 'approval', 'paused']);
    expect(result).toEqual({ requested: ['queued', 'running', 'approval', 'paused'], failed: [] });
  });

  it('reports a failed cancellation without skipping the remaining workflows', async () => {
    const result = await cancelDurableWorkflowsForQuit({
      listRuns: async () => [run('first', 'queued'), run('second', 'paused')],
      cancel: async (id) => {
        if (id === 'first') throw new Error('disk full');
        return run(id, 'cancelled');
      },
    });

    expect(result.requested).toEqual(['second']);
    expect(result.failed).toEqual([{ runId: 'first', error: 'disk full' }]);
  });

  it('keeps shutdown cleanup progressing when the workflow store is unavailable', async () => {
    await expect(cancelDurableWorkflowsForQuit({
      listRuns: async () => { throw new Error('store unavailable'); },
      cancel: async () => null,
    })).resolves.toEqual({
      requested: [],
      failed: [{ runId: '*', error: 'store unavailable' }],
    });
  });
});
