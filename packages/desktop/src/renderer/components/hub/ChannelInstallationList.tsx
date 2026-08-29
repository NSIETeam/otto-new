/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useState } from 'react';
import type {
  ChannelHealth,
  ChannelIdentityBindingV1,
  ChannelInstallation,
  ChannelProvider,
} from '../../../preload/index.js';
import { Badge, Card, Empty } from './HubUI.js';

const REFRESH_MS = 10_000;

export function ChannelInstallationList({
  provider,
}: {
  provider: ChannelProvider;
}): React.JSX.Element {
  const [installations, setInstallations] = useState<ChannelInstallation[]>([]);
  const [health, setHealth] = useState<Record<string, ChannelHealth>>({});
  const [identities, setIdentities] = useState<Record<string, ChannelIdentityBindingV1[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [identityPanel, setIdentityPanel] = useState<string | null>(null);
  const [providerUserId, setProviderUserId] = useState('');
  const [canonicalUserId, setCanonicalUserId] = useState('');
  const [approvalId, setApprovalId] = useState('');
  const [confirmIdentityRevoke, setConfirmIdentityRevoke] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      if (typeof window.otto?.channelInstallations !== 'function') {
        setUnsupported(true);
        return;
      }
      const listed = await window.otto.channelInstallations();
      if (!listed?.ok || !listed.data) {
        if (listed?.error) setError(listed.error);
        return;
      }
      const matching = listed.data.filter((item) => item.provider === provider);
      setInstallations(matching);
      const states = await Promise.all(matching.map(async (installation) => {
        if (typeof window.otto?.channelInstallationAction !== 'function') return null;
        const response = await window.otto.channelInstallationAction(
          installation.installationId,
          'health',
        );
        return response?.ok && response.data && 'state' in response.data
          ? [installation.installationId, response.data as ChannelHealth] as const
          : null;
      }));
      setHealth(Object.fromEntries(states.filter((state) => state !== null)));
      if (typeof window.otto?.channelIdentities === 'function') {
        const bindingStates = await Promise.all(matching.map(async (installation) => {
          const response = await window.otto.channelIdentities(installation.installationId);
          return response?.ok && response.data
            ? [installation.installationId, response.data] as const
            : [installation.installationId, []] as const;
        }));
        setIdentities(Object.fromEntries(bindingStates));
      }
      setUnsupported(false);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '渠道状态读取失败。');
    }
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      await load();
      if (!cancelled) timer = setTimeout(() => void refresh(), REFRESH_MS);
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const act = async (
    installation: ChannelInstallation,
    action: 'start' | 'stop' | 'revoke',
  ): Promise<void> => {
    if (busy) return;
    if (action === 'revoke' && confirmRevoke !== installation.installationId) {
      setConfirmRevoke(installation.installationId);
      return;
    }
    setBusy(installation.installationId);
    setError(null);
    try {
      if (typeof window.otto?.channelInstallationAction !== 'function') {
        setError('当前 Desktop 版本不支持渠道安装管理。');
        return;
      }
      const response = await window.otto.channelInstallationAction(
        installation.installationId,
        action,
      );
      if (!response?.ok) setError(response?.error ?? '渠道操作失败。');
      else await load();
    } finally {
      setBusy(null);
      setConfirmRevoke(null);
    }
  };

  const mutateIdentity = async (
    installation: ChannelInstallation,
    action: 'bind' | 'revoke',
    binding?: ChannelIdentityBindingV1,
  ): Promise<void> => {
    if (busy) return;
    if (!approvalId.trim()) {
      setError('请填写审批 ID；审批人将使用当前 Otto 登录身份。');
      return;
    }
    if (action === 'bind' && (!providerUserId.trim() || !canonicalUserId.trim())) {
      setError('请填写渠道用户 ID 和 Otto 用户 ID。');
      return;
    }
    if (action === 'revoke' && binding && confirmIdentityRevoke !== binding.providerUserId) {
      setConfirmIdentityRevoke(binding.providerUserId);
      return;
    }
    if (typeof window.otto?.channelIdentityMutation !== 'function') {
      setError('当前 Desktop 版本不支持身份绑定管理。');
      return;
    }
    setBusy(installation.installationId);
    setError(null);
    try {
      const current = binding ?? identities[installation.installationId]?.find(
        (candidate) => candidate.providerUserId === providerUserId.trim(),
      );
      const response = await window.otto.channelIdentityMutation(
        installation.installationId,
        {
          action,
          providerUserId: binding?.providerUserId ?? providerUserId.trim(),
          ...(action === 'bind' ? { canonicalUserId: canonicalUserId.trim() } : {}),
          approvalId: approvalId.trim(),
          expectedRevision: current?.revision ?? 0,
        },
      );
      if (!response?.ok) setError(response?.error ?? '身份操作失败。');
      else {
        setProviderUserId('');
        setCanonicalUserId('');
        setApprovalId('');
        await load();
      }
    } finally {
      setBusy(null);
      setConfirmIdentityRevoke(null);
    }
  };

  return (
    <div className="otto-channel-installations">
      <div className="otto-hub__section-title">已安装机器人</div>
      {installations.length === 0 ? (
        <Empty>尚未安装此渠道的机器人。</Empty>
      ) : installations.map((installation) => {
        const state = health[installation.installationId];
        const working = busy === installation.installationId;
        return (
          <Card className="otto-hub__card--pad" key={installation.installationId}>
            <div className="otto-channel-pairing__header">
              <div>
                <div className="otto-hub__row-name">{installation.botName}</div>
                <div className="otto-hub__field-hint">{installation.tenantName}</div>
              </div>
              <Badge>{state?.state ?? '状态未知'}</Badge>
            </div>
            <div className="otto-hub__field-hint">
              权限：{installation.grantedScopes.join('、') || '无'} · 重连 {state?.reconnectCount ?? 0} 次
            </div>
            <div className="otto-hub__feishu-actions">
              {state?.running ? (
                <button type="button" className="otto-hub__btn" disabled={working} onClick={() => void act(installation, 'stop')}>停止</button>
              ) : (
                <button type="button" className="otto-hub__btn otto-hub__btn--primary" disabled={working} onClick={() => void act(installation, 'start')}>启动</button>
              )}
              <button
                type="button"
                className="otto-hub__btn otto-hub__btn--danger"
                disabled={working}
                onClick={() => void act(installation, 'revoke')}
              >
                {confirmRevoke === installation.installationId ? '再次点击确认注销' : '注销连接'}
              </button>
              <button
                type="button"
                className="otto-hub__btn"
                aria-expanded={identityPanel === installation.installationId}
                onClick={() => setIdentityPanel((current) =>
                  current === installation.installationId ? null : installation.installationId)}
              >
                身份管理
              </button>
            </div>
            {identityPanel === installation.installationId ? (
              <div className="otto-channel-identities">
                <div className="otto-hub__field-hint">只有已绑定且启用的身份可以从聊天控制 Otto。</div>
                {(identities[installation.installationId] ?? []).map((binding) => (
                  <div className="otto-channel-identities__row" key={binding.providerUserId}>
                    <span>{binding.providerUserId} → {binding.canonicalUserId}</span>
                    <Badge>{binding.active ? `已启用 · r${binding.revision}` : `已撤销 · r${binding.revision}`}</Badge>
                    {binding.active ? (
                      <button
                        type="button"
                        className="otto-hub__btn otto-hub__btn--danger"
                        disabled={working}
                        onClick={() => void mutateIdentity(installation, 'revoke', binding)}
                      >
                        {confirmIdentityRevoke === binding.providerUserId ? '再次点击确认撤销身份' : '撤销身份'}
                      </button>
                    ) : null}
                  </div>
                ))}
                <label className="otto-hub__field">
                  <span>渠道用户 ID</span>
                  <input value={providerUserId} onChange={(event) => setProviderUserId(event.target.value)} />
                </label>
                <label className="otto-hub__field">
                  <span>Otto 用户 ID</span>
                  <input value={canonicalUserId} onChange={(event) => setCanonicalUserId(event.target.value)} />
                </label>
                <label className="otto-hub__field">
                  <span>审批 ID</span>
                  <input value={approvalId} onChange={(event) => setApprovalId(event.target.value)} />
                </label>
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  disabled={working}
                  onClick={() => void mutateIdentity(installation, 'bind')}
                >
                  保存身份绑定
                </button>
              </div>
            ) : null}
          </Card>
        );
      })}
      {error ? <div role="alert" className="otto-hub__feishu-message">{error}</div> : null}
      {unsupported ? (
        <div className="otto-hub__field-hint">当前 Desktop 版本不支持渠道安装管理。</div>
      ) : null}
    </div>
  );
}
