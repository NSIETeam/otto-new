/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ParkMarketDialog } from './ParkMarketDialog.js';
it('keeps own records and drafts reachable when the market is paused and validates publication without dropping fields', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  const request = vi.fn(async (input: { path: string }) => {
    if (input.path === '/settings')
      return {
        parkId: 'P',
        enabled: false,
        ready: true,
        rules: '个人闲置',
        contact: '服务台',
        version: 1,
        canModerate: false,
      };
    if (input.path === '/mine')
      return {
        items: [
          {
            id: 'mine',
            parkId: 'P',
            title: '我的办公椅',
            state: 'offline',
            imageIds: [],
            priceCents: 1000,
            saleMode: 'sale',
          },
        ],
      };
    throw new Error('unexpected ' + input.path);
  });
  Object.assign(window.otto, {
    enterpriseParkMarket: request,
    enterpriseMarketDrafts: vi.fn(async () => [
      { id: 'draft', form: { title: '草稿台灯', imageIds: [] } },
    ]),
  });
  const onClose = vi.fn();
  render(
    <ParkMarketDialog
      open
      accountId="seller"
      initialView="mine"
      onClose={onClose}
    />,
  );
  expect(await screen.findByText('我的办公椅')).toBeTruthy();
  expect(screen.getByRole('heading', { name: '原园区：P' })).toBeTruthy();
  expect(await screen.findByText('草稿台灯')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: '发布闲置' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '关闭跳蚤市场' }));
  expect(onClose).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      path: '/mine',
      method: 'GET',
      body: undefined,
      imageBase64: undefined,
    }),
  );
});

it('flushes the last input on save-and-close with the originating account scope', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  const scope = {
    server: 'https://park.test',
    organization: 'E1',
    account: 'seller',
  };
  const drafts = vi.fn(async (value?: unknown[]) => value ?? []);
  Object.assign(window.otto, {
    enterpriseMarketDrafts: drafts,
    enterpriseParkMarket: vi.fn(async (input: { path: string }) =>
      input.path === '/settings'
        ? {
            parkId: 'P',
            enabled: true,
            ready: true,
            rules: '个人闲置实物',
            contact: '服务台',
            canModerate: false,
          }
        : { items: [] },
    ),
  });
  const onClose = vi.fn();
  render(
    <ParkMarketDialog
      open
      accountId="seller"
      draftScope={scope}
      initialView="mine"
      onClose={onClose}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '发布闲置' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '发布闲置' }));
  fireEvent.change(screen.getByLabelText('标题 *'), {
    target: { value: '最后一秒输入的台灯' },
  });
  fireEvent.click(screen.getByRole('button', { name: '关闭跳蚤市场' }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存草稿并退出' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(drafts).toHaveBeenLastCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        form: expect.objectContaining({ title: '最后一秒输入的台灯' }),
      }),
    ]),
    scope,
  );
});

it('remounts private form state when the same account id switches server or organization', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  Object.assign(window.otto, {
    enterpriseMarketDrafts: vi.fn(async () => []),
    enterpriseParkMarket: vi.fn(async (input: { path: string }) =>
      input.path === '/settings'
        ? {
            parkId: 'P',
            enabled: true,
            ready: true,
            rules: '闲置',
            contact: '服务台',
            canModerate: false,
          }
        : { items: [] },
    ),
  });
  const props = {
    open: true,
    accountId: 'seller',
    initialView: 'mine' as const,
    onClose: () => {},
  };
  const first = {
    server: 'https://first.test',
    organization: 'one',
    account: 'seller',
  };
  const screenView = render(<ParkMarketDialog {...props} draftScope={first} />);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '发布闲置' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '发布闲置' }));
  fireEvent.change(screen.getByLabelText('标题 *'), {
    target: { value: '上一服务器的私有草稿' },
  });
  screenView.rerender(
    <ParkMarketDialog
      {...props}
      draftScope={{
        ...first,
        server: 'https://second.test',
        organization: 'two',
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.queryByDisplayValue('上一服务器的私有草稿')).toBeNull(),
  );
  expect(screen.queryByLabelText('标题 *')).toBeNull();
});

