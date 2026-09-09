/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { CarpoolGroupMatch } from 'otto-server';
import React, { useState } from 'react';
import type { EnterpriseParkCarpoolMatch } from '../../preload/index.js';
export function CarpoolRequestComposer({
  match,
  onSent,
  capabilities = [],
}: {
  match: EnterpriseParkCarpoolMatch | CarpoolGroupMatch;
  onSent: () => void;
  capabilities?: string[];
}): React.JSX.Element {
  const [open, setOpen] = useState<
    'text' | 'carpool_invite' | 'group_join' | 'group_invite' | null
  >(null);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState('');
  const [capacity, setCapacity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const groupMatch = 'groupId' in match ? match : null;
  if (!capabilities.includes('park_carpool_requests_v1'))
    return <p>当前服务器尚未启用同行联系功能</p>;
  if(match.pendingRequest)return <p role="status">{match.pendingRequest==='sent'?'已发送请求，等待确认':'对方已发来请求，请在同行请求与状态中处理'}</p>;
  return (
    <div>
      {groupMatch ? (
        <button
          type="button"
          onClick={() => {
            setOpen(groupMatch.inviteToMyGroup ? 'group_invite' : 'group_join');
            setError('');
          }}
        >
          {groupMatch.inviteToMyGroup ? '邀请加入本组' : '申请加入同行组'}
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen('text');
              setError('');
            }}
          >
            发消息
          </button>
          {capabilities.includes('park_carpool_invitations_v1') ? (
            <button
              type="button"
              onClick={() => {
                setOpen('carpool_invite');
                setError('');
              }}
            >
              邀请同行
            </button>
          ) : null}
        </>
      )}
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            void window.otto
              .enterpriseParkCarpoolWorkflowExecute({
                type: 'request',
                targetIntentId: match.intentId,
                kind: open,
                firstMessage: message,
                groupId: groupMatch?.groupId,
                ...(open === 'carpool_invite'
                  ? {
                      travelMode:
                        mode === 'shared_taxi'
                          ? ('shared_taxi' as const)
                          : ('private_vehicle' as const),
                      driverRole:
                        mode === 'candidate_rides_current_vehicle'
                          ? ('sender' as const)
                          : mode === 'current_rides_candidate_vehicle'
                            ? ('receiver' as const)
                            : undefined,
                      passengerCapacity:
                        mode === 'candidate_rides_current_vehicle'
                          ? capacity
                          : undefined,
                    }
                  : {}),
              })
              .then(() => {
                setOpen(null);
                setMessage('');
                onSent();
              })
              .catch((cause) =>
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <h4>
            {open === 'text'
              ? '发送消息请求'
              : open === 'group_join'
                ? '申请加入同行组'
                : open === 'group_invite'
                  ? '邀请加入本组'
                  : '邀请同行'}{' '}
            · {match.displayName}
          </h4>
          <p>
            对方接受前不能追加普通消息。请勿在首条消息中填写精确住宅地址或外部联系方式。
          </p>
          {open === 'carpool_invite' ? (
            <>
              <label>
                本次同行方式
                <select
                  required
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="">请选择方式与司机</option>
                  {match.compatibleModes.map((value) => (
                    <option key={value} value={value}>
                      {value === 'shared_taxi'
                        ? '一起叫车'
                        : value === 'candidate_rides_current_vehicle'
                          ? '由我开车'
                          : `由${match.displayName}开车`}
                    </option>
                  ))}
                </select>
              </label>
              {mode === 'candidate_rides_current_vehicle' ? (
                <label>
                  本次可同行乘客数
                  <select
                    value={capacity}
                    onChange={(e) => setCapacity(Number(e.target.value))}
                  >
                    <option value={1}>1 人</option>
                    <option value={2}>2 人</option>
                    <option value={3}>3 人</option>
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
          <label>
            首条消息
            <textarea
              required
              maxLength={1000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={busy}
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <button
            disabled={
              busy || !message.trim() || (open === 'carpool_invite' && !mode)
            }
            type="submit"
          >
            {busy ? '正在发送…' : '发送请求'}
          </button>
          <button type="button" disabled={busy} onClick={() => setOpen(null)}>
            取消
          </button>
        </form>
      ) : null}
    </div>
  );
}
