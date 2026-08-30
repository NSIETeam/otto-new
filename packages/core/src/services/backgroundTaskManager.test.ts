/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BackgroundTaskManager,
  type BackgroundTaskEvent,
} from './backgroundTaskManager.js';
import type { DelegateProgress } from '../acp-client/acpAgentClient.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgtask-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function progress(over: Partial<DelegateProgress> = {}): DelegateProgress {
  return { toolCallCount: 0, lastActivityAt: Date.now(), ...over };
}

describe('BackgroundTaskManager structured progress', () => {
  it('merges progress fields and emits task-progress', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const events: BackgroundTaskEvent[] = [];
    mgr.onTaskEvent((e) => events.push(e));

    const task = mgr.createTask('[Claude Code] do x', '/proj', 'claude-code');
    mgr.updateProgress(task.id, progress({
      currentTool: 'Edit foo.ts',
      sessionId: 'session-progress-1',
      toolCallCount: 3,
      plan: [{ content: 'a', status: 'completed' }],
      tokenUsed: 500,
      tokenSize: 1000,
    }));

    const updated = mgr.getTask(task.id)!;
    expect(updated.currentTool).toBe('Edit foo.ts');
    expect(updated.sessionId).toBe('session-progress-1');
    expect(updated.toolCallCount).toBe(3);
    expect(updated.plan).toEqual([{ content: 'a', status: 'completed' }]);
    expect(updated.tokenUsed).toBe(500);
    expect(updated.tokenSize).toBe(1000);
    expect(events.some((e) => e.type === 'task-progress')).toBe(true);
  });
});

describe('BackgroundTaskManager persistence', () => {
  it('persists ACP delegate tasks and reloads them in a new manager', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const task = mgr.createTask('[Codex] build feature', '/proj', 'codex');
    mgr.attachWorkflowRun(task.id, 'wf-01234567-89ab-cdef-0123-456789abcdef');
    task.sessionId = 'sess-123';
    mgr.updateProgress(task.id, progress({ toolCallCount: 2 }));
    mgr.completeTask(task.id, { exitCode: 0 });

    // A fresh manager pointed at the same dir recovers the task.
    const reloaded = new BackgroundTaskManager({ storageDir: dir });
    const got = reloaded.getTask(task.id);
    expect(got).toBeDefined();
    expect(got!.kind).toBe('codex');
    expect(got!.sessionId).toBe('sess-123');
    expect(got!.workflowRunId).toBe('wf-01234567-89ab-cdef-0123-456789abcdef');
    expect(got!.status).toBe('completed');
    expect(got!.restoredFromDisk).toBe(true);
  });

  it('marks a still-running task interrupted with an explicit resume handle on reload', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const task = mgr.createTask('[Claude Code] long job', '/proj', 'claude-code');
    mgr.updateProgress(task.id, progress({ sessionId: 'session-resume-1' }));
    expect(task.status).toBe('running');
    // Simulate a crash: the process dies without a terminal transition.

    const reloaded = new BackgroundTaskManager({ storageDir: dir });
    const got = reloaded.getTask(task.id)!;
    expect(got.status).toBe('interrupted');
    expect(got.error).toContain('重启');
    expect(got.error).toContain('session-resume-1');
    expect(got.error).toContain('不会自动重放');
    expect(got.sessionId).toBe('session-resume-1');
    expect(got.restoredFromDisk).toBe(true);
  });

  it('does NOT persist plain shell tasks', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    mgr.createTask('npm test', '/proj', 'shell');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });

  it('persists a shell compatibility record once it is linked to Workflow', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const task = mgr.createTask('long-running-server', '/proj', 'shell');
    mgr.attachWorkflowRun(task.id, 'wf-01234567-89ab-cdef-0123-456789abcdef');

    const reloaded = new BackgroundTaskManager({ storageDir: dir });
    expect(reloaded.getTask(task.id)).toMatchObject({
      kind: 'shell',
      status: 'interrupted',
      workflowRunId: 'wf-01234567-89ab-cdef-0123-456789abcdef',
      restoredFromDisk: true,
    });
  });

  it('removes the on-disk record when a task is cleared', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const task = mgr.createTask('[Codex] x', '/proj', 'codex');
    mgr.completeTask(task.id, { exitCode: 0 });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    mgr.clearCompletedTasks();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('honors storageDir:null by skipping all disk I/O', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    const task = mgr.createTask('[Codex] x', '/proj', 'codex');
    mgr.completeTask(task.id, { exitCode: 0 });
    // No throw, task tracked in-memory only.
    expect(mgr.getTask(task.id)!.status).toBe('completed');
  });
});