it('preserves expired draft text and identifies the failed photo with an independent retry', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  let failed = true;
  Object.assign(window.otto, {
    enterpriseMarketDrafts: vi.fn(async () => [
      {
        id: 'old-draft',
        updatedAt: Date.now() - 31 * 86400000,
        form: { title: '长期保存的草稿', imageIds: ['old-image'] },
      },
    ]),
    enterpriseParkMarket: vi.fn(async (input: { path: string }) => {
      if (input.path === '/settings')
        return {
          parkId: 'P',
          enabled: true,
          ready: true,
          rules: '闲置',
          contact: '服务台',
          canModerate: false,
        };
      if (input.path.startsWith('/images/')) {
        if (failed) throw new Error('offline');
        return { data: 'fixture' };
      }
      return { items: [] };
    }),
  });
  render(
    <ParkMarketDialog
      open
      accountId="seller"
      initialView="mine"
      onClose={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: '长期保存的草稿' }),
  );
  expect(await screen.findByText(/第 1 张图片暂时无法加载/)).toBeTruthy();
  expect(screen.getByDisplayValue('长期保存的草稿')).toBeTruthy();
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: '重试第 1 张图片' }));
  await waitFor(() =>
    expect(screen.queryByText(/第 1 张图片暂时无法加载/)).toBeNull(),
  );
});
it('shows per-image transfer progress and allows cancelling without dropping form text', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  let listener:
    | ((progress: { uploadId: string; loaded: number; total: number }) => void)
    | undefined;
  let rejectUpload: ((error: Error) => void) | undefined;
  Object.assign(window.otto, {
    enterpriseMarketDrafts: vi.fn(async () => []),
    onMarketImageProgress: (next: typeof listener) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    enterpriseMarketUploadCancel: vi.fn(async () => {
      rejectUpload?.(new Error('请求已取消'));
      return true;
    }),
    enterpriseParkMarket: vi.fn(
      async (input: { path: string; uploadId?: string }) => {
        if (input.path === '/settings')
          return {
            parkId: 'P',
            enabled: true,
            ready: true,
            rules: '闲置',
            contact: '服务台',
            canModerate: false,
          };
        if (input.path.startsWith('/images?')) {
          listener?.({ uploadId: input.uploadId!, loaded: 1, total: 2 });
          return new Promise((_resolve, reject) => {
            rejectUpload = reject;
          });
        }
        return { items: [] };
      },
    ),
  });
  render(
    <ParkMarketDialog
      open
      accountId="seller"
      initialView="mine"
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '发布闲置' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '发布闲置' }));
  fireEvent.change(screen.getByLabelText('标题 *'), {
    target: { value: '仍保留的描述标题' },
  });
  fireEvent.change(document.querySelector('input[type=file]')!, {
    target: {
      files: [new File(['photo'], 'photo.jpg', { type: 'image/jpeg' })],
    },
  });
  expect(await screen.findByText(/上传 50%/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '取消上传 photo.jpg' }));
  expect(await screen.findByText(/上传已取消/)).toBeTruthy();
  expect(screen.getByDisplayValue('仍保留的描述标题')).toBeTruthy();
});
it('flushes unsaved text when switching away from the form without closing the market', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  const drafts = vi.fn(async (value?: unknown[]) => value ?? []);
  const close = vi.fn();
  Object.assign(window.otto, {
    enterpriseMarketDrafts: drafts,
    enterpriseParkMarket: vi.fn(async (input: { path: string }) =>
      input.path === '/settings'
        ? {
            parkId: 'P',
            enabled: true,
            ready: true,
            rules: '闲置',
            contact: '服务台',
            canModerate: false,
          }
        : { items: [] },
    ),
  });
  render(
    <ParkMarketDialog
      open
      accountId="seller"
      initialView="mine"
      onClose={close}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '发布闲置' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '发布闲置' }));
  fireEvent.change(screen.getByLabelText('标题 *'), {
    target: { value: '切换页面前的最后输入' },
  });
  fireEvent.click(screen.getByRole('button', { name: '我的发布记录' }));
  fireEvent.click(
    await screen.findByRole('button', { name: '保存草稿并退出' }),
  );
  expect(
    await screen.findByRole('button', { name: '切换页面前的最后输入' }),
  ).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  expect(
    drafts.mock.calls.some(
      ([rows]) =>
        Array.isArray(rows) &&
        rows.some(
          (row) =>
            (row as { form?: { title: string } }).form?.title ===
            '切换页面前的最后输入',
        ),
    ),
  ).toBe(true);
});
it('closes directly after the current form is durably saved', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  const close = vi.fn();
  Object.assign(window.otto, {
    enterpriseMarketDrafts: vi.fn(async (value?: unknown[]) => value ?? []),
    enterpriseParkMarket: vi.fn(async (input: { path: string }) =>
      input.path === '/settings'
        ? {
            parkId: 'P',
            enabled: true,
            ready: true,
            rules: '闲置',
            contact: '服务台',
            canModerate: false,
          }
        : { items: [] },
    ),
  });
  render(
    <ParkMarketDialog
      open
      accountId="seller"
      initialView="mine"
      onClose={close}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '发布闲置' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '发布闲置' }));
  fireEvent.change(screen.getByLabelText('标题 *'), {
    target: { value: '已保存表单' },
  });
  await screen.findByText('已保存到本机');
  fireEvent.click(screen.getByRole('button', { name: '关闭跳蚤市场' }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
it('retains search, loaded cards and scroll position when returning from detail', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  const item = {
    id: 'chair',
    title: '办公椅甲',
    imageIds: [],
    priceCents: 1000,
    saleMode: 'sale',
    state: 'active',
    version: 1,
  };
  const request = vi.fn(async (input: { path: string }) =>
    input.path === '/settings'
      ? {
          parkId: 'P',
          enabled: true,
          ready: true,
          rules: '闲置',
          contact: '服务台',
          canModerate: false,
        }
      : input.path.startsWith('/listings/')
        ? item
        : { items: [item], nextCursor: null },
  );
  Object.assign(window.otto, {
    enterpriseMarketDrafts: vi.fn(async () => []),
    enterpriseParkMarket: request,
  });
  render(<ParkMarketDialog open accountId="buyer" onClose={() => {}} />);
  await screen.findByRole('button', { name: /办公椅甲/ });
  fireEvent.change(screen.getByLabelText('搜索商品'), {
    target: { value: '办公椅' },
  });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  await waitFor(() =>
    expect(
      request.mock.calls.some(([input]) =>
        input.path.includes('query=%E5%8A%9E'),
      ),
    ).toBe(true),
  );
  const dialog = screen.getByRole('dialog', { name: '园区跳蚤市场' });
  dialog.scrollTop = 120;
  const listingReads = request.mock.calls.filter(([input]) =>
    input.path.startsWith('/?'),
  ).length;
  fireEvent.click(screen.getByRole('button', { name: /办公椅甲/ }));
  fireEvent.click(await screen.findByRole('button', { name: '返回列表' }));
  expect(screen.getByDisplayValue('办公椅')).toBeTruthy();
  await waitFor(() => expect(dialog.scrollTop).toBe(120));
  expect(
    request.mock.calls.filter(([input]) => input.path.startsWith('/?')).length,
  ).toBe(listingReads);
});

it('blocks publication while a restored draft image is unreadable and allows removing it', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  Object.assign(window.otto, {
    enterpriseMarketDrafts: vi.fn(async () => [
      {
        id: 'broken-draft',
        form: { title: '图片失效草稿', imageIds: ['missing-photo'] },
      },
    ]),
    enterpriseParkMarket: vi.fn(async ({ path }: { path: string }) => {
      if (path === '/settings')
        return {
          parkId: 'P',
          enabled: true,
          ready: true,
          rules: '闲置',
          contact: '服务台',
        };
      if (path.startsWith('/images/')) throw new Error('NOT_FOUND');
      return { items: [] };
    }),
  });
  render(
    <ParkMarketDialog
      open
      accountId="seller"
      initialView="mine"
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: /图片失效草稿/ }));
  await screen.findByText(/第 1 张图片暂时无法加载/);
  expect(
    screen.getByRole('button', { name: '正式发布' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '移除第 1 张图片' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '正式发布' }).hasAttribute('disabled'),
    ).toBe(false),
  );
});

