import { describe, expect, it, vi } from 'vitest';
import { createParkConversationPlanner } from './parkConversationModel.js';
const request = { text: '灯一直闪', active: [], now: '2026-09-08T03:00:00Z' };
const raw = JSON.stringify({ items: [{ intent: 'repair', mode: 'new', quote: '灯一直闪', fields: [{ key: 'issue', value: '灯一直闪', quote: '灯一直闪' }] }] });
describe('tool-less park conversation model', () => {
  it('deduplicates concurrent identical requests and rejects stale account responses', async () => {
    let finish!: (value: string) => void;
    const generate = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    let scope = 'a';
    const plan = createParkConversationPlanner({ generate, getScope: () => scope });
    const a = plan(request); const b = plan(request);
    await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(1);
    scope = 'b'; finish(raw);
    await expect(a).rejects.toThrow('账号'); await expect(b).rejects.toThrow('账号');
  });
  it('validates input before spending and returns bounded parsed output', async () => {
    const generate = vi.fn(async () => raw);
    const plan = createParkConversationPlanner({ generate, getScope: () => 'a' });
    await expect(plan({ ...request, text: 'x'.repeat(6001) })).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
    expect((await plan(request)).items[0].fields.issue).toBe('灯一直闪');
  });
  it('times out without retrying a model call', async () => {
    vi.useFakeTimers();
    try {
      const generate = vi.fn(() => new Promise<string>(() => {}));
      const plan = createParkConversationPlanner({ generate, getScope: () => 'a', timeoutMs: 10 });
      const result = expect(plan(request)).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(11); await result;
      expect(generate).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
