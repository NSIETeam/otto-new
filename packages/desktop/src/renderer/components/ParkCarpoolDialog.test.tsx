import React from 'react';
import { ModuleReadProvider, useModuleReadCache } from '../state/ModuleReadProvider.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EnterpriseParkCarpoolState } from '../../preload/index.js';
import { ParkCarpoolDialog } from './ParkCarpoolDialog.js';

const emptyState: EnterpriseParkCarpoolState = {
  capability: 'park_carpool_v1',
  mapConfigured: true,
  parkId: 'park-hongchuang',
  currentIntent: null,
  matches: [],
  generatedAt: '2026-09-02T00:00:00.000Z',
};

describe('拼车助手界面', () => {
  it('keeps an unpublished form separate from personal messages and administration', async () => {
    Object.assign(window.otto, { enterpriseParkCarpoolGet: async () => ({ ...emptyState, parkAdmin: true }) });
    render(<ParkCarpoolDialog open onClose={() => undefined} />);
    await screen.findByRole('button', { name: '园区管理' });
    expect(screen.queryByRole('button', { name: '刷新结果' })).toBeNull();
    expect(screen.queryByRole('region', { name: '同行请求与状态' })).toBeNull();
    expect(screen.queryByText('公共集合点名称')).toBeNull();
    expect(screen.queryByRole('region', { name: '同行示例体验' })).toBeNull();
    fireEvent.change(screen.getByLabelText('从哪里出发搜索'), { target: { value: '未提交的地点' } });
    fireEvent.click(screen.getByRole('button', { name: '园区管理' }));
    expect(await screen.findByText('公共集合点名称')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '发布并查找同路伙伴' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回行程' }));
    expect((screen.getByLabelText('从哪里出发搜索') as HTMLInputElement).value).toBe('未提交的地点');
  });
  it('waits for Chinese composition and confirms a suggestion with the keyboard', async () => {
    const search = vi.fn(async () => [{ id: 'park', label: '北控宏创科技园', address: '园区地址', district: '昌平', coordinate: { longitude: 116, latitude: 40 } }]);
    Object.assign(window.otto, { enterpriseParkCarpoolGet: async () => emptyState, enterpriseParkCarpoolSearchPlaces: search, enterpriseParkCarpoolMap: async () => 'data:image/png;base64,AA==' });
    render(<ParkCarpoolDialog open onClose={() => undefined} />);
    const input = await screen.findByRole('combobox', { name: '从哪里出发搜索' });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '北控' } });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    expect(search).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    await screen.findByRole('option', { name: /北控宏创科技园/ });
    expect(search).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByAltText('所选地点地图');
    expect((input as HTMLInputElement).value).toBe('北控宏创科技园');
    expect(screen.queryByRole('option', { name: /北控宏创科技园/ })).toBeNull();
    fireEvent.change(input, { target: { value: '北控新' } });
    expect(screen.queryByAltText('所选地点地图')).toBeNull();
  });
  it('focuses the first missing standard place and associates its validation error', async () => {
    Object.assign(window.otto, {
      enterpriseParkCarpoolGet: async () => emptyState,
    });
    render(<ParkCarpoolDialog open onClose={() => undefined} />);
    await screen.findByText('本次同行');
    fireEvent.click(screen.getByRole('button', { name: '发布并查找同路伙伴' }));
    const input = screen.getByLabelText('从哪里出发搜索');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(await screen.findByText('请搜索并明确选择出发地点。')).toBeTruthy();
  });
  it('discards search results after the user changes the place query', async () => {
    let resolve!: (
      places: Array<{
        id: string;
        label: string;
        address: string;
        district: string;
        coordinate: { longitude: number; latitude: number };
      }>,
    ) => void;
    Object.assign(window.otto, {
      enterpriseParkCarpoolGet: async () => emptyState,
      enterpriseParkCarpoolSearchPlaces: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    render(<ParkCarpoolDialog open onClose={() => undefined} />);
    await screen.findByText('本次同行');
    const group = screen.getByRole('group', { name: '从哪里出发' });
    const input = within(group).getByPlaceholderText('搜索小区、地标或地址');
    fireEvent.change(input, { target: { value: '旧地点' } });
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    fireEvent.change(input, { target: { value: '新地点' } });
    resolve([
      {
        id: 'old',
        label: '旧地点结果',
        address: '',
        district: '测试区',
        coordinate: { longitude: 116, latitude: 40 },
      },
    ]);
    await waitFor(() =>
      expect(within(group).queryByRole('button', { name: '搜索' })).toBeNull(),
    );
    expect(screen.queryByRole('option', { name: /旧地点结果/ })).toBeNull();
  });
  it('does not report a missing map key when the initial state request fails, and can retry', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('无法连接企业服务器')).mockResolvedValue(emptyState);
    Object.assign(window.otto, { enterpriseParkCarpoolGet: get });
    render(<ParkCarpoolDialog open onClose={() => undefined} />);
    expect(await screen.findByText('无法连接企业服务器')).toBeTruthy();
    expect(screen.queryByText(/服务器尚未配置高德/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新读取拼车状态' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '发布并查找同路伙伴' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('无法连接企业服务器')).toBeNull();
  });

  it('地图能力缺失时如实禁用发布，不展示虚构匹配', async () => {
    Object.assign(window.otto, {
      enterpriseParkCarpoolGet: vi.fn(async () => ({
        ...emptyState,
        mapConfigured: false,
      })),
      enterpriseParkCarpoolSearchPlaces: vi.fn(),
      enterpriseParkCarpoolPublish: vi.fn(),
      enterpriseParkCarpoolRefresh: vi.fn(),
      enterpriseParkCarpoolStop: vi.fn(),
    });
    render(<ParkCarpoolDialog open onClose={vi.fn()} />);

    expect(
      await screen.findByText(/地图服务未配置/u),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: '发布并查找同路伙伴',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText(/约 \d+% 同路/u)).toBeNull();
  });

  it('用标准地点发布意向，精简说明不影响提交和编辑', async () => {
    const places = [
      {
        id: 'origin',
        label: '宏创园区南门',
        address: '七北路',
        district: '昌平区',
        coordinate: { longitude: 116.23, latitude: 40.22 },
      },
      {
        id: 'destination',
        label: '回龙观地铁站',
        address: '回龙观西大街',
        district: '昌平区',
        coordinate: { longitude: 116.31, latitude: 40.17 },
      },
    ];
    const search = vi.fn(async (query: string) =>
      query.includes('园区') ? [places[0]!] : [places[1]!],
    );
    const publish = vi.fn(async (input) => ({
      ...input,
      id: 'intent-ui',
      status: 'active',
      expiresAt: '2026-09-02T11:00:00Z',
    }));
    Object.assign(window.otto, {
      enterpriseParkCarpoolGet: vi.fn(async () => emptyState),
      enterpriseParkCarpoolSearchPlaces: search,
      enterpriseParkCarpoolPublish: publish,
      enterpriseParkCarpoolRefresh: vi.fn(async () => emptyState),
      enterpriseParkCarpoolStop: vi.fn(),
    });
    render(<ParkCarpoolDialog open onClose={vi.fn()} />);
    await screen.findByText('本次同行');

    const origin = screen.getByRole('group', { name: '从哪里出发' });
    fireEvent.change(
      within(origin).getByPlaceholderText('搜索小区、地标或地址'),
      { target: { value: '宏创园区' } },
    );

    fireEvent.click(
      await screen.findByRole('option', { name: /宏创园区南门/u }),
    );

    const destination = screen.getByRole('group', { name: '要去哪里' });
    fireEvent.change(
      within(destination).getByPlaceholderText('搜索小区、地标或地址'),
      { target: { value: '回龙观' } },
    );

    fireEvent.click(
      await screen.findByRole('option', { name: /回龙观地铁站/u }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /搭车/u }));

    expect(screen.queryByText('使用说明')).toBeNull();
    expect(screen.queryByText('搜索后选择地点')).toBeNull();
    window.otto.enterpriseParkCarpoolRefresh = vi.fn(async () => {
      throw new Error('刷新离线');
    });
    fireEvent.click(screen.getByRole('button', { name: '发布并查找同路伙伴' }));
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: expect.objectContaining({ label: '宏创园区南门' }),
          destination: expect.objectContaining({ label: '回龙观地铁站' }),
          travelOptions: ['rider'],
        }),
      ),
    );
    expect(await screen.findByText(/意向已发布，但结果刷新失败/)).toBeTruthy();
    expect(screen.queryByLabelText('从哪里出发搜索')).toBeNull();
    expect(screen.getByRole('region', { name: '当前行程' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '同行示例体验' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改行程' }));
    expect((screen.getByLabelText('从哪里出发搜索') as HTMLInputElement).value).toBe('宏创园区南门');
  });
});

