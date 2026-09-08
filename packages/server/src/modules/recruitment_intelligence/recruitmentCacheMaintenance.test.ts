import { afterEach, expect, it, vi } from 'vitest';
import { RecurringTaskRegistry } from 'otto-core';
import { startRecruitmentCacheMaintenance } from './recruitmentCacheMaintenance.js';

afterEach(() => vi.useRealTimers());
it('reports a safe error and retries a failed cleanup without exposing payloads', async () => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const registry = new RecurringTaskRegistry({ onError });
  const purgeExpired = vi.fn().mockRejectedValueOnce(new Error('private-candidate-secret')).mockResolvedValue(0);
  startRecruitmentCacheMaintenance({ purgeExpired }, registry);
  await vi.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith('enterprise.recruitment-cache-maintenance', expect.objectContaining({ message: '招聘临时缓存清理失败，将在下次维护时重试' }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(purgeExpired).toHaveBeenCalledTimes(2);
  await registry.shutdown();
});
it('runs bounded, zero-cost maintenance at startup and every minute, and stops cleanly', async () => {
  vi.useFakeTimers();
  const registry = new RecurringTaskRegistry();
  const purgeExpired = vi.fn(async () => 500);
  const stop = startRecruitmentCacheMaintenance({ purgeExpired }, registry);
  await vi.advanceTimersByTimeAsync(0);
  expect(purgeExpired).toHaveBeenCalledExactlyOnceWith(500);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(purgeExpired).toHaveBeenCalledTimes(2);
  stop();
  await registry.shutdown();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(purgeExpired).toHaveBeenCalledTimes(2);
});
it('does not overlap slow cleanup and drains it before shutdown', async () => {
  vi.useFakeTimers();
  const registry = new RecurringTaskRegistry();
  let finish!: (count: number) => void;
  const purgeExpired = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
  startRecruitmentCacheMaintenance({ purgeExpired }, registry);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(purgeExpired).toHaveBeenCalledTimes(1);
  let drained = false;
  const closing = registry.shutdown().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish(0); await closing;
  expect(drained).toBe(true);
});
