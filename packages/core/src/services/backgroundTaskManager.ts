/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { EventEmitter } from 'events';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DelegateProgress, DelegatePlanEntry } from '../acp-client/acpAgentClient.js';

/** Default on-disk home for persisted delegate tasks: ~/.otto-user/delegate-tasks */
function defaultStorageDir(): string {
  return path.join(os.homedir(), '.otto-user', 'delegate-tasks');
}

/** Tail of `output` kept on disk so a restored task still shows recent activity. */
const PERSISTED_OUTPUT_TAIL = 8_192;
const TASK_ID = /^[a-f0-9]{7,32}$/u;

export interface BackgroundTask {
  id: string;
  command: string;
  directory?: string;
  /** Discriminator: 'shell' for process-based tasks, 'claude-code' / 'codex' for ACP delegate tasks. */
  kind?: 'shell' | 'claude-code' | 'codex';
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  pid?: number;
  startTime: number;
  endTime?: number;
  output: string;
  stderr: string;
  exitCode?: number;
  signal?: string;
  error?: string;
  /** For claude-code tasks: the agent's final answer text. */
  answer?: string;

  // ── Structured delegate-session state (ACP tasks only) ───────────────
  /** Native session id of the external agent — the resume handle. */
  sessionId?: string;
  /** Authoritative durable Workflow run for this compatibility UI record. */
  workflowRunId?: string;
  /** Title of the tool call currently in flight. */
  currentTool?: string;
  /** Number of tool calls started so far. */
  toolCallCount?: number;
  /** Latest execution plan reported by the agent. */
  plan?: DelegatePlanEntry[];
  /** Context tokens used / window size, from the latest usage update. */
  tokenUsed?: number;
  tokenSize?: number;
  /** Epoch ms of the last activity of any kind. */
  lastActivityAt?: number;
  /** True when this record was recovered from disk after a daemon restart. */
  restoredFromDisk?: boolean;
}

export type BackgroundTaskEvent =
  | { type: 'task-started'; task: BackgroundTask }
  | { type: 'task-output'; taskId: string; output: string }
  | { type: 'task-stderr'; taskId: string; stderr: string }
  | { type: 'task-progress'; task: BackgroundTask }
  | { type: 'task-interrupted'; task: BackgroundTask }
  | { type: 'task-completed'; task: BackgroundTask }
  | { type: 'task-failed'; task: BackgroundTask }
  | { type: 'task-cancelled'; task: BackgroundTask };

/** Options for {@link BackgroundTaskManager}. */
export interface BackgroundTaskManagerOptions {
  /**
   * Directory for persisting ACP delegate tasks. Defaults to
   * `~/.otto-user/delegate-tasks`. Pass `null` to disable persistence
   * entirely (used by tests that don't want to touch the real home dir).
   */
  storageDir?: string | null;
  /** Hard cap for the compatibility UI mirror. Durable Workflow remains authoritative. */
  maxTasks?: number;
}

export class BackgroundTaskManager extends EventEmitter {
  private tasks: Map<string, BackgroundTask> = new Map();
  private readonly stopFunctions = new Map<string, () => void>();
  /** Resolved persistence directory, or null when persistence is disabled. */
  private readonly storageDir: string | null;
  private readonly maxTasks: number;

  constructor(options: BackgroundTaskManagerOptions = {}) {
    super();
    this.storageDir =
      options.storageDir === null
        ? null
        : (options.storageDir ?? defaultStorageDir());
    this.maxTasks = options.maxTasks ?? 1_000;
    if (!Number.isSafeInteger(this.maxTasks) || this.maxTasks < 1 || this.maxTasks > 10_000) {
      throw new Error('background task compatibility record limit is invalid');
    }
    this.loadFromDisk();
    this.pruneTerminalTasks(this.maxTasks);
  }

  /** Persist ACP delegates and any compatibility record linked to Workflow. */
  private isPersistable(task: BackgroundTask): boolean {
    return task.kind === 'claude-code' || task.kind === 'codex' || Boolean(task.workflowRunId);
  }

