/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowTraceEvent } from './contracts.js';
import { FileWorkflowTraceSink } from './trace.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function event(runId: string, summary: string): Omit<WorkflowTraceEvent, 'eventId' | 'timestamp'> {
  return { runId, kind: 'run_started', status: 'queued', summary };
}

describe('FileWorkflowTraceSink', () => {
  it('serializes concurrent appends and rolls a run to a valid bounded JSONL tail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-workflow-trace-'));
    roots.push(root);
    const runId = 'wf-00000000-0000-0000-0000-000000000001';
    const sink = new FileWorkflowTraceSink(root, { maxBytesPerRun: 1_024 });
    await Promise.all(Array.from({ length: 20 }, (_, index) => sink.append(event(runId, `event-${index}-${'x'.repeat(80)}`))));
    const text = await readFile(path.join(root, `${runId}.jsonl`), 'utf8');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1_024);
    const records = text.trim().split('\n').map((line) => JSON.parse(line) as WorkflowTraceEvent);
    expect(records.at(-1)?.summary).toContain('event-19-');
    expect(new Set(records.map((record) => record.eventId)).size).toBe(records.length);
  });

  it('prunes only an expired trace when admitting a new run at the file cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-workflow-trace-'));
    roots.push(root);
    const now = 2_000_000;
    const oldId = 'wf-00000000-0000-0000-0000-000000000001';
    const newId = 'wf-00000000-0000-0000-0000-000000000002';
    const sink = new FileWorkflowTraceSink(root, { maxTraceFiles: 1, retentionMs: 60_000, now: () => now });
    await sink.append(event(oldId, 'old'));
    await utimes(path.join(root, `${oldId}.jsonl`), new Date(now - 60_001), new Date(now - 60_001));
    await sink.append(event(newId, 'new'));
    expect(await readdir(root)).toEqual([`${newId}.jsonl`]);
  });

  it('fails closed instead of deleting a recent trace at the file cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-workflow-trace-'));
    roots.push(root);
    const sink = new FileWorkflowTraceSink(root, { maxTraceFiles: 1, retentionMs: 60_000 });
    await sink.append(event('wf-00000000-0000-0000-0000-000000000001', 'recent'));
    await expect(sink.append(event('wf-00000000-0000-0000-0000-000000000002', 'new')))
      .rejects.toThrow('no expired trace');
    expect(await readdir(root)).toHaveLength(1);
  });

  it('rejects a symlink trace target instead of writing outside the trace root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-workflow-trace-'));
    roots.push(root);
    const outside = path.join(root, 'outside.jsonl');
    await writeFile(outside, 'protected\n');
    const runId = 'wf-00000000-0000-0000-0000-000000000001';
    await symlink(outside, path.join(root, `${runId}.jsonl`));
    const sink = new FileWorkflowTraceSink(root);

    await expect(sink.append(event(runId, 'unsafe'))).rejects.toThrow('unsafe');
    expect(await readFile(outside, 'utf8')).toBe('protected\n');
  });
});
