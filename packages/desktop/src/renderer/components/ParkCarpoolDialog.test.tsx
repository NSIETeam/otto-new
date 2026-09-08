import React from 'react';
import { ModuleReadProvider, useModuleReadCache } from '../state/ModuleReadProvider.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import {
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
  it('focuses the first missing standard place and associates its validation error', async () => {
    Object.assign(window.otto, {
      enterpriseParkCarpoolGet: async () => emptyState,
    });
    render(<ParkCarpoolDialog open onClose={() => undefined} />);
    await screen.findByText('找到与你方向相近的园区伙伴');
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
    await screen.findByText('找到与你方向相近的园区伙伴');
    const group = screen.getByRole('group', { name: '从哪里出发' });
    const input = within(group).getByPlaceholderText('搜索小区、地标或地址');
    fireEvent.change(input, { target: { value: '旧地点' } });
    fireEvent.click(within(group).getByRole('button', { name: '搜索' }));
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
      expect(within(group).getByRole('button', { name: '搜索' })).toBeTruthy(),
    );
    expect(screen.queryByRole('option', { name: /旧地点结果/ })).toBeNull();
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
      await screen.findByText(/服务器尚未配置高德 Web 服务密钥/u),
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

  it('用标准地点发布意向，并在提交前保留明确的隐私提示', async () => {
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
    await screen.findByText('找到与你方向相近的园区伙伴');

    const origin = screen.getByRole('group', { name: '从哪里出发' });
    fireEvent.change(
      within(origin).getByPlaceholderText('搜索小区、地标或地址'),
      { target: { value: '宏创园区' } },
    );
    fireEvent.click(within(origin).getByRole('button', { name: '搜索' }));
    fireEvent.click(
      await screen.findByRole('option', { name: /宏创园区南门/u }),
    );

    const destination = screen.getByRole('group', { name: '要去哪里' });
    fireEvent.change(
      within(destination).getByPlaceholderText('搜索小区、地标或地址'),
      { target: { value: '回龙观' } },
    );
    fireEvent.click(within(destination).getByRole('button', { name: '搜索' }));
    fireEvent.click(
      await screen.findByRole('option', { name: /回龙观地铁站/u }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /搭车/u }));

    expect(
      screen.getByText(/候选阶段不会展示精确坐标或住宅门牌/u),
    ).toBeTruthy();
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