  /**
   * 创建一个新的后台任务
   */
  createTask(command: string, directory?: string, kind?: 'shell' | 'claude-code' | 'codex'): BackgroundTask {
    this.pruneTerminalTasks(this.maxTasks - 1);
    if (this.tasks.size >= this.maxTasks) {
      throw new Error('background task compatibility record limit reached with no terminal task to prune');
    }
    let id: string;
    do { id = randomBytes(8).toString('hex'); } while (this.tasks.has(id));
    const task: BackgroundTask = {
      id,
      command,
      directory,
      kind,
      status: 'running',
      startTime: Date.now(),
      output: '',
      stderr: '',
      toolCallCount: 0,
      lastActivityAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.emit('task-started', { type: 'task-started', task });
    return task;
  }

  /**
   * Merge a structured progress snapshot from the delegated ACP turn into the
   * task record, persist it, and notify subscribers. Drives the live Feishu
   * `/acp-session` dashboard card.
   */
  updateProgress(taskId: string, progress: DelegateProgress): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (progress.currentTool !== undefined) task.currentTool = progress.currentTool.slice(0, 500);
    if (progress.sessionId !== undefined) task.sessionId = progress.sessionId.slice(0, 500);
    task.toolCallCount = Number.isSafeInteger(progress.toolCallCount) && progress.toolCallCount >= 0
      ? progress.toolCallCount : task.toolCallCount;
    if (progress.plan !== undefined) {
      task.plan = progress.plan.slice(0, 100).map((entry) => ({
        ...entry,
        content: entry.content.slice(0, 1_000),
      }));
    }
    if (progress.tokenUsed !== undefined && Number.isFinite(progress.tokenUsed) && progress.tokenUsed >= 0) task.tokenUsed = progress.tokenUsed;
    if (progress.tokenSize !== undefined && Number.isFinite(progress.tokenSize) && progress.tokenSize >= 0) task.tokenSize = progress.tokenSize;
    task.lastActivityAt = Number.isFinite(progress.lastActivityAt) ? progress.lastActivityAt : Date.now();
    this.persist(task);
    this.emit('task-progress', { type: 'task-progress', task });
    return task;
  }

