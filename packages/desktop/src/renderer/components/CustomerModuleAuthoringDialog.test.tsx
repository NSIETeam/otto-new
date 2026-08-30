import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerModuleAuthoringDialog } from './CustomerModuleAuthoringDialog.js';

describe('CustomerModuleAuthoringDialog', () => {
  it('starts at the six-step identity form and supports keyboard dismissal with focus restoration', () => {
    const trigger = document.createElement('button'); trigger.textContent = 'trigger'; document.body.append(trigger); trigger.focus();
    const onClose = vi.fn();
    const view = render(<CustomerModuleAuthoringDialog open publisher={{ id: 'publisher', name: 'King' }} onSubmit={vi.fn()} onClose={onClose} />);
    expect(screen.getByText(/步骤 1\/6/)).toBeTruthy();
    expect(screen.getByLabelText('稳定模块 ID').closest('label')?.parentElement?.classList
      .contains('otto-customer-module-authoring__form')).toBe(true);
    expect(screen.getByLabelText('模块说明').classList
      .contains('otto-customer-module-authoring__textarea')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭创建模块' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: '创建客户模块' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<CustomerModuleAuthoringDialog open={false} publisher={{ id: 'publisher', name: 'King' }} onSubmit={vi.fn()} onClose={onClose} />);
    expect(document.activeElement).toBe(trigger);
  });
});
