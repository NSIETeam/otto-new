import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MarketDemo } from './MarketDemo.js';
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
});
it('seeds three illustrated products and persists local state without sending business requests', () => {
  const request = vi.fn();
  Object.assign(window.otto, { enterpriseParkMarket: request });
  const props = { scope: 'account-a', onClose: vi.fn(), onExit: vi.fn() };
  const view = render(<MarketDemo {...props} />);
  expect(screen.getAllByRole('img')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /查看 轻薄笔记本电脑/ }));
  fireEvent.click(screen.getByRole('button', { name: '下架' }));
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  expect(
    screen.queryByRole('button', { name: /查看 轻薄笔记本电脑/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '我的发布记录' }));
  expect(screen.getAllByRole('img')).toHaveLength(3);
  view.unmount();
  render(<MarketDemo {...props} />);
  expect(
    screen.queryByRole('button', { name: /查看 轻薄笔记本电脑/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重置演示数据' }));
  expect(
    screen.getByRole('button', { name: /查看 轻薄笔记本电脑/ }),
  ).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
});
it('supports favorite, reservation, relist, sale and local publication', () => {
  render(<MarketDemo scope="account-b" onClose={vi.fn()} onExit={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /查看 轻薄笔记本电脑/ }));
  fireEvent.click(screen.getByRole('button', { name: '收藏' }));
  fireEvent.click(screen.getByRole('button', { name: '预留' }));
  expect(screen.getByRole('button', { name: '取消预留' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '标记售出' }));
  fireEvent.click(screen.getByRole('button', { name: '重新上架' }));
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  fireEvent.click(screen.getByRole('button', { name: '我的收藏' }));
  expect(screen.getAllByRole('img')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '发布闲置' }));
  fireEvent.change(screen.getByLabelText('商品标题'), {
    target: { value: '测试电脑支架' },
  });
  fireEvent.change(screen.getByLabelText('价格（元，0为免费送）'), {
    target: { value: '0' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存演示商品' }));
  expect(
    screen.getByRole('button', { name: /查看 测试电脑支架/ }),
  ).toBeTruthy();
});
