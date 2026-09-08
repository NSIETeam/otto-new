import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePolicyInbox } from './usePolicyInbox.js';
import type { PolicyInbox } from '../preload/index.js';
afterEach(() => vi.restoreAllMocks());
describe('policy inbox read/refresh races', () => {
  it('explains an old server without exposing raw IPC error details', async () => {
    Object.assign(window.otto, {
      policyIntelligenceInbox: vi.fn(async () => {
        throw new Error(
          '企业服务器版本过旧或功能不完整，请联系管理员升级后重试',
        );
      }),
    });
    const hook = renderHook(() => usePolicyInbox('org:a', true));
    await waitFor(() => expect(hook.result.current.error).toContain('升级'));
    expect(hook.result.current.inbox.notices).toEqual([]);
    hook.unmount();
  });
  it('keeps the mailbox when a read acknowledgement is malformed', async () => {
    Object.assign(window.otto, {
      policyIntelligenceInbox: vi.fn(async ({ ids }: { ids?: string[] }) =>
        ids
          ? { unexpected: true }
          : { notices: [], unreadCount: 1, watchedPolicyIds: ['p'] },
      ),
    });
    const hook = renderHook(() => usePolicyInbox('org:a', true));
    await waitFor(() => expect(hook.result.current.inbox.unreadCount).toBe(1));
    await act(async () => hook.result.current.read(['a'.repeat(64)]));
    expect(hook.result.current.inbox.unreadCount).toBe(1);
    expect(hook.result.current.error).toContain('未保存');
    hook.unmount();
  });
  it('does not restore unread state from a stale poll or expose a previous account mailbox', async () => {
    let finish!: (v: PolicyInbox) => void;
    const pending = new Promise<PolicyInbox>((resolve) => {
      finish = resolve;
    });
    const unread = { notices: [], unreadCount: 1, watchedPolicyIds: ['p'] };
    const read = { ...unread, unreadCount: 0 };
    Object.assign(window.otto, {
      policyIntelligenceInbox: vi.fn(({ ids }: { ids?: string[] }) =>
        ids ? Promise.resolve(read) : pending,
      ),
    });
    const hook = renderHook(({ scope }) => usePolicyInbox(scope, true), {
      initialProps: { scope: 'org:a' },
    });
    await act(async () => hook.result.current.read(['a'.repeat(64)]));
    expect(hook.result.current.inbox.unreadCount).toBe(0);
    await act(async () => finish(unread));
    expect(hook.result.current.inbox.unreadCount).toBe(0);
    Object.assign(window.otto, {
      policyIntelligenceInbox: vi.fn(async () => ({
        notices: [],
        unreadCount: 0,
        watchedPolicyIds: [],
      })),
    });
    hook.rerender({ scope: 'org:b' });
    expect(hook.result.current.inbox.watchedPolicyIds).toEqual([]);
    await waitFor(() =>
      expect(window.otto.policyIntelligenceInbox).toHaveBeenCalledWith({
        scopeId: 'org:b',
      }),
    );
    hook.unmount();
  });
});