describe('BackgroundTaskManager stop ownership', () => {
  it('invokes a registered stop function exactly once on explicit cancellation', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    const task = mgr.createTask('[Codex] long job', '/proj', 'codex');
    let stops = 0;
    mgr.registerStop(task.id, () => { stops += 1; });
    mgr.cancelTask(task.id);
    mgr.cancelTask(task.id);
    mgr.completeTask(task.id, { exitCode: 0 });
    mgr.failTask(task.id, 'late process error');
    expect(stops).toBe(1);
    expect(mgr.getTask(task.id)?.status).toBe('cancelled');
  });

  it('stops every running task before clearing its records', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    const first = mgr.createTask('[Codex] first', '/one', 'codex');
    const second = mgr.createTask('[Claude Code] second', '/two', 'claude-code');
    const stopped: string[] = [];
    mgr.registerStop(first.id, () => stopped.push(first.id));
    mgr.registerStop(second.id, () => stopped.push(second.id));
    mgr.clearAllTasks();
    expect(stopped.sort()).toEqual([first.id, second.id].sort());
    expect(mgr.getAllTasks()).toEqual([]);
  });
});

describe('BackgroundTaskManager conflict detection (multi-agent parallelism)', () => {
  it('detects a conflict when a new task targets the exact same directory as a running ACP delegate task', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    mgr.createTask('[Claude Code] refactor', '/repo/project-a', 'claude-code');

    const conflict = mgr.findConflictingTask('/repo/project-a');
    expect(conflict).toBeDefined();
    expect(conflict!.kind).toBe('claude-code');
  });

  it('detects a conflict when the new directory is a subdirectory of a running task\'s directory', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    mgr.createTask('[Codex] build', '/repo/project-a', 'codex');

    const conflict = mgr.findConflictingTask('/repo/project-a/src/nested');
    expect(conflict).toBeDefined();
  });

  it('detects a conflict when the new directory is an ancestor of a running task\'s directory', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    mgr.createTask('[Claude Code] edit deep file', '/repo/project-a/src/deep', 'claude-code');

    const conflict = mgr.findConflictingTask('/repo/project-a');
    expect(conflict).toBeDefined();
  });

  it('does NOT flag a conflict for a sibling directory that merely shares a path prefix', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    // '/repo/project-a' and '/repo/project-ab' share the string prefix
    // "/repo/project-a" but are NOT nested — a naive startsWith() check
    // (without the path-separator boundary) would wrongly flag this.
    mgr.createTask('[Claude Code] x', '/repo/project-a', 'claude-code');

    const conflict = mgr.findConflictingTask('/repo/project-ab');
    expect(conflict).toBeUndefined();
  });

  it('does NOT flag a conflict against a completed (non-running) task', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    const task = mgr.createTask('[Codex] x', '/repo/project-a', 'codex');
    mgr.completeTask(task.id, { exitCode: 0 });

    const conflict = mgr.findConflictingTask('/repo/project-a');
    expect(conflict).toBeUndefined();
  });

  it('does NOT flag a conflict against a plain shell task in the same directory', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    mgr.createTask('npm test', '/repo/project-a', 'shell');

    const conflict = mgr.findConflictingTask('/repo/project-a');
    expect(conflict).toBeUndefined();
  });

  it('does NOT flag a conflict for a genuinely unrelated directory', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    mgr.createTask('[Claude Code] x', '/repo/project-a', 'claude-code');

    const conflict = mgr.findConflictingTask('/repo/totally-different-project');
    expect(conflict).toBeUndefined();
  });

  it('allows two ACP delegate tasks to run concurrently in unrelated directories (parallelism preserved)', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    mgr.createTask('[Claude Code] x', '/repo/project-a', 'claude-code');
    mgr.createTask('[Codex] y', '/repo/project-b', 'codex');

    expect(mgr.findConflictingTask('/repo/project-a')).toBeDefined();
    expect(mgr.findConflictingTask('/repo/project-b')).toBeDefined();
    expect(mgr.findConflictingTask('/repo/project-c')).toBeUndefined();
  });
});
