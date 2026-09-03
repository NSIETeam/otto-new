/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useEffect, useState } from 'react';
import type { FeishuDeviceRegistrationPublic } from 'otto-server';
import { startNonOverlappingPoll } from '../../lib/nonOverlappingPoll.js';
import { Card, Badge } from './HubUI.js';
import { QrCode } from './ChannelPairingCard.js';

const TERMINAL = new Set(['connected', 'denied', 'expired', 'failed', 'cancelled']);

export function FeishuQuickSetupCard({
  domain,
  onConnected,
}: {
  domain: 'feishu' | 'lark';
  onConnected?: () => void | Promise<void>;
}): React.JSX.Element {
  const [registration, setRegistration] = useState<FeishuDeviceRegistrationPublic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!registration || TERMINAL.has(registration.status)) return;
    return startNonOverlappingPoll(async () => {
      const response = await window.otto?.feishuDeviceRegistrationStatus(registration.registrationId);
      if (!response?.ok || !response.data) {
        if (response?.error) setError(response.error);
        return;
      }
      setRegistration(response.data);
      if (response.data.status === 'connected') await onConnected?.();
    }, registration.pollAfterMs, { runImmediately: false });
  }, [registration, onConnected]);

  const begin = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await window.otto?.feishuDeviceRegistrationBegin(domain);
      if (response?.ok && response.data) setRegistration(response.data);
      else setError(response?.error ?? '本地飞书注册服务未就绪。');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!registration || busy) return;
    setBusy(true);
    try {
      const response = await window.otto?.feishuDeviceRegistrationCancel(registration.registrationId);
      if (response?.data) setRegistration(response.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="otto-hub__card--pad otto-channel-pairing">
      <div className="otto-channel-pairing__header">
        <div>
          <div className="otto-hub__row-name">飞书官方一键创建</div>
          <p className="otto-hub__field-hint">扫码创建专属机器人、授权消息权限并绑定当前扫码账号；凭据只保存在本机。</p>
        </div>
        <Badge>{domain === 'feishu' ? '飞书' : 'Lark'}</Badge>
      </div>
      {!registration ? (
        <button type="button" className="otto-hub__btn otto-hub__btn--primary" disabled={busy} onClick={() => void begin()}>
          {busy ? '正在请求官方二维码…' : '扫码创建并连接机器人'}
        </button>
      ) : (
        <div className="otto-channel-pairing__body">
          {registration.qrUrl ? <QrCode value={registration.qrUrl} label="飞书官方机器人授权二维码" /> : null}
          <div className="otto-channel-pairing__details">
            <strong>{registration.status === 'connected' ? '机器人已连接，可以从飞书向这台电脑发任务。' : registration.status === 'waiting_scan' ? '请使用飞书扫码并确认创建机器人。' : registration.status === 'slow_down' ? '飞书正在处理，请稍候…' : registration.status === 'domain_switched' ? '已切换到正确的飞书/Lark 域，请继续确认。' : registration.error ?? '本次扫码已结束。'}</strong>
            {registration.status === 'connected' ? <span className="otto-hub__field-hint">扫码者已成为默认 owner；高风险工具仍需确认。</span> : null}
            {!TERMINAL.has(registration.status) ? <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => void cancel()}>取消</button> : null}
            {TERMINAL.has(registration.status) && registration.status !== 'connected' ? <button type="button" className="otto-hub__btn" onClick={() => setRegistration(null)}>重新扫码</button> : null}
          </div>
        </div>
      )}
      {error ? <div className="otto-hub__feishu-message" role="alert">{error}</div> : null}
    </Card>
  );
}
