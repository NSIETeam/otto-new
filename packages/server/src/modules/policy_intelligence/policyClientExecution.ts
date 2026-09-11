import { randomUUID } from 'node:crypto';
import { PolicyOperationError } from './policyErrors.js';

export type PolicyModelInvoker = (instruction: string, data: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>;
export type PolicyExecutionView =
  | { status: 'running' }
  | { status: 'model'; requestId: string; instruction: string; data: unknown }
  | { status: 'done'; result: unknown }
  | { status: 'failed'; error: string };
interface Job {
  owner: string; scope: string; controller: AbortController; view: PolicyExecutionView;
  pending?: { id: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void };
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout>;
}

/** Foreground-only exchange: credentials never leave the desktop. A lost run is
 * unknown, never automatically restarted. Short requests avoid gateway timeouts. */
export class PolicyClientExecutions {
  private readonly jobs = new Map<string, Job>();
  start(owner: string, scope: string, work: (invoke: PolicyModelInvoker) => Promise<unknown>): string {
    // Completed receipts are a bounded cache, not occupied execution slots.
    if (this.jobs.size >= 8) {
      const finished = [...this.jobs.entries()].find(([, job]) => ['done', 'failed'].includes(job.view.status));
      if (finished) this.remove(finished[0]);
    }
    if (this.jobs.size >= 8 || [...this.jobs.values()].some(job => job.owner === owner && ['running', 'model'].includes(job.view.status))) {
      throw new PolicyOperationError('政策分析正在进行，请等待结果或稍后重试');
    }
    const id = randomUUID();
    const controller = new AbortController();
    const job: Job = { owner, scope, controller, view: { status: 'running' }, listeners: new Set(),
      timer: setTimeout(() => this.remove(id), 210_000) };
    job.timer.unref();
    this.jobs.set(id, job);
    let calls = 0;
    const invoke: PolicyModelInvoker = async (instruction, data, parentSignal) => {
      const signal = AbortSignal.any([parentSignal, controller.signal]);
      signal.throwIfAborted();
      if (++calls > 16 || JSON.stringify(data).length > 500_000 || job.pending) throw new PolicyOperationError('本次政策分析已达到处理上限');
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const abort = () => { job.pending = undefined; reject(new Error('政策分析已取消或超时')); };
        signal.addEventListener('abort', abort, { once: true });
        job.pending = { id: requestId,
          resolve(value) { signal.removeEventListener('abort', abort); resolve(value); },
          reject(error) { signal.removeEventListener('abort', abort); reject(error); },
        };
        job.view = { status: 'model', requestId, instruction, data };
        this.wake(job);
      });
    };
    void Promise.resolve().then(() => work(invoke)).then(result => {
      job.view = { status: 'done', result };
    }, error => {
      job.view = { status: 'failed', error: error instanceof PolicyOperationError ? error.message.slice(0, 300) : '政策分析未完成，请检查当前对话的模型设置或稍后重试' };
    }).finally(() => { job.pending = undefined; this.wake(job); });
    return id;
  }
  private get(id: string, owner: string, scope: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || job.scope !== scope) throw new PolicyOperationError('政策任务不存在、已过期或无权访问；请先查看已有结果，勿重复提交');
    return job;
  }
  async poll(id: string, owner: string, scope: string): Promise<PolicyExecutionView> {
    const job = this.get(id, owner, scope);
    if (job.listeners.size >= 2) throw new PolicyOperationError('政策状态读取过于频繁，请稍后刷新');
    if (job.view.status === 'running') await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); job.listeners.delete(wake); resolve(); };
      const timer = setTimeout(wake, 10_000);
      job.listeners.add(wake);
    });
    return this.get(id, owner, scope).view;
  }
  reply(id: string, owner: string, scope: string, requestId: unknown, result: unknown): void {
    const job = this.get(id, owner, scope);
    if (!job.pending || job.pending.id !== requestId) throw new PolicyOperationError('模型请求已更新，不能重复提交结果');
    if (!result || typeof result !== 'object' || Array.isArray(result) || JSON.stringify(result).length > 500_000) throw new PolicyOperationError('政策模型结果格式错误或过大');
    const pending = job.pending;
    job.pending = undefined;
    job.view = { status: 'running' };
    pending.resolve(result as Record<string, unknown>);
  }
  cancel(id: string, owner: string, scope: string): void { this.get(id, owner, scope); this.remove(id); }
  private remove(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    job.controller.abort();
    job.pending?.reject(new Error('政策分析已取消'));
    this.wake(job);
    this.jobs.delete(id);
  }
  private wake(job: Job): void { for (const wake of job.listeners) wake(); }
}
