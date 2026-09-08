/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EnterpriseMemoryVersions } from './EnterpriseMemoryVersions.js';

const current = {
  id: '1',
  version: 3,
  title: '交付检查',
  category: '流程',
  content: '先扫描，再审批。',
  department: '研发部',
  status: 'active' as const,
};
const revisions = [
  {
    id: 'r1',
    version: 1,
    title: '交付检查',
    category: '流程',
    content: '先扫描。',
    changeNote: '首次整理',
    createdAt: '2026-09-01',
  },
];

describe('enterprise memory version evidence', () => {
  it('shows an honest comparison and requires rationale plus explicit confirmation before restoring', () => {
    const restore = vi.fn();
    render(
      <EnterpriseMemoryVersions
        current={current}
        revisions={revisions}
        canRestore
        onRestore={restore}
        busy={false}
      />,
    );
    expect(screen.getByText('当前 v3')).toBeTruthy();
    expect(screen.getByText('所选历史 v1')).toBeTruthy();
    expect(screen.getByText(/不代表新版更准确/)).toBeTruthy();
    expect(screen.getByText(/研发部/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: '恢复为待确认版本' });
    fireEvent.click(submit);
    expect(restore).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('恢复依据'), {
      target: { value: '审批流程已调整，恢复旧内容后重新复核。' },
    });
    fireEvent.click(submit);
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(submit);
    expect(restore).toHaveBeenCalledWith(
      revisions[0],
      '审批流程已调整，恢复旧内容后重新复核。',
    );
  });

  it('never offers a restore action to members or for a current-version snapshot', () => {
    const view = render(
      <EnterpriseMemoryVersions
        current={current}
        revisions={revisions}
        canRestore={false}
        onRestore={vi.fn()}
        busy={false}
      />,
    );
    expect(
      screen.queryByRole('button', { name: '恢复为待确认版本' }),
    ).toBeNull();
    view.rerender(
      <EnterpriseMemoryVersions
        current={current}
        revisions={[{ ...revisions[0], version: 3 }]}
        canRestore
        onRestore={vi.fn()}
        busy={false}
      />,
    );
    expect(
      screen.queryByRole('button', { name: '恢复为待确认版本' }),
    ).toBeNull();
  });
});
