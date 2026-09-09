/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CarpoolExamples } from './CarpoolExamples.js';

describe('同行示例', () => {
  it('shows three explicitly labelled examples and keeps requests local', () => {
    const execute = vi.fn();
    Object.assign(window.otto, { enterpriseParkCarpoolWorkflowExecute: execute });
    render(<CarpoolExamples />);
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    for (const card of cards) expect(within(card).getByText('示例')).toBeTruthy();
    expect(screen.getByText('95%')).toBeTruthy();
    expect(screen.getByText('86%')).toBeTruthy();
    expect(screen.getByText('72%')).toBeTruthy();
    fireEvent.click(within(cards[0]!).getByRole('button', { name: '体验联系' }));
    expect(within(cards[0]!).getByRole('status').textContent).toContain('等待回应');
    fireEvent.click(within(cards[0]!).getByRole('button', { name: '模拟对方接受' }));
    expect(within(cards[0]!).getByRole('status').textContent).toContain('已接受');
    expect(within(cards[1]!).queryByRole('status')).toBeNull();
    fireEvent.click(within(cards[0]!).getByRole('button', { name: '重新体验' }));
    expect(within(cards[0]!).getByRole('button', { name: '体验联系' })).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });
});
