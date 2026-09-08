import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { MarketAssociatedItems } from './MarketAssociatedItems.js';
it('loads consulted items independently from the visible message page and locates their original messages', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      items: [
        {
          listingId: 'new',
          messageId: 'm2',
          sequence: 220,
          title: '新商品',
          unavailable: false,
        },
      ],
      nextBeforeSequence: 220,
    })
    .mockResolvedValueOnce({
      items: [
        {
          listingId: 'old',
          messageId: 'm1',
          sequence: 1,
          title: '商品不可用',
          unavailable: true,
        },
      ],
      nextBeforeSequence: null,
    });
  Object.assign(window.otto, { enterpriseParkMarket: request });
  const locate = vi.fn().mockResolvedValue(undefined);
  render(
    <MarketAssociatedItems
      conversationId="conversation"
      revision={220}
      onLocate={locate}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '更多关联商品' }));
  fireEvent.click(await screen.findByRole('button', { name: '商品不可用' }));
  await waitFor(() =>
    expect(locate).toHaveBeenCalledWith({
      listingId: 'old',
      messageId: 'm1',
      sequence: 1,
      title: '商品不可用',
      unavailable: true,
    }),
  );
  expect(request.mock.calls[1][0].path).toBe(
    '/conversations/conversation/items?beforeSequence=220',
  );
});
it('refreshes removed item placeholders on older loaded pages even without new messages', async () => {
  vi.useFakeTimers();
  try {
    let removed = false;
    Object.assign(window.otto, {
      enterpriseParkMarket: vi.fn(async (input: { path: string }) =>
        input.path.includes('?')
          ? {
              items: [
                {
                  listingId: 'old',
                  messageId: 'm1',
                  sequence: 1,
                  title: removed ? '商品不可用' : '旧商品',
                  unavailable: removed,
                },
              ],
              nextBeforeSequence: null,
            }
          : {
              items: [
                {
                  listingId: 'new',
                  messageId: 'm2',
                  sequence: 220,
                  title: '新商品',
                  unavailable: false,
                },
              ],
              nextBeforeSequence: 220,
            },
      ),
    });
    const { unmount } = render(
      <MarketAssociatedItems
        conversationId="conversation"
        revision={220}
        onLocate={async () => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '更多关联商品' }));
    });
    expect(screen.getByRole('button', { name: '旧商品' })).toBeTruthy();
    removed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8001);
    });
    expect(screen.queryByRole('button', { name: '旧商品' })).toBeNull();
    expect(screen.getByRole('button', { name: '商品不可用' })).toBeTruthy();
    unmount();
  } finally {
    vi.useRealTimers();
  }
});
