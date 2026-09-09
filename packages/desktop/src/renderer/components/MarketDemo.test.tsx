import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MarketDemo } from './MarketDemo.js';
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
const props = { scope: 'buyer', onClose: vi.fn(), onExit: vi.fn() };
it('separates buyer discovery from owned listings and preserves ownership when browsing own item', () => {
  render(<MarketDemo {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /查看 轻薄笔记本电脑/ }));
  expect(screen.getByRole('button', { name: '联系卖家' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '编辑商品' })).toBeNull();
  expect(screen.queryByRole('button', { name: '下架' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '我的发布记录' }));
  expect(screen.getAllByRole('img')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /查看 机械键盘/ }));
  expect(screen.queryByRole('button', { name: '联系卖家' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新上架' }));
  fireEvent.click(screen.getByRole('button', { name: '逛市场' }));
  fireEvent.click(screen.getByRole('button', { name: /查看 机械键盘/ }));
  expect(screen.getByRole('button', { name: '编辑商品' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下架' }));
});
it('requires explicit first send, prevents pending spam, and continues accepted chat after reopen without network calls', () => {
  const request = vi.fn();
  const send = vi.fn();
  Object.assign(window.otto, {
    enterpriseParkMarket: request,
    enterpriseMarketSend: send,
  });
  const mounted = render(<MarketDemo {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /查看 轻薄笔记本电脑/ }));
  fireEvent.click(screen.getByRole('button', { name: '联系卖家' }));
  expect(screen.queryByText('等待卖家回复')).toBeNull();
  fireEvent.change(screen.getByLabelText('你的问题（1–500字）'), {
    target: { value: '可以检查电池吗？' },
  });
  fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
  expect(screen.getByText('等待卖家回复')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '发送消息' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '模拟卖家回复并接受' }));
  fireEvent.change(screen.getByLabelText('消息内容'), {
    target: { value: '我六点到大厅。' },
  });
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(screen.getByText('我六点到大厅。')).toBeTruthy();
  mounted.unmount();
  render(<MarketDemo {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /查看 轻薄笔记本电脑/ }));
  fireEvent.click(screen.getByRole('button', { name: '继续聊天' }));
  expect(screen.getByText('我六点到大厅。')).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it('blocks a new inquiry on reserved items while allowing favorites', () => {
  render(<MarketDemo {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /查看 24英寸/ }));
  expect(
    (screen.getByRole('button', { name: '联系卖家' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText('商品已预留，暂不接受新咨询。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '收藏' }));
  fireEvent.click(screen.getByRole('button', { name: '我的收藏' }));
  expect(screen.getAllByRole('img')).toHaveLength(1);
});
it('publishes to the current seller and resets the three sample products', () => {
  render(<MarketDemo {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '发布闲置' }));
  fireEvent.change(screen.getByLabelText('商品标题'), {
    target: { value: '我的支架' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存演示商品' }));
  expect(screen.getAllByRole('img')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '重置演示数据' }));
  fireEvent.click(screen.getByRole('button', { name: '我的发布记录' }));
  expect(screen.getAllByRole('img')).toHaveLength(1);
});
