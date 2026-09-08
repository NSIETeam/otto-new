import { CarpoolConfirmation } from './CarpoolConfirmation.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useRef, useState } from 'react';
import type { ParkChatView } from '../../main/park-carpool-chat.js';

export function CarpoolChat({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose(): void;
}): React.JSX.Element {
  const [view, setView] = useState<ParkChatView | null>(null);
  const [text, setText] = useState('');
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const [safetyTarget, setSafetyTarget] = useState<{
    message: ParkChatView['messages'][number];
    action: 'block' | 'report';
  } | null>(null);
  const [reason, setReason] = useState('');
  const [safetyStatus, setSafetyStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const draft = useRef<{ id: string; text: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let running = false;
    const read = async () => {
      if (running) return;
      running = true;
      try {
        const next =
          await window.otto.enterpriseParkCarpoolChatRead(conversationId);
        if (mounted.current) {
          setView(next);
          setError('');
          if (
            draft.current &&
            next.messages.some((m) => m.id === draft.current?.id && !m.pending)
          ) {
            setText('');
            draft.current = null;
          }
        }
      } catch (cause) {
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        running = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [conversationId]);
  const send = async () => {
    setBusy(true);
    setError('');
    const current = draft.current ?? {
      id: crypto.randomUUID(),
      text: text.trim(),
    };
    draft.current = current;
    try {
      const next = await window.otto.enterpriseParkCarpoolChatSend(
        conversationId,
        current.text,
        current.id,
      );
      if (mounted.current) {
        setView(next);
        setText('');
        draft.current = null;
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          `${cause instanceof Error ? cause.message : String(cause)}。已加密保存的消息会在恢复连接后重试，请勿重复发送。`,
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label="同行加密聊天">
      <header>
        <h3>同行加密聊天</h3>
        <button type="button" onClick={onClose}>
          关闭聊天
        </button>
      </header>
      <p role="status">
        {view?.status === 'archived'
          ? '会话已归档，可查看原有消息'
          : view?.canSend
            ? '端到端加密已就绪'
            : '正在等待同行设备准备加密密钥'}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {safetyStatus ? <p role="status">{safetyStatus}</p> : null}
      {safetyTarget ? (
        <CarpoolConfirmation
          label={
            safetyTarget.action === 'block' ? '屏蔽同行成员' : '举报同行消息'
          }
          onCancel={() => setSafetyTarget(null)}
        >
          <p>
            操作对象：
            {safetyTarget.message.senderDisplayName ?? '此条消息的发送者'}
          </p>
          <p>
            {safetyTarget.action === 'block'
              ? '屏蔽会关闭双方联系入口。如果你们仍在同一个同行组，确认后你将退出该组，其他成员的聊天密钥会更新。'
              : '确认后，仅将这条消息的明文及必要记录提交给园区管理员。明文属于你主动提交的证据，管理员需要核实，不会获得整段聊天。'}
          </p>
          {safetyTarget.action === 'report' ? (
            <>
              <blockquote>{safetyTarget.message.text}</blockquote>
              <label>
                举报原因
                <textarea
                  maxLength={1000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            </>
          ) : null}
          <button
            type="button"
            disabled={
              busy || (safetyTarget.action === 'report' && !reason.trim())
            }
            onClick={() => {
              setBusy(true);
              setError('');
              void window.otto
                .enterpriseParkCarpoolWorkflowExecute(
                  safetyTarget.action === 'block'
                    ? {
                        type: 'block',
                        targetAccountId: safetyTarget.message.senderAccountId,
                        leaveSharedGroup: true,
                      }
                    : {
                        type: 'report_message',
                        conversationId,
                        eventId: safetyTarget.message.id,
                        plaintext: safetyTarget.message.text,
                        reason,
                      },
                )
                .then(() => {
                  setSafetyStatus(
                    safetyTarget.action === 'block'
                      ? '已屏蔽该成员；共同组关系已按确认处理'
                      : '举报已提交，可在当前同行状态中查看处理结果',
                  );
                  setSafetyTarget(null);
                  if (safetyTarget.action === 'block') onClose();
                })
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            确认{safetyTarget.action === 'block' ? '屏蔽' : '提交举报'}
          </button>
          <button type="button" onClick={() => setSafetyTarget(null)}>
            取消
          </button>
        </CarpoolConfirmation>
      ) : null}
      {view?.failedMessageCount ? (
        <p role="alert">
          有 {view.failedMessageCount}{' '}
          条消息无法验证，已隔离；其他消息仍可继续收发。
        </p>
      ) : null}
      {view?.unavailableHistoryCount ? (
        <p role="status">
          有 {view.unavailableHistoryCount}{' '}
          条历史消息的本机密钥不可用，无法恢复明文。
        </p>
      ) : null}
      {view && !view.canSend && view.status !== 'archived' ? (
        <button type="button" onClick={() => setConfirmRecovery(true)}>
          恢复本机聊天密钥
        </button>
      ) : null}
      {confirmRecovery && view ? (
        <CarpoolConfirmation
          label="确认恢复加密密钥"
          onCancel={() => setConfirmRecovery(false)}
        >
          <p>
            这会通知同行成员并生成新密钥，旧消息不会重新发送。设备密钥仍在准备时请先稍候。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void window.otto
                .enterpriseParkCarpoolChatRecover(
                  conversationId,
                  view.generation,
                )
                .then((next) => {
                  setView(next);
                  setConfirmRecovery(false);
                  setError('');
                })
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            确认恢复
          </button>
          <button type="button" onClick={() => setConfirmRecovery(false)}>
            取消
          </button>
        </CarpoolConfirmation>
      ) : null}
      <ol aria-label="同行聊天记录" aria-live="polite">
        {view?.messages.map((message) => (
          <li key={message.id}>
            <strong>
              {message.own ? '我' : (message.senderDisplayName ?? '同行伙伴')}
            </strong>
            <p style={{ whiteSpace: 'pre-wrap' }}>{message.text}</p>
            <small>
              {message.pending
                ? '等待发送'
                : new Date(message.createdAt).toLocaleTimeString('zh-CN')}
            </small>
            {!message.own && !message.pending ? (
              <span>
                <button
                  type="button"
                  onClick={() => {
                    setSafetyTarget({ message, action: 'block' });
                    setReason('');
                  }}
                >
                  屏蔽此成员
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSafetyTarget({ message, action: 'report' });
                    setReason('');
                  }}
                >
                  举报此消息
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label>
          同行消息
          <textarea
            maxLength={4000}
            value={text}
            disabled={busy || Boolean(draft.current)}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !view?.canSend || !text.trim()}>
          {draft.current ? '重试发送' : '发送加密消息'}
        </button>
      </form>
    </section>
  );
}
