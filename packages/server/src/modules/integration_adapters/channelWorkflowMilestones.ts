/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChannelProvider } from './channelConnector.js';
import type { ControllableWorkflowRun, WorkflowControlBackend } from './workflowTaskControlPort.js';

interface ChannelWorkflowOwner {
  provider: ChannelProvider;
  installationId: string;
  tenantId: string;
  providerUserId: string;
  userId: string;
  deviceId: string;
}

interface MilestoneCursor {
  state: string;
  updatedAt: string;
}

interface MilestoneFileV1 {
  version: 1;
  cursors: Record<string, MilestoneCursor>;
}

export interface ChannelWorkflowMilestoneSender {
  send(input: {
    provider: ChannelProvider;
    installationId: string;
    target: string;
    text: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface ChannelWorkflowMilestoneOptions {
  filePath?: string;
}

const NOTIFIABLE = new Set(['running', 'paused', 'succeeded', 'failed', 'cancelled', 'unknown_outcome']);
const LABELS: Record<string, string> = {
  running: '正在执行',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  unknown_outcome: '结果待人工核对',
};

function defaultPath(): string {
  const root = process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user');
  return path.join(root, 'channel-workflow-milestones.json');
}

function ownerOf(run: ControllableWorkflowRun): ChannelWorkflowOwner | null {
  for (const step of run.steps) {
    const value = step.input.origin;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const origin = value as Record<string, unknown>;
    if (!['feishu', 'lark', 'wecom'].includes(String(origin.provider))) continue;
    const fields = ['installationId', 'tenantId', 'providerUserId', 'userId', 'deviceId'] as const;
    if (!fields.every((field) => typeof origin[field] === 'string' && String(origin[field]).trim())) continue;
    return {
      provider: origin.provider as ChannelProvider,
      installationId: String(origin.installationId),
      tenantId: String(origin.tenantId),
      providerUserId: String(origin.providerUserId),
      userId: String(origin.userId),
      deviceId: String(origin.deviceId),
    };
  }
  return null;
}

function deliveryKey(run: ControllableWorkflowRun): string {
  const digest = createHash('sha256')
    .update(`${run.id}\0${run.status}\0${run.updatedAt}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `channel-milestone:${digest}`;
}

/**
 * Projects durable workflow state transitions into bounded chat milestones.
 * It never emits token-level progress and advances its cursor only after the
 * outbound write commits, so reconnects retry the same idempotent receipt.
 */
export class ChannelWorkflowMilestoneNotifierV1 {
  private readonly filePath: string;
  private cursors: Record<string, MilestoneCursor>;

  constructor(
    private readonly workflows: WorkflowControlBackend,
    private readonly sender: ChannelWorkflowMilestoneSender,
    options: ChannelWorkflowMilestoneOptions = {},
  ) {
    this.filePath = options.filePath ?? defaultPath();
    this.cursors = this.load();
  }

  async inputVersion(): Promise<string | undefined> {
    const versions = (await this.workflows.list())
      .filter((run) => ownerOf(run))
      .map((run) => `${run.id}:${run.status}:${run.updatedAt}`)
      .sort();
    return versions.length ? versions.join('|') : undefined;
  }

  async flush(): Promise<void> {
    const runs = (await this.workflows.list())
      .filter((run) => ownerOf(run))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const run of runs) {
      const previous = this.cursors[run.id];
      if (previous?.state === run.status && previous.updatedAt === run.updatedAt) continue;
      if (previous?.state !== run.status && NOTIFIABLE.has(run.status)) {
        const owner = ownerOf(run)!;
        await this.sender.send({
          provider: owner.provider,
          installationId: owner.installationId,
          target: owner.providerUserId,
          text: `${run.definitionId}：${LABELS[run.status] ?? run.status}`,
          idempotencyKey: deliveryKey(run),
        });
      }
      this.cursors[run.id] = { state: run.status, updatedAt: run.updatedAt };
      this.persist();
    }
  }

  private load(): Record<string, MilestoneCursor> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as MilestoneFileV1;
      if (parsed.version !== 1 || !parsed.cursors || typeof parsed.cursors !== 'object') {
        throw new Error('unsupported milestone journal');
      }
      for (const [runId, cursor] of Object.entries(parsed.cursors)) {
        if (!runId || !cursor || typeof cursor.state !== 'string' || typeof cursor.updatedAt !== 'string') {
          throw new Error('invalid milestone cursor');
        }
      }
      return structuredClone(parsed.cursors);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`channel workflow milestone journal is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, cursors: this.cursors })}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
}
