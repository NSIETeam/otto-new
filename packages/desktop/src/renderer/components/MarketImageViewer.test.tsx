/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MarketImageViewer } from './MarketImageViewer.js';
it('loads controlled full-size photos and supports keyboard navigation and Escape', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  const request = vi.fn(async () => ({ data: 'image-fixture' }));
  Object.assign(window.otto, { enterpriseParkMarket: request });
  const close = vi.fn();
  render(
    <MarketImageViewer
      imageIds={['one', 'two']}
      initialIndex={0}
      onClose={close}
    />,
  );
  expect(await screen.findByText('1 / 2')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('dialog', { name: '商品图片预览' }), {
    key: 'ArrowRight',
  });
  expect(await screen.findByText('2 / 2')).toBeTruthy();
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/images/two?format=data' }),
    ),
  );
  fireEvent.keyDown(screen.getByRole('dialog', { name: '商品图片预览' }), {
    key: 'Escape',
  });
  expect(close).toHaveBeenCalledOnce();
});
