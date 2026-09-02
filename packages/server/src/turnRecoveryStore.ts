/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isParallelSafeToolName } from './turnControlPolicy.js';

export type TurnRecoveryReplayClass =
  'replayable' | 'idempotent' | 'never_replay';

export interface TurnRecoveryToolRecord {
  callId: string;
  name: string;
  fingerprint: string;
  replayClass: TurnRecoveryReplayClass;
  state: 'started' | 'succeeded' | 'failed' | 'unknown_outcome';
  startedAt: number;
  completedAt?: number;
  resultSummary?: string;
  errorSummary?: string;
}

export interface TurnRecoveryRecord {
  version: 1;
  sessionId: string;
  turnId: string;
  intentHash: string;
  status: 'active' | 'reconciliation_required';
  attempt: number;
  createdAt: number;
  updatedAt: number;
  reconciliationReason?: string;
  tools: TurnRecoveryToolRecord[];
}

export type TurnRecoveryResolution =
  'confirmed_succeeded' | 'confirmed_not_executed' | 'abandoned';

export interface TurnRecoveryToolInput {
  callId?: string;
  name: string;
  fingerprint: string;
  replayClass: TurnRecoveryReplayClass;
  resultSummary?: string;
  errorSummary?: string;
}

export type TurnRecoveryDecision =
  | { action: 'execute' }
  | { action: 'reuse'; resultSummary: string }
  | { action: 'reconcile'; reason: string };

export class TurnRecoveryCorruptError extends Error {
  constructor(readonly recoveryPath: string) {
    super(`Turn recovery record is corrupt: ${recoveryPath}`);
    this.name = 'TurnRecoveryCorruptError';
  }
}

const IDEMPOTENT_TOOL_NAMES = new Set([
  'apply_patch',
  'create_directory',
  'edit_file',
  'replace',
  'todo_write',
  'update_plan',
  'validate_skill_draft',
  'write_file',
]);

function defaultRoot(): string {
  const userDirectory =
    process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user');
  return path.join(userDirectory, 'turn-recovery');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value))
    return value.map((entry) => stableValue(entry, seen));
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key], seen)]),
  );
}