it('filters own records by state with counts while keeping drafts reachable', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  Object.assign(window.otto, {
    enterpriseMarketDrafts: vi.fn(async () => [
      { id: 'draft', form: { title: '未发出的草稿', imageIds: [] } },
    ]),
    enterpriseParkMarket: vi.fn(async ({ path }: { path: string }) =>
      path === '/settings'
        ? { parkId: 'P', enabled: false, ready: true }
        : {
            items: [
              {
                id: 'a',
                parkId: 'P',
                title: '在售台灯',
                state: 'active',
                imageIds: [],
                priceCents: 100,
                saleMode: 'sale',
              },
              {
                id: 'b',
                parkId: 'Q',
                title: '已售椅子',
                state: 'sold',
                imageIds: [],
                priceCents: 200,
                saleMode: 'sale',
              },
            ],
          },
    ),
  });
  render(
    <ParkMarketDialog
      open
      accountId="seller"
      initialView="mine"
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '已售出（1）' }));
  expect(screen.getByText('已售椅子')).toBeTruthy();
  expect(screen.queryByText('在售台灯')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '草稿（1）' }));
  expect(screen.getByText('未发出的草稿')).toBeTruthy();
  expect(screen.queryByText('已售椅子')).toBeNull();
});

it('reuses the governance receipt after timeout and refreshes the completed report', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.spyOn(window, 'prompt').mockReturnValue('已核实违规');
  let attempts = 0;
  const request = vi.fn(async ({ path }: { path: string }) => {
    if (path === '/settings')
      return {
        parkId: 'P',
        enabled: true,
        ready: true,
        canModerate: true,
        rules: '闲置',
        contact: '服务台',
        responsibleAccountId: 'admin',
        version: 1,
      };
    if (path === '/admin/P')
      return {
        reports: [
          {
            id: 'r',
            version: 1,
            listing_id: 'a',
            state: attempts === 2 ? 'closed' : 'pending',
            closed_at: attempts === 2 ? 1 : null,
            payload: { snapshot: { title: '待处理椅子' } },
          },
        ],
        appeals: [],
        restrictions: [],
        audit: [],
      };
    if (path === '/reports/r/decide') {
      attempts++;
      if (attempts === 1) throw new Error('network timeout');
      return { id: 'r' };
    }
    return { items: [] };
  });
  Object.assign(window.otto, {
    enterpriseParkMarket: request,
    enterpriseMarketDrafts: vi.fn(async () => []),
  });
  render(<ParkMarketDialog open accountId="admin" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '市场管理' }));
  fireEvent.click(await screen.findByRole('button', { name: '移除商品' }));
  await screen.findByText(/network timeout/);
  fireEvent.click(screen.getByRole('button', { name: '移除商品' }));
  await screen.findByText('已处理');
  const writes = request.mock.calls.filter(
    ([input]) => input.path === '/reports/r/decide',
  );
  expect((writes[0][0] as { body?: unknown }).body).toEqual(
    (writes[1][0] as { body?: unknown }).body,
  );
});

it('focuses the first invalid field after publication is rejected locally', async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  Object.assign(window.otto, {
    enterpriseMarketDrafts: vi.fn(async () => []),
    enterpriseParkMarket: vi.fn(async ({ path }: { path: string }) =>
      path === '/settings'
        ? { parkId: 'P', enabled: true, ready: true }
        : { items: [] },
    ),
  });
  render(<ParkMarketDialog open accountId="seller" onClose={() => {}} />);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '发布闲置' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: '发布闲置' }));
  fireEvent.click(screen.getByRole('button', { name: '正式发布' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByLabelText(/^标题/)),
  );
});
