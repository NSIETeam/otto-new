/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CarpoolPointPicker } from './CarpoolPointPicker.js';
const place = { id: 'p', label: '园区南门', address: '园区', district: '昌平', coordinate: { longitude: 116.3, latitude: 40.1 } };
describe('地图预览和独立选点', () => {
  it('cancels without changing the place and restores focus', async () => {
    Object.assign(window.otto, { enterpriseParkCarpoolMap: vi.fn(async () => 'data:image/png;base64,AA==') });
    const select = vi.fn(); const close = vi.fn();
    render(<CarpoolPointPicker place={place} onSelect={select} onClose={close} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    const expand = screen.getByRole('button', { name: '展开地图' });
    expand.focus(); fireEvent.click(expand);
    await screen.findByRole('button', { name: '地图选点，方向键移动，回车确认' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(select).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(expand);
  });
  it('commits a revised coordinate only after confirmation', async () => {
    const reverse = vi.fn(async (_coordinate: unknown) => ({ ...place, label: '新地点' }));
    Object.assign(window.otto, { enterpriseParkCarpoolMap: vi.fn(async () => 'data:image/png;base64,AA=='), enterpriseParkCarpoolReverse: reverse });
    const select = vi.fn(); const close = vi.fn();
    render(<CarpoolPointPicker place={place} onSelect={select} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: '展开地图' }));
    fireEvent.keyDown(await screen.findByRole('button', { name: '地图选点，方向键移动，回车确认' }), { key: 'ArrowRight' });
    await waitFor(() => expect((screen.getByRole('button', { name: '确认此地点' }) as HTMLButtonElement).disabled).toBe(false));
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认此地点' }));
    await waitFor(() => expect(select).toHaveBeenCalledWith(expect.objectContaining({ label: '新地点' })));
    expect(reverse.mock.calls[0]?.[0]).not.toEqual(place.coordinate);
    expect(close).toHaveBeenCalledOnce();
  });
  it('ignores a pending confirmation after the editor is cancelled', async () => {
    let resolve!: (value: typeof place) => void;
    Object.assign(window.otto, {
      enterpriseParkCarpoolMap: vi.fn(async () => 'data:image/png;base64,AA=='),
      enterpriseParkCarpoolReverse: vi.fn(() => new Promise<typeof place>(done => { resolve = done; })),
    });
    const select = vi.fn();
    render(<CarpoolPointPicker place={place} onSelect={select} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '展开地图' }));
    await screen.findByRole('button', { name: '地图选点，方向键移动，回车确认' });
    fireEvent.click(screen.getByRole('button', { name: '确认此地点' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => { resolve(place); });
    expect(select).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

});
