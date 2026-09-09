import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InboxPage } from './InboxPage.js';
import type { EnterpriseAccount } from '../../preload/index.js';
vi.mock('./MarketContactCenter.js', () => ({ MarketContactCenter: ({ onOpenPrivate }: {onOpenPrivate?: unknown}) => <section aria-label="商品咨询">{onOpenPrivate ? '错误的私聊接入' : '独立商品会话'}<input aria-label="商品草稿" /></section> }));
vi.mock('./CarpoolRequestCenter.js', () => ({ CarpoolRequestCenter: ({mode, showDataManagement}: {mode?: string; showDataManagement?: boolean}) => <section aria-label="同行请求与状态">{mode !== 'personal' && '园区同行统计'}{showDataManagement !== false && '删除我的同行数据'}</section> }));
afterEach(cleanup);
it('keeps the original inbox default and isolates business messages without losing drafts', async () => {
  window.otto = {} as typeof window.otto;
  render(<InboxPage enterpriseAccount={{id:'account',organizationId:'org',status:'active'} as EnterpriseAccount} effectiveParkService={false} marketNotifications={<section aria-label="商品通知">暂无商品通知</section>} onBack={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole('tablist', {name:'消息过滤'})).toBeTruthy();
  expect(screen.queryByLabelText('商品咨询')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'商品消息'}));
  expect(screen.queryByRole('tablist', {name:'消息过滤'})).toBeNull();
  expect(screen.getByText('独立商品会话')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('商品草稿'), {target:{value:'保留草稿'}});
  fireEvent.click(screen.getByRole('button', {name:'会话'}));
  expect(screen.getByRole('tablist', {name:'消息过滤'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name:'商品消息'}));
  expect((screen.getByLabelText('商品草稿') as HTMLInputElement).value).toBe('保留草稿');
});
it('shows personal carpool messages without administration in the inbox', async () => {
  window.otto = {enterpriseTicketList:vi.fn(async()=>[])} as unknown as typeof window.otto;
  render(<InboxPage enterpriseAccount={{id:'account',organizationId:'org',status:'active'} as EnterpriseAccount} effectiveParkService onBack={() => {}} />);
  await act(async () => {});
  expect(screen.queryByLabelText('同行请求与状态')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'同行消息'}));
  expect(screen.getByLabelText('同行请求与状态')).toBeTruthy();
  expect(screen.queryByText('园区同行统计')).toBeNull();
  expect(screen.queryByText('删除我的同行数据')).toBeNull();
});

it('resets business selections and drafts when the account changes', async () => {
  window.otto = {} as typeof window.otto;
  const view = render(<InboxPage enterpriseAccount={{id:'first',organizationId:'org',status:'active'} as EnterpriseAccount} onBack={() => {}} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', {name:'商品消息'}));
  fireEvent.change(screen.getByLabelText('商品草稿'), {target:{value:'first account draft'}});
  view.rerender(<InboxPage enterpriseAccount={{id:'second',organizationId:'org',status:'active'} as EnterpriseAccount} onBack={() => {}} />);
  await act(async () => {});
  expect(screen.getByRole('button', {name:'会话'}).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByLabelText('商品草稿')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'商品消息'}));
  expect((screen.getByLabelText('商品草稿') as HTMLInputElement).value).toBe('');
});
