import { describe, expect, it, vi } from 'vitest';
import { PolicyClientExecutions } from './policyClientExecution.js';
describe('policy foreground model exchange', () => {
  it('bounds work and requires owner, scope and request id before accepting a result', async () => {
    const jobs = new PolicyClientExecutions();
    const id = jobs.start('a', 'org1', async invoke => ({ value: await invoke('instruction', { public: true }, new AbortController().signal) }));
    const view = await jobs.poll(id, 'a', 'org1');
    expect(view.status).toBe('model');
    await expect(jobs.poll(id, 'b', 'org1')).rejects.toThrow('不存在');
    await expect(jobs.poll(id, 'a', 'org2')).rejects.toThrow('不存在');
    expect(() => jobs.reply(id, 'a', 'org1', 'wrong-id', { ok: true })).toThrow('已更新');
    if (view.status !== 'model') throw new Error('missing request');
    jobs.reply(id, 'a', 'org1', view.requestId, { ok: true });
    expect(() => jobs.reply(id, 'a', 'org1', view.requestId, {})).toThrow('已更新');
    expect(await jobs.poll(id, 'a', 'org1')).toEqual({ status: 'done', result: { value: { ok: true } } });
  });
  it('does not expose provider errors and never silently replays expired work', async () => {
    const jobs = new PolicyClientExecutions();
    const id = jobs.start('a', 'org', async () => { throw new Error('Bearer SECRET'); });
    expect(JSON.stringify(await jobs.poll(id, 'a', 'org'))).not.toContain('SECRET');
    expect(() => jobs.reply('lost-on-restart', 'a', 'org', 'old', {})).toThrow('不存在');
  });
  it('cancels outstanding model work and blocks further replies', async () => {
    const jobs = new PolicyClientExecutions();
    const id = jobs.start('a', 'org', invoke => invoke('instruction', {}, new AbortController().signal));
    const view = await jobs.poll(id, 'a', 'org');
    jobs.cancel(id, 'a', 'org');
    if (view.status !== 'model') throw new Error('missing request');
    expect(() => jobs.reply(id, 'a', 'org', view.requestId, {})).toThrow('不存在');
  });
  it('expires abandoned work and limits one in-flight job per account', async () => {
    vi.useFakeTimers();
    try {
      const jobs = new PolicyClientExecutions();
      const id = jobs.start('a', 'org', invoke => invoke('instruction', {}, new AbortController().signal));
      const view = await jobs.poll(id, 'a', 'org');
      expect(view.status).toBe('model');
      expect(() => jobs.start('a', 'org', async () => ({}))).toThrow('正在进行');
      await vi.advanceTimersByTimeAsync(210_001);
      await expect(jobs.poll(id, 'a', 'org')).rejects.toThrow('已过期');
    } finally { vi.useRealTimers(); }
  });
});
