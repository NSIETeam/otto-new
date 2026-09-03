/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeishuQuickSetupCard } from './FeishuQuickSetupCard.js';

const waiting = {
  registrationId: 'fdr_0123456789abcdef01234567',
  domain: 'feishu' as const,
  status: 'waiting_scan' as const,
  qrUrl: 'https://accounts.feishu.cn/device?code=opaque',
  expiresAtMs: Date.now() + 300_000,
  pollAfterMs: 1_000,
};

describe('FeishuQuickSetupCard', () => {
  const begin = vi.fn();
  const status = vi.fn();
  const cancel = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    begin.mockReset();
    status.mockReset();
    cancel.mockReset();
    Object.assign(window, { otto: {
      feishuDeviceRegistrationBegin: begin,
      feishuDeviceRegistrationStatus: status,
      feishuDeviceRegistrationCancel: cancel,
    } });
  });

  it('renders the official QR and reports owner-bound completion', async () => {
    begin.mockResolvedValue({ ok: true, data: waiting, error: null });
    status.mockResolvedValue({
      ok: true,
      data: { ...waiting, status: 'connected', qrUrl: undefined, ownerOpenId: 'ou_owner' },
      error: null,
    });
    const onConnected = vi.fn();
    render(<FeishuQuickSetupCard domain="feishu" onConnected={onConnected} />);

    fireEvent.click(screen.getByRole('button', { name: '扫码创建并连接机器人' }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole('img', { name: '飞书官方机器人授权二维码' })).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByText('机器人已连接，可以从飞书向这台电脑发任务。')).toBeTruthy();
    expect(screen.getByText('扫码者已成为默认 owner；高风险工具仍需确认。')).toBeTruthy();
    expect(onConnected).toHaveBeenCalledOnce();
  });
});
