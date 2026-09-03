/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ChannelPairingPublic, ChannelProvider } from '../../../preload/index.js';
import type { ChannelInstallationResult } from '../../../preload/index.js';
import { createQrMatrix } from '../../lib/qrMatrix.js';
import { startNonOverlappingPoll } from '../../lib/nonOverlappingPoll.js';
import { Card, Badge } from './HubUI.js';

const PROVIDER_LABEL: Record<ChannelProvider, string> = {
  feishu: '飞书',
  lark: 'Lark',
  wecom: '企业微信',
  dingtalk: '钉钉',
};

const TERMINAL = new Set(['connected', 'expired', 'denied', 'failed', 'revoked']);

function boundedPollDelay(value: number): number {
  return Number.isFinite(value) ? Math.min(30_000, Math.max(1_000, Math.round(value))) : 2_000;
}

function pairingMessage(pairing: ChannelPairingPublic): string {
  switch (pairing.status) {
    case 'waiting_scan': return `请使用${PROVIDER_LABEL[pairing.provider]}扫码并确认授权。`;
    case 'waiting_admin': return '平台要求企业管理员批准，批准后才能安装。';
    case 'user_authorized': return '授权已验证。请核对权限后手动确认安装。';
    case 'installing': return '正在安装机器人连接…';
    case 'verifying': return '正在验证消息收发能力…';
    case 'connected': return '机器人连接成功。';
    case 'expired': return '二维码已过期，请重新生成。';
    case 'denied': return '本次授权已拒绝。';
    case 'revoked': return '连接授权已撤销。';
    case 'failed': return pairing.failureReason ?? '连接失败。';
    default: return '正在读取连接状态…';
  }
}

export function QrCode({ value, label }: { value: string; label: string }): React.JSX.Element | null {
  const matrix = useMemo(() => createQrMatrix(value), [value]);
  if (!matrix) return null;
  const pathParts: string[] = [];
  matrix.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      if (row[x] && start < 0) start = x;
      if ((!row[x] || x === row.length) && start >= 0) {
        pathParts.push(`M${start} ${y}h${x - start}v1H${start}z`);
        start = -1;
      }
    }
  });
  return (
    <svg
      className="otto-channel-pairing__qr"
      role="img"
      aria-label={label}
      viewBox={`-3 -3 ${matrix.length + 6} ${matrix.length + 6}`}
      shapeRendering="crispEdges"
    >
      <rect x={-3} y={-3} width={matrix.length + 6} height={matrix.length + 6} fill="#fff" />
      <path d={pathParts.join('')} fill="#111" />
    </svg>
  );
}

export function ChannelPairingCard({ provider }: { provider: ChannelProvider }): React.JSX.Element {
  const [pairing, setPairing] = useState<ChannelPairingPublic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installationNotice, setInstallationNotice] = useState<string | null>(null);
  const pairingId = pairing?.pairingId;
  const pairingStatus = pairing?.status;

  useEffect(() => {
    if (!pairingId || !pairingStatus || TERMINAL.has(pairingStatus)) return;
    return startNonOverlappingPoll(async () => {
      const response = await window.otto?.channelPairingStatus(pairingId);
      if (response?.ok && response.data) {
        setPairing((current) => ({
          ...response.data!,
          // The nonce-bearing QR is intentionally returned only once. Keep it
          // in renderer memory while the same pairing is still waiting_scan.
          qrPayload: response.data!.status === 'waiting_scan'
            ? current?.qrPayload ?? ''
            : response.data!.qrPayload,
        }));
      }
      else if (response?.error) setError(response.error);
    }, boundedPollDelay(pairing.pollAfterMs), {
      runImmediately: false,
      onError: (cause) => setError(cause instanceof Error ? cause.message : '连接状态查询失败。'),
    });
  }, [pairingId, pairingStatus, pairing?.pollAfterMs]);

  const begin = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInstallationNotice(null);
    try {
      const response = await window.otto?.channelPairingBegin(provider);
      if (response?.ok && response.pairing) setPairing(response.pairing);
      else if (response?.error?.startsWith('channel_connector_unavailable:')) {
        setError(`${PROVIDER_LABEL[provider]}扫码服务尚未安装，未创建任何假连接。可继续使用下方高级配置。`);
      } else {
        setError(response?.error ?? '本地连接服务未就绪。');
      }
    } finally {
      setBusy(false);
    }
  };

  const action = async (kind: 'install' | 'cancel'): Promise<void> => {
    if (!pairing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = kind === 'install'
          ? await window.otto?.channelPairingInstall(pairing.pairingId)
          : await window.otto?.channelPairingCancel(pairing.pairingId);
      if (!response?.ok) {
        setError(response?.error ?? '操作失败。');
        return;
      }
      if (kind === 'install') {
        const installation = response.data as ChannelInstallationResult | null;
        if (installation?.ownerBindingState === 'bound') {
          setInstallationNotice('扫码账号已绑定为本机控制账号。');
        } else if (installation?.ownerBindingState === 'manual_required') {
          setError('机器人已安装，但远程控制仍被阻止：请在身份管理中手动绑定扫码账号。');
        }
        setPairing({ ...pairing, status: 'connected', qrPayload: '' });
      } else if (response.data && typeof response.data === 'object' && 'status' in response.data) {
        setPairing(response.data as ChannelPairingPublic);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="otto-hub__card--pad otto-channel-pairing">
      <div className="otto-channel-pairing__header">
        <div>
          <div className="otto-hub__row-name">扫码连接机器人</div>
          <p className="otto-hub__field-hint">一次扫码完成租户识别、权限核对和机器人安装；安装仍需你手动确认。</p>
        </div>
        <Badge>{PROVIDER_LABEL[provider]}</Badge>
      </div>

      {!pairing ? (
        <button type="button" className="otto-hub__btn otto-hub__btn--primary" disabled={busy} onClick={() => void begin()}>
          {busy ? '正在创建安全二维码…' : `生成${PROVIDER_LABEL[provider]}连接二维码`}
        </button>
      ) : (
        <div className="otto-channel-pairing__body">
          {pairing.status === 'waiting_scan' && pairing.qrPayload ? (
            <QrCode value={pairing.qrPayload} label={`${PROVIDER_LABEL[provider]}连接二维码`} />
          ) : null}
          <div className="otto-channel-pairing__details">
            <strong>{pairingMessage(pairing)}</strong>
            <span className="otto-hub__field-hint">权限：{pairing.requestedScopes.join('、')}</span>
            {pairing.tenantName ? <span className="otto-hub__field-hint">企业：{pairing.tenantName}</span> : null}
            <div className="otto-hub__feishu-actions">
              {pairing.status === 'waiting_scan' && pairing.qrPayload ? (
                <button type="button" className="otto-hub__btn" onClick={() => void window.otto?.openExternal(pairing.qrPayload)}>在浏览器打开</button>
              ) : null}
              {pairing.status === 'user_authorized' ? (
                <button type="button" className="otto-hub__btn otto-hub__btn--primary" disabled={busy} onClick={() => void action('install')}>确认权限并安装</button>
              ) : null}
              {!TERMINAL.has(pairing.status) ? (
                <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => void action('cancel')}>取消</button>
              ) : null}
              {TERMINAL.has(pairing.status) && pairing.status !== 'connected' ? (
                <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => { setPairing(null); setError(null); }}>重新连接</button>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {error ? <div className="otto-hub__feishu-message" role="alert">{error}</div> : null}
      {installationNotice ? <div className="otto-hub__field-hint" role="status">{installationNotice}</div> : null}
    </Card>
  );
}
