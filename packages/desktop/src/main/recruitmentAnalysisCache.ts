/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { randomUUID } from 'node:crypto';

interface Result<T> { value: T; runId: string; disposition: 'executed' | 'reused' }

/** Process-local only. Failed/cancelled calls are never saved as successful analyses. */
export class RecruitmentAnalysisCache<T> {
  private generation = 0;
  private active = 0;
  private readonly completed = new Map<string, { value: T; runId: string; expires: number }>();
  private readonly pending = new Map<string, Promise<{ value: T; runId: string }>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly options: { now?: () => number; ttlMs?: number; maxEntries?: number; maxConcurrent?: number } = {}) {}

  clear(): void {
    this.generation += 1; this.completed.clear(); this.pending.clear();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }
  private remove(id: string): void {
    this.completed.delete(id); clearTimeout(this.expiryTimers.get(id)); this.expiryTimers.delete(id);
  }

  async run(scope: string, key: string, execute: () => Promise<T>): Promise<Result<T>> {
    const now = this.options.now ?? Date.now;
    const id = JSON.stringify([scope, key]);
    for (const [storedKey, entry] of this.completed) if (entry.expires <= now()) this.remove(storedKey);
    const cached = this.completed.get(id);
    if (cached) return { value: structuredClone(cached.value), runId: cached.runId, disposition: 'reused' };
    const joined = this.pending.get(id);
    if (joined) return { ...structuredClone(await joined), disposition: 'reused' };
    if (this.active >= (this.options.maxConcurrent ?? 2)) throw new Error('正在分析其他材料，请等待完成后重试；本次未发起模型调用');
    const generation = this.generation;
    const runId = randomUUID();
    this.active += 1;
    // Call execute immediately so the in-flight operation owns its cancellation signal.
    const task = (async () => {
      const value = await execute();
      if (generation !== this.generation) throw new Error('招聘账号或授权已变化，已丢弃旧分析结果');
      const entry = { value: structuredClone(value), runId, expires: now() + (this.options.ttlMs ?? 600_000) };
      this.completed.set(id, entry);
      const timer = setTimeout(() => this.remove(id), this.options.ttlMs ?? 600_000);
      timer.unref?.(); this.expiryTimers.set(id, timer);
      while (this.completed.size > (this.options.maxEntries ?? 32)) this.remove(this.completed.keys().next().value!);
      return { value: entry.value, runId };
    })();
    this.pending.set(id, task);
    try { return { ...structuredClone(await task), disposition: 'executed' }; }
    finally { this.active -= 1; if (this.pending.get(id) === task) this.pending.delete(id); }
  }
}
