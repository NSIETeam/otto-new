/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useState } from 'react';
import type {
  ChannelHealth,
  ChannelIdentityBindingV1,
  ChannelInstallation,
  ChannelProvider,
} from '../../../preload/index.js';
import { Badge, Card, Empty } from './HubUI.js';
import { startNonOverlappingPoll } from '../../lib/nonOverlappingPoll.js';

const REFRESH_MS = 10_000;

function relativeTime(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return '从未';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function elapsedTime(startedAtMs: number | undefined, now = Date.now()): string {
  if (!startedAtMs) return '未知';
  const minutes = Math.max(0, Math.floor((now - startedAtMs) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时 ${minutes % 60} 分钟` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function reconnectTime(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.ceil((timestamp - now) / 1000));
  return seconds < 60 ? `${seconds} 秒后` : `${Math.ceil(seconds / 60)} 分钟后`;
}

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

  useEffect(() => startNonOverlappingPoll(load, REFRESH_MS), [load]);

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
      if (!response?.ok) {
        if (action === 'revoke') await load();
        setError(response?.error ?? '渠道操作失败。');
      } else await load();
    } finally {
      setBusy(null);
      setConfirmRevoke(null);
    }
  };

  const mutateIdentity = async (
    installation: ChannelInstallation,
    action: 'claim-owner' | 'bind' | 'revoke',
    binding?: ChannelIdentityBindingV1,
  ): Promise<void> => {
    if (busy) return;
    if (action !== 'claim-owner' && !approvalId.trim()) {
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
          approvalId: action === 'claim-owner' ? 'local-owner-claim' : approvalId.trim(),
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
            {state?.missingScopes?.length ? (
              <div className="otto-hub__feishu-message" role="status">
                缺少已授权权限：{state.missingScopes.join('、')}。机器人部分能力将不可用，请在平台管理后台补齐后重新连接。
              </div>
            ) : null}
            <div className="otto-hub__field-hint">
              运行 {elapsedTime(state?.startedAtMs)} · 最近接收 {relativeTime(state?.lastReceivedAtMs)} · 最近发送 {relativeTime(state?.lastSentAtMs)}
              {state?.nextReconnectAtMs ? ` · 计划 ${reconnectTime(state.nextReconnectAtMs)}重连` : ''}
            </div>
            {state?.message ? <div className="otto-hub__field-hint">诊断：{state.message}</div> : null}
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
                <div className="otto-hub__field-hint">先从企业微信或钉钉给机器人发一条消息；诊断区会显示渠道用户 ID。只有你在本机确认绑定后，该账号才能控制 Otto。</div>
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
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  disabled={working || !providerUserId.trim()}
                  onClick={() => void mutateIdentity(installation, 'claim-owner')}
                >
                  绑定为当前 Otto 账号
                </button>
                <div className="otto-hub__field-hint">以下为企业管理员高级绑定，可将渠道账号映射给其他 Otto 用户。</div>
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