it('uses data warmed after the closed dialog mounted, while fresh reading remains pending', async () => {
  function Prime({ ready }: { ready: boolean }) {
    const cache = useModuleReadCache();
    React.useEffect(() => { if (ready) cache.set('carpool', emptyState); }, [cache, ready]);
    return null;
  }
  Object.assign(window.otto, { enterpriseParkCarpoolGet: vi.fn(() => new Promise(() => {})) });
  const tree = (ready: boolean, open: boolean) => <ModuleReadProvider><Prime ready={ready} /><ParkCarpoolDialog open={open} onClose={() => {}} /></ModuleReadProvider>;
  const view = render(tree(false, false));
  view.rerender(tree(true, false));
  view.rerender(tree(true, true));
  expect(screen.getByLabelText('从哪里出发搜索').matches(':disabled')).toBe(false);
});

it('discarding an unpublished draft clears it before the next opening', async () => {
  Object.assign(window.otto, { enterpriseParkCarpoolGet: vi.fn(async () => emptyState) });
  const onClose = vi.fn();
  const view = render(<ParkCarpoolDialog open onClose={onClose} />);
  await waitFor(() => expect(screen.getByLabelText('从哪里出发搜索').matches(':disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('从哪里出发搜索'), { target: { value: '放弃的出发地点' } });
  fireEvent.click(screen.getByRole('button', { name: '关闭拼车助手' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃修改并关闭' }));
  view.rerender(<ParkCarpoolDialog open={false} onClose={onClose} />);
  view.rerender(<ParkCarpoolDialog open onClose={onClose} />);
  expect((screen.getByLabelText('从哪里出发搜索') as HTMLInputElement).value).toBe('');
});
