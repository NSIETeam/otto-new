import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { MarketContactCenter } from './MarketContactCenter.js';
it('offers older contact history without dropping the current conversation page', async () => {
  const request = vi.fn(async (input: { path: string }) =>
    input.path.includes('cursor=')
      ? {
          requests: [],
          conversations: [
            { id: 'old', account_a: 'buyer', account_b: 'older-peer' },
          ],
          nextCursor: null,
        }
      : {
          requests: [],
          conversations: [
            { id: 'new', account_a: 'buyer', account_b: 'newer-peer' },
          ],
          nextCursor: 'older',
        },
  );
  Object.assign(window.otto, { enterpriseParkMarket: request });
  render(<MarketContactCenter accountId="buyer" />);
  fireEvent.click(
    await screen.findByRole('button', { name: '加载更早咨询记录' }),
  );
  expect(
    await screen.findByRole('button', { name: /older-peer/ }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: /newer-peer/ })).toBeTruthy();
});

it('keeps attachment and request identity on send failure, rejects excess files and clears only after confirmation', async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValue({});
  Object.assign(window.otto, {
    enterpriseParkMarket: vi.fn(async (input: { path: string }) =>
      input.path === '/contacts'
        ? {
            requests: [],
            conversations: [
              { id: 'chat', account_a: 'buyer', account_b: 'seller' },
            ],
          }
        : { items: [], nextBeforeSequence: null },
    ),
    enterpriseMarketMessages: vi.fn(async () => ({
      items: [],
      writable: true,
      latestSequence: 0,
      nextBeforeSequence: null,
    })),
    enterpriseMarketSend: send,
  });
  const view = render(<MarketContactCenter accountId="buyer" />);
  fireEvent.click(
    await screen.findByRole('button', { name: /商品会话.*seller/ }),
  );
  const chooser = await screen.findByLabelText('聊天附件（最多6个，每个10MB）');
  fireEvent.change(chooser, {
    target: {
      files: Array.from({ length: 7 }, (_, i) => new File(['x'], `${i}.txt`)),
    },
  });
  expect(await screen.findByText('最多6个附件，请减少选择')).toBeTruthy();
  fireEvent.change(chooser, {
    target: {
      files: [new File(['test'], 'fixture.txt', { type: 'text/plain' })],
    },
  });
  await screen.findByRole('button', { name: '移除附件 fixture.txt' });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await screen.findByText('Error: connection lost');
  expect(
    screen.getByRole('button', { name: '移除附件 fixture.txt' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  await import('@testing-library/react').then(({ waitFor }) =>
    waitFor(() =>
      expect(
        screen.queryByRole('button', { name: '移除附件 fixture.txt' }),
      ).toBeNull(),
    ),
  );
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  expect(send.mock.calls[0][0].attachments[0]).toMatchObject({
    fileName: 'fixture.txt',
    size: 4,
    data: 'dGVzdA==',
  });
  view.unmount();
});