  /** Store only a bounded final snapshot; the durable Workflow trace owns full history. */
  setResult(taskId: string, result: { answer?: string; sessionId?: string }): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (result.answer !== undefined) task.answer = result.answer.slice(0, 32_000);
    if (result.sessionId !== undefined) task.sessionId = result.sessionId.slice(0, 500);
    task.lastActivityAt = Date.now();
    this.persist(task);
    return task;
  }

  attachWorkflowRun(taskId: string, workflowRunId: string): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.workflowRunId = workflowRunId;
    this.persist(task);
    return task;
  }

  /** Register the process-local stop function for a running task. */
  registerStop(taskId: string, stop: () => void): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') {
      throw new Error(`cannot register stop function for inactive task: ${taskId}`);
    }
    if (this.stopFunctions.has(taskId)) {
      throw new Error(`task stop function is already registered: ${taskId}`);
    }
    this.stopFunctions.set(taskId, stop);
  }

  /**
   * 获取任务信息
   */
  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running');
  }

  /**
   * 多 agent 并行冲突检测：判断 `directory` 是否与某个正在运行的 ACP delegate
   * 任务（claude-code / codex）的工作目录"重叠"——同一目录，或一个是另一个的
   * 祖先/后代目录。两个外部 agent 同时在重叠目录树下跑（典型场景：都在改同一个
   * git 仓库）会产生真实的文件写冲突、git index 锁冲突、构建产物互相覆盖等问题。
   *
   * 只检测 ACP delegate 任务（claude-code/codex），不检测 plain shell 任务——
   * shell 命令通常是只读查询或一次性脚本，语义上不像"另一个 agent 在改代码"
   * 那样需要互斥；且 shell 任务量级大、并发跑的场景（构建、测试、lint 并行跑）
   * 本身就是被期望支持的，误报会明显伤害正常工作流。
   *
   * 返回冲突任务本身（便于调用方在错误信息里展示 task id / 已运行时长），
   * 无冲突则返回 undefined。
   */
  findConflictingTask(directory: string): BackgroundTask | undefined {
    const normalize = (p: string) => path.resolve(p).replace(/[/\\]+$/, '');
    const target = normalize(directory);

    const overlaps = (a: string, b: string): boolean => {
      if (a === b) return true;
      const sep = path.sep;
      return a.startsWith(b + sep) || b.startsWith(a + sep);
    };

    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      if (task.kind !== 'claude-code' && task.kind !== 'codex') continue;
      if (!task.directory) continue;
      if (overlaps(target, normalize(task.directory))) {
        return task;
      }
    }
    return undefined;
  }

  /** Maximum size of task.output in characters. Older content is pruned. */
  static readonly OUTPUT_CAP = 200_000;
  static readonly STDERR_CAP = 100_000;

  /**
   * 更新任务输出
   */
  appendOutput(taskId: string, output: string): void {
    const task = this.tasks.get(taskId);
    if (task?.status === 'running') {
      task.output += output;
      // Prune if exceeding cap — keep the tail (most recent output).
      if (task.output.length > BackgroundTaskManager.OUTPUT_CAP) {
        const pruneTo = Math.floor(BackgroundTaskManager.OUTPUT_CAP * 0.7);
        task.output = '…[earlier output pruned]…\n' + task.output.slice(task.output.length - pruneTo);
      }
      this.emit('task-output', { type: 'task-output', taskId, output });
    }
  }

  /**
   * 更新任务错误输出
   */
  appendStderr(taskId: string, stderr: string): void {
    const task = this.tasks.get(taskId);
    if (task?.status === 'running') {
      task.stderr += stderr;
      if (task.stderr.length > BackgroundTaskManager.STDERR_CAP) {
        const pruneTo = Math.floor(BackgroundTaskManager.STDERR_CAP * 0.7);
        task.stderr = '…[earlier stderr pruned]…\n' + task.stderr.slice(task.stderr.length - pruneTo);
      }
      this.emit('task-stderr', { type: 'task-stderr', taskId, stderr });
    }
  }

  /**
   * 标记任务为已完成
   */
  completeTask(
    taskId: string,
    options: { exitCode?: number; signal?: string; error?: string } = {},
  ): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (task?.status === 'running') {
      task.status = 'completed';
      task.endTime = Date.now();
      task.exitCode = options.exitCode;
      task.signal = options.signal;
      task.error = options.error;
      this.stopFunctions.delete(taskId);
      this.persist(task);
      this.emit('task-completed', { type: 'task-completed', task });
    }
    return task;
  }

  /**
   * 标记任务为失败
   */
  failTask(
    taskId: string,
    error: string,
  ): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (task?.status === 'running') {
      task.status = 'failed';
      task.endTime = Date.now();
      task.error = error;
      this.stopFunctions.delete(taskId);
      this.persist(task);
      this.emit('task-failed', { type: 'task-failed', task });
    }
    return task;
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'running') {
      const stop = this.stopFunctions.get(taskId);
      this.stopFunctions.delete(taskId);
      try { stop?.(); } catch { /* cancellation remains visible even if teardown fails */ }
      task.status = 'cancelled';
      task.endTime = Date.now();
      this.persist(task);
      this.emit('task-cancelled', { type: 'task-cancelled', task });
    }
    return task;
  }

  /**
   * 设置任务的 PID
   */
  setTaskPid(taskId: string, pid: number): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.pid = pid;
    }
  }

  /**
   * 清空已完成的任务
   */
  clearCompletedTasks(): void {
    for (const [id, task] of this.tasks.entries()) {
      if (task.status !== 'running') {
        this.tasks.delete(id);
        this.removePersisted(id);
      }
    }
  }

  /**
   * 清空所有任务
   */
  clearAllTasks(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === 'running') {
        const stop = this.stopFunctions.get(id);
        try { stop?.(); } catch { /* continue stopping the remaining tasks */ }
      }
      this.removePersisted(id);
    }
    this.stopFunctions.clear();
    this.tasks.clear();
  }

  /**
   * 监听任务事件
   */
  onTaskEvent(callback: (event: BackgroundTaskEvent) => void): () => void {
    const handler = (event: BackgroundTaskEvent) => callback(event);

    // 监听所有事件——保存每个事件名 + 同一个 handler 引用，
    // 退订时只 off 自己注册的这几个，绝不在共享单例上 removeAllListeners()
    // （那会连带删掉其它订阅者注册的监听器）。
    const eventNames = [
      'task-started',
      'task-output',
      'task-stderr',
      'task-progress',
      'task-interrupted',
      'task-completed',
      'task-failed',
      'task-cancelled',
    ] as const;
    for (const name of eventNames) this.on(name, handler);

    // 返回取消监听函数：只移除本次注册的 handler
    return () => {
      for (const name of eventNames) this.off(name, handler);
    };
  }

  // ── Persistence ──────────────────────────────────────────────────────
  // ACP delegate tasks are persisted as one JSON file per task under
  // `storageDir`, so a daemon restart doesn't lose the user's sessions.
  // All disk I/O is best-effort: a failure must never break task tracking.

  private taskFile(id: string): string | null {
    if (!TASK_ID.test(id)) return null;
    return this.storageDir ? path.join(this.storageDir, `${id}.json`) : null;
  }

  /** Atomically write a task snapshot to disk (temp file + rename). */
  private persist(task: BackgroundTask): void {
    const file = this.taskFile(task.id);
    if (!file || !this.isPersistable(task)) return;
    try {
      fs.mkdirSync(this.storageDir!, { recursive: true, mode: 0o700 });
      // Persist a bounded output tail — enough for a restored snapshot, not
      // the full (potentially huge) transcript.
      const snapshot: BackgroundTask = {
        ...task,
        output:
          task.output.length > PERSISTED_OUTPUT_TAIL
            ? '…[truncated]…\n' + task.output.slice(-PERSISTED_OUTPUT_TAIL)
            : task.output,
        stderr: '',
      };
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort — never throw from persistence
    }
  }

  private removePersisted(id: string): void {
    const file = this.taskFile(id);
    if (!file) return;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }

  /**
   * Load persisted delegate tasks on startup. Any task left `running` from a
   * previous process is normalized to `interrupted` with an explicit recovery
   * note. Its child process did not survive and is never restarted implicitly.
   */
  private loadFromDisk(): void {
    if (!this.storageDir) return;
    let files: string[];
    try {
      files = fs.readdirSync(this.storageDir).filter((f) => /^[a-f0-9]{7,32}\.json$/u.test(f));
    } catch {
      return; // dir doesn't exist yet — nothing to load
    }
    for (const f of files) {
      try {
        const target = path.join(this.storageDir, f);
        const metadata = fs.lstatSync(target);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        const raw = fs.readFileSync(target, 'utf8');
        const task = JSON.parse(raw) as BackgroundTask;
        if (!task?.id || !TASK_ID.test(task.id) || f !== `${task.id}.json`) continue;
        if (task.status === 'running') {
          task.status = 'interrupted';
          const recovery = task.sessionId
            ? `可使用原会话 ${task.sessionId} 显式恢复；系统不会自动重放。`
            : '未保存可恢复会话句柄，需要人工核对后重新发起。';
          task.error = task.error
            ? `${task.error}\n(中断：守护进程已重启；${recovery})`
            : `中断：守护进程在该任务运行期间重启。${recovery}`;
          task.endTime = task.endTime ?? Date.now();
          this.emit('task-interrupted', { type: 'task-interrupted', task });
        }
        task.restoredFromDisk = true;
        this.tasks.set(task.id, task);
        // Re-write the normalized record so a second restart stays consistent.
        this.persist(task);
      } catch {
        // skip corrupt records
      }
    }
  }

  private pruneTerminalTasks(targetSize: number): void {
    if (this.tasks.size <= targetSize) return;
    const terminal = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime) || a.id.localeCompare(b.id));
    for (const task of terminal) {
      if (this.tasks.size <= targetSize) break;
      this.tasks.delete(task.id);
      this.stopFunctions.delete(task.id);
      this.removePersisted(task.id);
    }
  }
}

// 全局单例实例
let globalTaskManager: BackgroundTaskManager | null = null;

export function getBackgroundTaskManager(): BackgroundTaskManager {
  if (!globalTaskManager) {
    // Persistence dir resolution for the process-wide singleton:
    //   - OTTO_DELEGATE_TASKS_DIR overrides the location (any deployment).
    //   - Under vitest, disable persistence so tests never touch the real home.
    //   - Otherwise default to ~/.otto-user/delegate-tasks.
    const override = process.env.OTTO_DELEGATE_TASKS_DIR?.trim();
    const storageDir = override
      ? override
      : process.env.VITEST
        ? null
        : undefined;
    globalTaskManager = new BackgroundTaskManager({ storageDir });
  }
  return globalTaskManager;
}

export function resetBackgroundTaskManager(): void {
  if (globalTaskManager) {
    globalTaskManager.clearAllTasks();
  }
  globalTaskManager = null;
}
