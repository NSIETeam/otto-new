/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { randomUUID } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowTraceEvent } from './contracts.js';

export interface WorkflowTraceSink {
  append(event: Omit<WorkflowTraceEvent, 'eventId' | 'timestamp'>): Promise<void>;
}

export interface FileWorkflowTraceOptions {
  maxBytesPerRun?: number;
  maxTraceFiles?: number;
  retentionMs?: number;
  now?: () => number;
}

const RUN_ID = /^wf-[0-9a-f-]{36}$/u;

/** Bounded local trace sink. Payloads stay redacted summaries, never raw tool output. */
export class FileWorkflowTraceSink implements WorkflowTraceSink {
  private readonly maxBytesPerRun: number;
  private readonly maxTraceFiles: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string, options: FileWorkflowTraceOptions = {}) {
    this.maxBytesPerRun = options.maxBytesPerRun ?? 5 * 1024 * 1024;
    this.maxTraceFiles = options.maxTraceFiles ?? 10_000;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxBytesPerRun) || this.maxBytesPerRun < 1_024) {
      throw new Error('workflow trace byte limit is invalid');
    }
    if (!Number.isSafeInteger(this.maxTraceFiles) || this.maxTraceFiles < 1 || this.maxTraceFiles > 100_000) {
      throw new Error('workflow trace file limit is invalid');
    }
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 60_000) {
      throw new Error('workflow trace retention is invalid');
    }
  }

  async append(event: Omit<WorkflowTraceEvent, 'eventId' | 'timestamp'>): Promise<void> {
    const pending = this.writeTail.then(() => this.appendExclusive(event));
    this.writeTail = pending.catch(() => undefined);
    await pending;
  }

  private async appendExclusive(event: Omit<WorkflowTraceEvent, 'eventId' | 'timestamp'>): Promise<void> {
    if (!RUN_ID.test(event.runId)) throw new Error('workflow trace run id is invalid');
    const record: WorkflowTraceEvent = {
      ...event,
      eventId: randomUUID(),
      timestamp: new Date(this.now()).toISOString(),
    };
    const encoded = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > this.maxBytesPerRun) {
      throw new Error('workflow trace event exceeds the per-run byte limit');
    }
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.rootDir, `${record.runId}.jsonl`);
    let currentBytes = 0;
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('workflow trace target is unsafe');
      currentBytes = metadata.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.admitNewTraceFile();
    }
    if (currentBytes + Buffer.byteLength(encoded, 'utf8') <= this.maxBytesPerRun) {
      await appendFile(target, encoded, { encoding: 'utf8', mode: 0o600 });
      await chmod(target, 0o600);
      return;
    }
    const current = await readFile(target, 'utf8');
    const retained: string[] = [encoded.trimEnd()];
    let retainedBytes = Buffer.byteLength(encoded, 'utf8');
    for (const line of current.trimEnd().split('\n').reverse()) {
      const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
      if (retainedBytes + bytes > this.maxBytesPerRun) break;
      retained.unshift(line);
      retainedBytes += bytes;
    }
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, `${retained.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async admitNewTraceFile(): Promise<void> {
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const traces: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^wf-[0-9a-f-]{36}\.jsonl$/u.test(entry.name)) continue;
      const candidate = path.join(this.rootDir, entry.name);
      traces.push({ path: candidate, mtimeMs: (await lstat(candidate)).mtimeMs });
    }
    if (traces.length < this.maxTraceFiles) return;
    const cutoff = this.now() - this.retentionMs;
    const expired = traces.filter((trace) => trace.mtimeMs < cutoff).sort((a, b) => a.mtimeMs - b.mtimeMs);
    if (expired.length === 0) throw new Error('workflow trace file limit reached with no expired trace to prune');
    await unlink(expired[0]!.path);
  }
}
