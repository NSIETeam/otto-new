/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelInstallationList } from './ChannelInstallationList.js';

const installation = {
  installationId: 'channel_wecom_0123456789abcdef01234567',
  provider: 'wecom' as const,
  tenantId: 'corp-1',
  tenantName: '示例企业',
  botName: 'Otto Bot',
  grantedScopes: ['message.send'],
  connectedAtMs: 1,
};

describe('ChannelInstallationList', () => {
  const channelInstallations = vi.fn();
  const channelInstallationAction = vi.fn();
  const channelIdentities = vi.fn();
  const channelIdentityMutation = vi.fn();

  beforeEach(() => {
    channelInstallations.mockReset().mockResolvedValue({
      ok: true,
      data: [installation],
      error: null,
    });
    channelInstallationAction.mockReset().mockImplementation(
      async (_id: string, action: string) => action === 'health'
        ? {
            ok: true,
            data: {
              installationId: installation.installationId,
              running: true,
              state: 'connected',
              reconnectCount: 1,
            },
            error: null,
          }
        : { ok: true, data: action === 'revoke' ? { revoked: true } : {}, error: null },
    );
    channelIdentities.mockReset().mockResolvedValue({ ok: true, data: [], error: null });
    channelIdentityMutation.mockReset().mockResolvedValue({
      ok: true,
      data: {
        provider: 'wecom', installationId: installation.installationId,
        tenantId: 'corp-1', providerUserId: 'wm_user_1', canonicalUserId: 'otto-user-1',
        active: true, revision: 1, approvalId: 'approval-1', approvedBy: 'admin-1',
        boundAtMs: 1, updatedAtMs: 1,
      },
      error: null,
    });
    (window as unknown as { otto: unknown }).otto = {
      channelInstallations,
      channelInstallationAction,
      channelIdentities,
      channelIdentityMutation,
    };
  });

  it('shows verified tenant, permissions and live health from the shared supervisor', async () => {
    render(<ChannelInstallationList provider="wecom" />);

    expect(await screen.findByText('Otto Bot')).toBeTruthy();
    expect(screen.getByText('示例企业')).toBeTruthy();
    expect(screen.getByText(/权限：message.send · 重连 1 次/)).toBeTruthy();
    expect(screen.getByText('connected')).toBeTruthy();
    expect(channelInstallationAction).toHaveBeenCalledWith(
      installation.installationId,
      'health',
    );
  });

  it('requires a second click before revoking an installation', async () => {
    render(<ChannelInstallationList provider="wecom" />);
    const revoke = await screen.findByRole('button', { name: '注销连接' });
    fireEvent.click(revoke);
    expect(channelInstallationAction).not.toHaveBeenCalledWith(
      installation.installationId,
      'revoke',
    );
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认注销' }));
    await waitFor(() => expect(channelInstallationAction).toHaveBeenCalledWith(
      installation.installationId,
      'revoke',
    ));
  });

  it('removes a locally revoked installation while showing an unknown remote outcome', async () => {
    let installed = true;
    channelInstallations.mockImplementation(async () => ({
      ok: true,
      data: installed ? [installation] : [],
      error: null,
    }));
    channelInstallationAction.mockImplementation(async (_id: string, action: string) => {
      if (action === 'health') {
        return {
          ok: true,
          data: {
            installationId: installation.installationId,
            running: true,
            state: 'connected',
            reconnectCount: 0,
          },
          error: null,
        };
      }
      if (action === 'revoke') {
        installed = false;
        return {
          ok: false,
          data: null,
          error: 'provider revocation outcome is unknown; local authorization was removed and will not reconnect',
        };
      }
      return { ok: true, data: {}, error: null };
    });

    render(<ChannelInstallationList provider="wecom" />);
    fireEvent.click(await screen.findByRole('button', { name: '注销连接' }));
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认注销' }));

    expect(await screen.findByText('尚未安装此渠道的机器人。')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'local authorization was removed',
    );
  });

  it('binds an explicitly approved identity through the shared supervisor', async () => {
    render(<ChannelInstallationList provider="wecom" />);
    fireEvent.click(await screen.findByRole('button', { name: '身份管理' }));
    fireEvent.change(screen.getByLabelText('渠道用户 ID'), { target: { value: 'wm_user_1' } });
    fireEvent.change(screen.getByLabelText('Otto 用户 ID'), { target: { value: 'otto-user-1' } });
    fireEvent.change(screen.getByLabelText('审批 ID'), { target: { value: 'approval-1' } });
    fireEvent.click(screen.getByRole('button', { name: '保存身份绑定' }));
    await waitFor(() => expect(channelIdentityMutation).toHaveBeenCalledWith(
      installation.installationId,
      {
        action: 'bind', providerUserId: 'wm_user_1', canonicalUserId: 'otto-user-1',
        approvalId: 'approval-1', expectedRevision: 0,
      },
    ));
  });

  it('requires approval fields and a second click before revoking an identity', async () => {
    channelIdentities.mockResolvedValue({
      ok: true,
      data: [{
        provider: 'wecom', installationId: installation.installationId,
        tenantId: 'corp-1', providerUserId: 'wm_user_1', canonicalUserId: 'otto-user-1',
        active: true, revision: 3, approvalId: 'approval-old', approvedBy: 'admin-old',
        boundAtMs: 1, updatedAtMs: 1,
      }],
      error: null,
    });
    render(<ChannelInstallationList provider="wecom" />);
    fireEvent.click(await screen.findByRole('button', { name: '身份管理' }));
    fireEvent.click(await screen.findByRole('button', { name: '撤销身份' }));
    expect((await screen.findByRole('alert')).textContent).toContain('审批 ID');
    fireEvent.change(screen.getByLabelText('审批 ID'), { target: { value: 'approval-2' } });
    fireEvent.click(screen.getByRole('button', { name: '撤销身份' }));
    expect(channelIdentityMutation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '再次点击确认撤销身份' }));
    await waitFor(() => expect(channelIdentityMutation).toHaveBeenCalledWith(
      installation.installationId,
      {
        action: 'revoke', providerUserId: 'wm_user_1', approvalId: 'approval-2',
        expectedRevision: 3,
      },
    ));
  });
});
