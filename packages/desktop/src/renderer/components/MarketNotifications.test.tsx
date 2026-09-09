/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useMarketNotifications } from './MarketNotifications.js';
const notice = {
  id: 'one',
  kind: 'expired',
  objectId: 'listing',
  createdAt: 100,
  readAt: null,
};
it('drops prior account notices on scope change', async () => {
  let resolveNext!: (v: unknown) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce({ items: [notice], unread: 1, nextCursor: null })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNext = resolve;
        }),
    );
  Object.assign(window.otto, {
    enterpriseParkMarket: request,
    notificationShow: vi.fn(async () => undefined),
    notificationMarkRead: vi.fn(async () => undefined),
  });
  const { result, rerender, unmount } = renderHook(
    ({ scope }) => useMarketNotifications(true, scope),
    { initialProps: { scope: 'server/org/one' } },
  );
  await waitFor(() => expect(result.current.state.unread).toBe(1));
  rerender({ scope: 'server/org/two' });
  await waitFor(() => expect(result.current.state.items).toEqual([]));
  await act(async () =>
    resolveNext({ items: [], unread: 0, nextCursor: null }),
  );
  expect(result.current.state.unread).toBe(0);
  unmount();
});
it('loads older pages while preserving locally confirmed read receipts', async () => {
  const request = vi.fn(async (input: { path: string }) =>
    input.path === '/notifications'
      ? { items: [notice], unread: 1, nextCursor: 'cursor' }
      : input.path.includes('cursor=')
        ? { items: [{ ...notice, id: 'old' }], unread: 1, nextCursor: null }
        : {},
  );
  Object.assign(window.otto, {
    enterpriseParkMarket: request,
    notificationShow: vi.fn(async () => undefined),
    notificationMarkRead: vi.fn(async () => undefined),
  });
  const { result, unmount } = renderHook(() =>
    useMarketNotifications(true, 'server/org/one'),
  );
  await waitFor(() => expect(result.current.state.items).toHaveLength(1));
  await act(() => result.current.markRead('one'));
  await act(() => result.current.loadMore());
  expect(result.current.state.items.map((item) => item.id)).toEqual([
    'one',
    'old',
  ]);
  expect(result.current.state.items[0].readAt).not.toBeNull();
  expect(result.current.state.nextCursor).toBeNull();
  unmount();
});
it('refreshes read receipts from another device on already loaded older pages', async () => {
  vi.useFakeTimers();
  try {
    let remoteRead: number | null = null;
    const request = vi.fn(async (input: { path: string }) =>
      input.path.includes('cursor=')
        ? {
            items: [{ ...notice, id: 'old', readAt: remoteRead }],
            unread: remoteRead === null ? 2 : 1,
            nextCursor: null,
          }
        : {
            items: [notice],
            unread: remoteRead === null ? 2 : 1,
            nextCursor: 'older',
          },
    );
    Object.assign(window.otto, {
      enterpriseParkMarket: request,
      notificationShow: vi.fn(async () => {}),
      notificationMarkRead: vi.fn(async () => {}),
    });
    const { result, unmount } = renderHook(() =>
      useMarketNotifications(true, 'scope'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(() => result.current.loadMore());
    expect(result.current.state.items).toHaveLength(2);
    remoteRead = 1000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8001);
    });
    expect(
      result.current.state.items.find((item) => item.id === 'old')?.readAt,
    ).toBe(1000);
    unmount();
  } finally {
    vi.useRealTimers();
  }
});
