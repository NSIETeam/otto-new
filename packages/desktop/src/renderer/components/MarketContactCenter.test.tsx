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
