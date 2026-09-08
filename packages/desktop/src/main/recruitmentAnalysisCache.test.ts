import { describe, expect, it, vi } from 'vitest';
import { RecruitmentAnalysisCache } from './recruitmentAnalysisCache.js';

describe('recruitment analysis reuse boundary', () => {
  it('evicts idle cache entries on expiry and cancels timers on clear', async () => {
    vi.useFakeTimers();
    try {
      const cache = new RecruitmentAnalysisCache<string>({ ttlMs: 100 }); const model = vi.fn(async () => 'ok');
      await cache.run('a', 'x', model); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100); expect(vi.getTimerCount()).toBe(0);
      await cache.run('a', 'x', model); expect(model).toHaveBeenCalledTimes(2);
      cache.clear(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('coalesces duplicate requests, reuses results, and isolates accounts and model/rule keys', async () => {
    const cache = new RecruitmentAnalysisCache<string>(); const model = vi.fn(async () => 'evaluation');
    const [first, joined] = await Promise.all([cache.run('account-a', 'model-v1:input-a', model), cache.run('account-a', 'model-v1:input-a', model)]);
    expect(model).toHaveBeenCalledOnce(); expect(first.disposition).toBe('executed'); expect(joined.disposition).toBe('reused'); expect(first.runId).toBe(joined.runId);
    expect((await cache.run('account-a', 'model-v1:input-a', model)).runId).toBe(first.runId);
    await cache.run('account-a', 'model-v2:input-a', model); await cache.run('account-b', 'model-v1:input-a', model); expect(model).toHaveBeenCalledTimes(3);
  });
  it('does not cache failures or share mutable returned objects', async () => {
    const cache = new RecruitmentAnalysisCache<{ score: number }>();
    await expect(cache.run('a', 'x', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    const first = await cache.run('a', 'x', async () => ({ score: 60 })); first.value.score = 100;
    expect((await cache.run('a', 'x', async () => ({ score: 10 }))).value.score).toBe(60);
  });
  it('limits cached lifetime and concurrency without treating failed calls as free', async () => {
    let now = 0; const cache = new RecruitmentAnalysisCache<string>({ now: () => now, ttlMs: 100, maxEntries: 1, maxConcurrent: 1 });
    const model = vi.fn(async () => 'ok'); await cache.run('a', 'x', model); now = 101;
    expect((await cache.run('a', 'x', model)).disposition).toBe('executed'); expect(model).toHaveBeenCalledTimes(2);
    let release!: (value: string) => void; const pending = cache.run('a', 'y', async () => new Promise<string>((resolve) => { release = resolve; }));
    await expect(cache.run('a', 'z', model)).rejects.toThrow('正在分析'); release('ok'); await pending;
    expect((await cache.run('a', 'x', model)).disposition).toBe('executed');
  });
  it('does not repopulate or deliver a cleared account cache from an old in-flight request', async () => {
    const cache = new RecruitmentAnalysisCache<string>(); let release!: (value: string) => void;
    const pending = cache.run('a', 'x', async () => new Promise<string>((resolve) => { release = resolve; }));
    cache.clear(); release('old'); await expect(pending).rejects.toThrow('已变化');
    expect((await cache.run('b', 'x', async () => 'new')).value).toBe('new');
  });
});
