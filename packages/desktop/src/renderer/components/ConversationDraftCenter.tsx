/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React from 'react';

import {
  conversationDraftExpiryLabel,
  type ConversationActionDraftSummary,
} from '../conversationActionDraft.js';
import './ConversationDraftCenter.css';

interface ConversationDraftCenterProps {
  drafts: readonly ConversationActionDraftSummary[];
  now?: number;
  onContinue(draft: ConversationActionDraftSummary): void;
  onConfirm(draft: ConversationActionDraftSummary): void;
  onCancel(draft: ConversationActionDraftSummary): void;
}

function phaseLabel(draft: ConversationActionDraftSummary): string {
  if (draft.phase === 'submitting') return '执行中';
  if (draft.phase === 'failed') return '上次执行结果未确认';
  if (draft.phase === 'awaiting_confirmation') return '等待确认';
  return '等待补充';
}

export function ConversationDraftCenter({
  drafts,
  now = Date.now(),
  onContinue,
  onConfirm,
  onCancel,
}: ConversationDraftCenterProps): React.JSX.Element | null {
  const activeDrafts = drafts.filter((draft) => draft.expiresAt > now);
  if (activeDrafts.length === 0) return null;
  return (
    <section className="otto-conversation-drafts" aria-label="对话操作草稿">
      <header>
        <strong>待完成操作</strong>
        <span>{activeDrafts.length}</span>
      </header>
      <div className="otto-conversation-drafts__list">
        {activeDrafts.map((draft) => (
          <article key={`${draft.source}:${draft.id}`} className="otto-conversation-drafts__item">
            <div className="otto-conversation-drafts__copy">
              <div>
                <strong>{draft.title}</strong>
                <span className={`is-${draft.phase}`}>{phaseLabel(draft)}</span>
              </div>
              <p>
                {draft.missingFields.length > 0
                  ? `还缺：${draft.missingFields.join('、')}`
                  : draft.phase === 'submitting'
                    ? '真实操作正在执行，当前不能撤回或重复提交。'
                  : draft.phase === 'failed'
                    ? '未自动重试，避免重复产生外部操作或费用。'
                    : '信息已完整，确认后才会执行真实操作。'}
              </p>
              <small>
                {conversationDraftExpiryLabel(draft.expiresAt, now)}
                {draft.incursCost ? ' · 可能产生 Token 费用' : ''}
              </small>
            </div>
            <div className="otto-conversation-drafts__actions">
              {draft.missingFields.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onContinue(draft)}
                  aria-label={`继续填写${draft.title}`}
                >
                  继续填写
                </button>
              ) : null}
              {draft.confirmationText && draft.phase !== 'submitting' ? (
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => onConfirm(draft)}
                  aria-label={`确认提交${draft.title}`}
                >
                  {draft.phase === 'failed' ? '重新执行' : '确认提交'}
                </button>
              ) : null}
              {draft.phase !== 'submitting' ? (
                <button
                  type="button"
                  className="is-quiet"
                  onClick={() => onCancel(draft)}
                  aria-label={`取消${draft.title}`}
                >
                  取消
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
