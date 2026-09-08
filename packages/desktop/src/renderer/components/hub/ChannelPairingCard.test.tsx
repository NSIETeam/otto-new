/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelPairingCard } from './ChannelPairingCard.js';

const basePairing = {
  pairingId: 'pair_0123456789abcdef01234567',
  provider: 'feishu' as const,
  status: 'user_authorized' as const,
  qrPayload: '',
  expiresAtMs: Date.now() + 300_000,
  requestedScopes: ['im:message'],
  pollAfterMs: 2_000,
  tenantName: '示例企业',
};

describe('ChannelPairingCard', () => {
  const channelPairingBegin = vi.fn();
  const channelPairingInstall = vi.fn();

  beforeEach(() => {
    channelPairingBegin.mockReset();
    channelPairingInstall.mockReset();
    (window as unknown as { otto: unknown }).otto = {
      channelPairingBegin,
      channelPairingInstall,
      channelPairingStatus: vi.fn(),
      channelPairingCancel: vi.fn(),
      openExternal: vi.fn(),
    };
  });

  afterEach(() => vi.useRealTimers());

  it('does not pretend pairing succeeded when the provider connector is absent', async () => {
    channelPairingBegin.mockResolvedValue({
      ok: false,
      pairing: null,
      error: 'channel_connector_unavailable:wecom',
    });
    render(<ChannelPairingCard provider="wecom" />);

    fireEvent.click(screen.getByRole('button', { name: '生成企业微信连接二维码' }));

    expect((await screen.findByRole('alert')).textContent).toContain('扫码服务尚未安装');
    expect(screen.queryByRole('img', { name: '企业微信连接二维码' })).toBeNull();
  });

  it('shows the verified tenant and permissions before manual installation', async () => {
    channelPairingBegin.mockResolvedValue({ ok: true, pairing: basePairing, error: null });
    channelPairingInstall.mockResolvedValue({ ok: true, data: { installationId: 'install-1' }, error: null });
    render(<ChannelPairingCard provider="feishu" />);

    fireEvent.click(screen.getByRole('button', { name: '生成飞书连接二维码' }));
    expect(await screen.findByText('企业：示例企业')).toBeTruthy();
    expect(screen.getByText('权限：im:message')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确认权限并安装' }));
    await waitFor(() => expect(channelPairingInstall).toHaveBeenCalledWith(basePairing.pairingId));
    expect(await screen.findByText('机器人连接成功。')).toBeTruthy();
  });

  it('makes automatic owner binding visible after QR installation', async () => {
    channelPairingBegin.mockResolvedValue({ ok: true, pairing: basePairing, error: null });
    channelPairingInstall.mockResolvedValue({
      ok: true,
      data: { installationId: 'install-1', ownerBindingState: 'bound' },
      error: null,
    });
    render(<ChannelPairingCard provider="feishu" />);

    fireEvent.click(screen.getByRole('button', { name: '生成飞书连接二维码' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认权限并安装' }));

    expect(await screen.findByText('扫码账号已绑定为本机控制账号。')).toBeTruthy();
  });

  it('warns when a safe manual identity binding is still required', async () => {
    channelPairingBegin.mockResolvedValue({ ok: true, pairing: basePairing, error: null });
    channelPairingInstall.mockResolvedValue({
      ok: true,
      data: { installationId: 'install-1', ownerBindingState: 'manual_required' },
      error: null,
    });
    render(<ChannelPairingCard provider="feishu" />);

    fireEvent.click(screen.getByRole('button', { name: '生成飞书连接二维码' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认权限并安装' }));

    expect((await screen.findByRole('alert')).textContent).toContain('远程控制仍被阻止');
  });

  it('waits for provider-confirmed admin approval without a local bypass button', async () => {
    channelPairingBegin.mockResolvedValue({
      ok: true,
      pairing: { ...basePairing, status: 'waiting_admin' },
      error: null,
    });
    render(<ChannelPairingCard provider="feishu" />);
    fireEvent.click(screen.getByRole('button', { name: '生成飞书连接二维码' }));

    expect(await screen.findByText('平台要求企业管理员批准，批准后才能安装。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '管理员已批准' })).toBeNull();
  });

  it('keeps the single-use QR visible when status polling omits its nonce', async () => {
    vi.useFakeTimers();
    const waiting = {
      ...basePairing,
      status: 'waiting_scan' as const,
      tenantName: undefined,
      qrPayload: 'https://connect.otto.example/channel/pair?pairing=pair_0123456789abcdef01234567&nonce=opaque',
    };
    channelPairingBegin.mockResolvedValue({ ok: true, pairing: waiting, error: null });
    const channelPairingStatus = vi.fn().mockResolvedValue({
      ok: true,
      data: { ...waiting, qrPayload: '', pollAfterMs: 5_000 },
      error: null,
    });
    Object.assign(window.otto, { channelPairingStatus });
    render(<ChannelPairingCard provider="feishu" />);

    fireEvent.click(screen.getByRole('button', { name: '生成飞书连接二维码' }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole('img', { name: '飞书连接二维码' })).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(channelPairingStatus).toHaveBeenCalledWith(waiting.pairingId);
    expect(screen.getByRole('img', { name: '飞书连接二维码' })).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(channelPairingStatus).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(channelPairingStatus).toHaveBeenCalledTimes(2);
  });

  it('continues polling after a transient local status failure', async () => {
    vi.useFakeTimers();
    const waiting = {
      ...basePairing,
      status: 'waiting_scan' as const,
      tenantName: undefined,
      qrPayload: 'https://connect.otto.example/channel/pair?pairing=pair_0123456789abcdef01234567&nonce=opaque',
    };
    channelPairingBegin.mockResolvedValue({ ok: true, pairing: waiting, error: null });
    const channelPairingStatus = vi.fn()
      .mockRejectedValueOnce(new Error('local service restarting'))
      .mockResolvedValue({ ok: true, data: { ...waiting, qrPayload: '' }, error: null });
    Object.assign(window.otto, { channelPairingStatus });
    render(<ChannelPairingCard provider="feishu" />);

    fireEvent.click(screen.getByRole('button', { name: '生成飞书连接二维码' }));
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole('alert').textContent).toContain('local service restarting');
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(channelPairingStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img', { name: '飞书连接二维码' })).toBeTruthy();
  });
});
