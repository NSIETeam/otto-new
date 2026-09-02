/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('地图能力缺失时如实禁用发布，不展示虚构匹配', async () => {
    Object.assign(window.otto, {
      enterpriseParkCarpoolGet: vi.fn(async () => ({ ...emptyState, mapConfigured: false })),
      enterpriseParkCarpoolSearchPlaces: vi.fn(),
      enterpriseParkCarpoolPublish: vi.fn(),
      enterpriseParkCarpoolRefresh: vi.fn(),
      enterpriseParkCarpoolStop: vi.fn(),
    });
    render(<ParkCarpoolDialog open onClose={vi.fn()} />);

    expect(await screen.findByText(/服务器尚未配置高德 Web 服务密钥/u)).toBeTruthy();
    expect((screen.getByRole('button', { name: '发布并查找同路伙伴' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(screen.queryByText(/约 \d+% 同路/u)).toBeNull();
  });

  it('用标准地点发布意向，并在提交前保留明确的隐私提示', async () => {
    const places = [
      { id: 'origin', label: '宏创园区南门', address: '七北路', district: '昌平区', coordinate: { longitude: 116.23, latitude: 40.22 } },
      { id: 'destination', label: '回龙观地铁站', address: '回龙观西大街', district: '昌平区', coordinate: { longitude: 116.31, latitude: 40.17 } },
    ];
    const search = vi.fn(async (query: string) => query.includes('园区') ? [places[0]!] : [places[1]!]);
    const publish = vi.fn(async () => ({}));
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
    fireEvent.change(within(origin).getByPlaceholderText('搜索小区、地标或地址'), { target: { value: '宏创园区' } });
    fireEvent.click(within(origin).getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('option', { name: /宏创园区南门/u }));

    const destination = screen.getByRole('group', { name: '要去哪里' });
    fireEvent.change(within(destination).getByPlaceholderText('搜索小区、地标或地址'), { target: { value: '回龙观' } });
    fireEvent.click(within(destination).getByRole('button', { name: '搜索' }));
    fireEvent.click(await screen.findByRole('option', { name: /回龙观地铁站/u }));
    fireEvent.click(screen.getByRole('checkbox', { name: /搭车/u }));

    expect(screen.getByText(/候选阶段不会展示精确坐标或住宅门牌/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发布并查找同路伙伴' }));
    await waitFor(() => expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      origin: expect.objectContaining({ label: '宏创园区南门' }),
      destination: expect.objectContaining({ label: '回龙观地铁站' }),
      travelOptions: ['rider'],
    })));
  });
});