function redactedSummary(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(
      /\b(?:eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{16,})\b/gu,
      '[REDACTED_TOKEN]',
    )
    .replace(
      /((?:token|api[_-]?key|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
      '$1[REDACTED]',
    )
    .slice(0, 2_000);
}

function isRecoveryRecord(value: unknown): value is TurnRecoveryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<TurnRecoveryRecord>;
  return (
    record.version === 1 &&
    typeof record.sessionId === 'string' &&
    typeof record.turnId === 'string' &&
    typeof record.intentHash === 'string' &&
    (record.status === 'active' ||
      record.status === 'reconciliation_required') &&
    Number.isSafeInteger(record.attempt) &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    Array.isArray(record.tools) &&
    record.tools.every(
      (tool) =>
        typeof tool === 'object' &&
        tool !== null &&
        typeof tool.callId === 'string' &&
        typeof tool.name === 'string' &&
        typeof tool.fingerprint === 'string' &&
        ['replayable', 'idempotent', 'never_replay'].includes(
          tool.replayClass,
        ) &&
        ['started', 'succeeded', 'failed', 'unknown_outcome'].includes(
          tool.state,
        ),
    )
  );
}

export function classifyRecoveryTool(
  toolName: string,
): TurnRecoveryReplayClass {
  const normalized = toolName.trim().toLowerCase();
  if (isParallelSafeToolName(normalized)) return 'replayable';
  if (IDEMPOTENT_TOOL_NAMES.has(normalized)) return 'idempotent';
  // Extension/MCP tools are unknown until reviewed. Failing closed prevents a
  // crash from replaying an external side effect under a misleading name.
  return 'never_replay';
}

export function toolExecutionFingerprint(
  toolName: string,
  parameters: unknown,
): string {
  return hash(
    JSON.stringify({
      name: toolName.trim().toLowerCase(),
      parameters: stableValue(parameters),
    }),
  );
}

export function turnIntentHash(text: string): string {
  return hash(text.trim());
}

export class FileTurnRecoveryStore {
  private readonly pendingWrites = new Map<string, Promise<unknown>>();

  constructor(private readonly root = defaultRoot()) {}

  pathForSession(sessionId: string): string {
    return path.join(this.root, `${hash(sessionId)}.json`);
  }

  private async serialize<T>(
    sessionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.pendingWrites.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.pendingWrites.set(sessionId, pending);
    try {
      return await pending;
    } finally {
      if (this.pendingWrites.get(sessionId) === pending) {
        this.pendingWrites.delete(sessionId);
      }
    }
  }

  private async write(record: TurnRecoveryRecord): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.pathForSession(record.sessionId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async load(sessionId: string): Promise<TurnRecoveryRecord | null> {
    const target = this.pathForSession(sessionId);
    try {
      const parsed = JSON.parse(await readFile(target, 'utf8')) as unknown;
      if (!isRecoveryRecord(parsed) || parsed.sessionId !== sessionId) {
        throw new TurnRecoveryCorruptError(target);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof TurnRecoveryCorruptError) throw error;
      throw new TurnRecoveryCorruptError(target);
    }
  }

  async begin(input: {
    sessionId: string;
    turnId: string;
    intentHash: string;
  }): Promise<TurnRecoveryRecord> {
    return this.serialize(input.sessionId, async () => {
      const existing = await this.load(input.sessionId);
      if (existing) return existing;
      const now = Date.now();
      const record: TurnRecoveryRecord = {
        version: 1,
        sessionId: input.sessionId,
        turnId: input.turnId,
        intentHash: input.intentHash,
        status: 'active',
        attempt: 1,
        createdAt: now,
        updatedAt: now,
        tools: [],
      };
      await this.write(record);
      return record;
    });
  }

  async recoverInterrupted(
    sessionId: string,
  ): Promise<TurnRecoveryRecord | null> {
    return this.serialize(sessionId, async () => {
      const current = await this.load(sessionId);
      if (!current) return null;
      const interrupted = current.tools.some(
        (tool) =>
          tool.state === 'started' && tool.replayClass === 'never_replay',
      );
      const recovered: TurnRecoveryRecord = {
        ...current,
        attempt: current.attempt + 1,
        updatedAt: Date.now(),
        ...(interrupted
          ? {
              status: 'reconciliation_required' as const,
              reconciliationReason: '上次运行在不可安全重放的工具返回前中断',
              tools: current.tools.map((tool) =>
                tool.state === 'started' && tool.replayClass === 'never_replay'
                  ? { ...tool, state: 'unknown_outcome' as const }
                  : tool,
              ),
            }
          : {}),
      };
      await this.write(recovered);
      return recovered;
    });
  }

  decisionForTool(
    record: TurnRecoveryRecord,
    input: Pick<TurnRecoveryToolInput, 'name' | 'fingerprint' | 'replayClass'>,
  ): TurnRecoveryDecision {
    if (record.status === 'reconciliation_required') {
      return {
        action: 'reconcile',
        reason:
          record.reconciliationReason ||
          '上次执行结果未知，禁止在核对前继续调用工具',
      };
    }
    const previous = [...record.tools]
      .reverse()
      .find(
        (tool) =>
          tool.name === input.name && tool.fingerprint === input.fingerprint,
      );
    if (!previous || previous.state === 'failed') return { action: 'execute' };
    if (previous.replayClass === 'replayable') return { action: 'execute' };
    if (previous.state === 'succeeded') {
      return {
        action: 'reuse',
        resultSummary:
          previous.resultSummary || '上次执行已成功，已防止重复执行',
      };
    }
    if (
      previous.state === 'unknown_outcome' ||
      previous.replayClass === 'never_replay'
    ) {
      return {
        action: 'reconcile',
        reason: record.reconciliationReason || '上次执行结果未知，禁止自动重放',
      };
    }
    return { action: 'execute' };
  }

  async recordStarted(
    record: TurnRecoveryRecord,
    input: TurnRecoveryToolInput,
  ): Promise<TurnRecoveryRecord> {
    return this.updateTool(record, input, 'started');
  }

  async recordSucceeded(
    record: TurnRecoveryRecord,
    input: TurnRecoveryToolInput,
  ): Promise<TurnRecoveryRecord> {
    return this.updateTool(record, input, 'succeeded');
  }

  async recordFailed(
    record: TurnRecoveryRecord,
    input: TurnRecoveryToolInput,
  ): Promise<TurnRecoveryRecord> {
    return this.updateTool(record, input, 'failed');
  }

  private async updateTool(
    record: TurnRecoveryRecord,
    input: TurnRecoveryToolInput,
    state: TurnRecoveryToolRecord['state'],
  ): Promise<TurnRecoveryRecord> {
    return this.serialize(record.sessionId, async () => {
      const latest = (await this.load(record.sessionId)) ?? record;
      if (latest.turnId !== record.turnId) {
        throw new Error('turn recovery identity changed during execution');
      }
      const now = Date.now();
      const nextTool: TurnRecoveryToolRecord = {
        callId: input.callId || input.fingerprint.slice(0, 24),
        name: input.name,
        fingerprint: input.fingerprint,
        replayClass: input.replayClass,
        state,
        startedAt:
          latest.tools.find((tool) => tool.fingerprint === input.fingerprint)
            ?.startedAt ?? now,
        ...(state !== 'started' ? { completedAt: now } : {}),
        ...(redactedSummary(input.resultSummary)
          ? { resultSummary: redactedSummary(input.resultSummary) }
          : {}),
        ...(redactedSummary(input.errorSummary)
          ? { errorSummary: redactedSummary(input.errorSummary) }
          : {}),
      };
      const tools = [
        ...latest.tools.filter(
          (tool) => tool.fingerprint !== input.fingerprint,
        ),
        nextTool,
      ];
      const next: TurnRecoveryRecord = {
        ...latest,
        updatedAt: now,
        tools,
      };
      await this.write(next);
      return next;
    });
  }

  async markReconciliationRequired(
    record: TurnRecoveryRecord,
    reason: string,
  ): Promise<TurnRecoveryRecord> {
    return this.serialize(record.sessionId, async () => {
      const latest = (await this.load(record.sessionId)) ?? record;
      const next: TurnRecoveryRecord = {
        ...latest,
        status: 'reconciliation_required',
        reconciliationReason: redactedSummary(reason),
        updatedAt: Date.now(),
        tools: latest.tools.map((tool) =>
          tool.state === 'started'
            ? { ...tool, state: 'unknown_outcome' as const }
            : tool,
        ),
      };
      await this.write(next);
      return next;
    });
  }

  async resolve(
    sessionId: string,
    turnId: string,
    resolution: TurnRecoveryResolution,
  ): Promise<void> {
    await this.serialize(sessionId, async () => {
      const record = await this.load(sessionId);
      if (!record || record.turnId !== turnId) {
        throw new Error('turn recovery record not found');
      }
      await mkdir(path.join(this.root, 'resolved'), { recursive: true });
      const resolved = {
        ...record,
        resolution,
        resolvedAt: Date.now(),
      };
      const target = path.join(
        this.root,
        'resolved',
        `${hash(sessionId)}-${hash(turnId).slice(0, 16)}.json`,
      );
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(resolved, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, target);
      await unlink(this.pathForSession(sessionId));
    });
  }

  async clear(sessionId: string, turnId: string): Promise<void> {
    await this.serialize(sessionId, async () => {
      const record = await this.load(sessionId);
      if (!record || record.turnId !== turnId) return;
      await unlink(this.pathForSession(sessionId)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    });
  }
}
