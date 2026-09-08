import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecruitmentAutosave } from './recruitmentAutosave.js';
import { RecruitmentWorkspaceStore } from './recruitmentWorkspaceStore.js';
import { recruitmentArchiveFingerprint } from './recruitmentArchive.js';
import { RecurringTaskRegistry } from 'otto-core/recurring-tasks';
import type { RecruitmentJobResponse, RecruitmentSharedJob, RecruitmentSyncMetadata } from 'otto-server';

function setup() {
  vi.useFakeTimers();
  const store = new RecruitmentWorkspaceStore('org:hr'); store.setJobTitle('前端');
  let job: RecruitmentSharedJob = { id: 'j1', title: '前端', description: '', revision: 1, candidates: [], collaboratorAccountIds: [], updatedAt: '', updatedBy: 'hr' };
  const sync: RecruitmentSyncMetadata = { scopeToken: 'a'.repeat(64), headerToken: 'b'.repeat(64), candidateTokens: {} };
  store.setSharedJob({ id: job.id, revision: job.revision, base: job, sync, savedFingerprint: recruitmentArchiveFingerprint(store.getSnapshot()) });
  const call = vi.fn(async (action): Promise<RecruitmentJobResponse> => {
    if (action.kind === 'patch') job = { ...job, ...(action.metadata ?? {}), revision: job.revision + 1 };
    return { kind: 'job', job, sync, canManage: true };
  });
  const auto = new RecruitmentAutosave(store, 500, 30_000); const stop = auto.start(call);
  return { store, call, auto, stop };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('account-scoped recruitment autosave lifecycle', () => {
  it('owns a free registered poll and removes it on pause or account teardown', async () => {
    const register = vi.spyOn(RecurringTaskRegistry.prototype, 'register');
    const { auto, call, stop } = setup();
    auto.enable(true);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 30_000, estimatedCostUsdPerRun: 0 }));
    const registry = register.mock.contexts[0] as RecurringTaskRegistry;
    expect(registry.list()).toHaveLength(1);
    auto.pause();
    expect(registry.list()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(call).not.toHaveBeenCalled();
    auto.enable(true); stop();
    expect((register.mock.contexts[1] as RecurringTaskRegistry).list()).toEqual([]);
  });
  it('does not save or poll before explicit confirmation and refuses legacy servers', async () => {
    const { store, auto, call } = setup(); store.setJobTitle('改动'); await vi.advanceTimersByTimeAsync(60_000); expect(call).not.toHaveBeenCalled();
    expect(() => auto.enable(false)).toThrow('确认');
    store.setSharedJob({ id: 'legacy', revision: 1, savedFingerprint: '' }); expect(() => auto.enable(true)).toThrow('升级');
  });
  it('coalesces edits and saves without a mounted dialog; unchanged work does not generate writes', async () => {
    const { store, auto, call } = setup(); auto.enable(true);
    store.setJobTitle('甲'); await vi.advanceTimersByTimeAsync(200); store.setJobTitle('乙'); await vi.advanceTimersByTimeAsync(500);
    expect(call).toHaveBeenCalledOnce(); expect(call.mock.calls[0]?.[0]).toMatchObject({ kind: 'patch', metadata: { title: '乙' } });
    await vi.advanceTimersByTimeAsync(30_000); expect(call.mock.calls.filter(([action]) => action.kind === 'patch')).toHaveLength(1);
    expect(call.mock.calls.some(([action]) => action.kind === 'get')).toBe(true);
  });
  it('pauses on failure without a retry storm, keeps dirty contents, and permits an explicit retry', async () => {
    const { store, auto, call } = setup(); call.mockRejectedValueOnce(new Error('网络中断')); auto.enable(true); store.setJobTitle('待保存');
    await vi.advanceTimersByTimeAsync(500); expect(auto.getSnapshot()).toMatchObject({ enabled: false, phase: 'error' }); expect(store.getSnapshot().jobTitle).toBe('待保存');
    await vi.advanceTimersByTimeAsync(120_000); expect(call).toHaveBeenCalledOnce(); auto.enable(true); await vi.advanceTimersByTimeAsync(500); expect(call).toHaveBeenCalledTimes(2);
  });
  it('cancels queued writes on account stop, workspace replacement and changed sharing scope', async () => {
    for (const reason of ['stop', 'reset', 'scope'] as const) {
      const { store, auto, call, stop } = setup(); auto.enable(true); store.setJobTitle('待保存');
      if (reason === 'stop') stop(); else if (reason === 'reset') store.resetWorkspace(); else store.setSharedJob({ ...store.getSnapshot().sharedJob!, sync: { ...store.getSnapshot().sharedJob!.sync!, scopeToken: 'c'.repeat(64) } });
      await vi.advanceTimersByTimeAsync(1000); expect(call).not.toHaveBeenCalled(); expect(auto.getSnapshot().enabled).toBe(false); stop();
    }
  });
  it('runs only one request at a time and saves edits made in flight in a subsequent batch', async () => {
    const { store, auto, call } = setup(); let resolve!: (result: RecruitmentJobResponse) => void;
    const base = store.getSnapshot().sharedJob!;
    call.mockImplementationOnce(async () => new Promise((done) => { resolve = done; }));
    auto.enable(true); store.setJobTitle('第一批'); await vi.advanceTimersByTimeAsync(500); store.setJobTitle('第二批'); await vi.advanceTimersByTimeAsync(60_000); expect(call).toHaveBeenCalledOnce();
    resolve({ kind: 'job', job: { ...base.base!, title: '第一批', revision: 2 }, sync: base.sync, canManage: true });
    await vi.advanceTimersByTimeAsync(500); expect(call).toHaveBeenCalledTimes(2); expect(store.getSnapshot().jobTitle).toBe('第二批');
  });
  it('ignores late acknowledgements after shutdown and starts a new lifecycle with sharing disabled', async () => {
    const { store, auto, call, stop } = setup(); const base = store.getSnapshot().sharedJob!;
    let resolve!: (result: RecruitmentJobResponse) => void; call.mockImplementationOnce(async () => new Promise((done) => { resolve = done; }));
    auto.enable(true); store.setJobTitle('第一批'); await vi.advanceTimersByTimeAsync(500); stop();
    resolve({ kind: 'job', job: { ...base.base!, title: '第一批', revision: 2 }, sync: base.sync, canManage: true }); await vi.advanceTimersByTimeAsync(1000);
    expect(store.getSnapshot().sharedJob).toBe(base); auto.start(call); expect(auto.getSnapshot().enabled).toBe(false);
  });
});
