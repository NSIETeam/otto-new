// @vitest-environment jsdom
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationActionDraftSummary } from '../conversationActionDraft.js';
import { ConversationDraftCenter } from './ConversationDraftCenter.js';

const collecting: ConversationActionDraftSummary = {
  id: 'draft-collecting',
  source: 'park-service',
  title: '停车办理申请',
  phase: 'collecting',
  updatedAt: 1_000,
  expiresAt: 1_801_000,
  missingFields: ['申请内容', '申请数量'],
};

const ready: ConversationActionDraftSummary = {
  id: 'draft-ready',
  source: 'customer-module',
  title: '合同审查器',
  phase: 'awaiting_confirmation',
  updatedAt: 1_000,
  expiresAt: 1_801_000,
  missingFields: [],
  confirmationText: '确认运行并同意费用',
  incursCost: true,
};

const submitting: ConversationActionDraftSummary = {
  ...ready,
  id: 'draft-submitting',
  phase: 'submitting',
};

describe('ConversationDraftCenter', () => {
  it('展示缺失字段和过期时间，收集中草稿不提供确认按钮', () => {
    render(<ConversationDraftCenter drafts={[collecting]} now={1_000} onContinue={vi.fn()} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText('停车办理申请')).toBeTruthy();
    expect(screen.getByText(/还缺：申请内容、申请数量/u)).toBeTruthy();
    expect(screen.getByText(/30 分钟后过期/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认提交' })).toBeNull();
  });

  it('继续、确认和取消始终回传用户点击的准确草稿', () => {
    const onContinue = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConversationDraftCenter drafts={[collecting, ready]} now={1_000} onContinue={onContinue} onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: '继续填写停车办理申请' }));
    fireEvent.click(screen.getByRole('button', { name: '确认提交合同审查器' }));
    fireEvent.click(screen.getByRole('button', { name: '取消合同审查器' }));

    expect(onContinue).toHaveBeenCalledWith(collecting);
    expect(onConfirm).toHaveBeenCalledWith(ready);
    expect(onCancel).toHaveBeenCalledWith(ready);
  });

  it('过期草稿不再显示，也不能触发任何动作', () => {
    const onConfirm = vi.fn();
    render(<ConversationDraftCenter drafts={[ready]} now={ready.expiresAt} onContinue={vi.fn()} onConfirm={onConfirm} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText('对话操作草稿')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('真实操作执行期间不提供确认、重试或取消入口', () => {
    render(<ConversationDraftCenter drafts={[submitting]} now={1_000} onContinue={vi.fn()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.getByText(/当前不能撤回或重复提交/u)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
