/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunGuide } from './FirstRunGuide.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('FirstRunGuide', () => {
  it('walks through the unified workspace UI and remembers completion', () => {
    render(<FirstRunGuide />);

    expect(screen.getByText('对话与工作区并排协作')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('右侧工作区会一直陪着你')).toBeTruthy();
    expect(screen.getByText('Otto 工作区导览')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /前往第 4 步/ }));
    expect(screen.getByText('左侧统一管理工作入口')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开始使用' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem('otto:first-run-guide:v3:workspace')).toBe('completed');
  });

  it('stays hidden after the workspace walkthrough has completed', () => {
    localStorage.setItem('otto:first-run-guide:v3:workspace', 'completed');
    render(<FirstRunGuide />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('honors completion from the former work-layout guide without accepting the retired layout', () => {
    localStorage.setItem('otto:first-run-guide:v2:work', 'completed');
    const completed = render(<FirstRunGuide />);
    expect(screen.queryByRole('dialog')).toBeNull();

    completed.unmount();
    localStorage.clear();
    localStorage.setItem('otto:first-run-guide:v2:conversational', 'completed');
    render(<FirstRunGuide />);
    expect(screen.getByText('对话与工作区并排协作')).toBeTruthy();
  });

  it('supports direct step navigation from the progress controls', () => {
    render(<FirstRunGuide />);
    fireEvent.click(screen.getByRole('button', { name: /前往第 3 步/ }));
    expect(screen.getByText('从这里下达任务')).toBeTruthy();
  });

  it('remains usable when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    render(<FirstRunGuide />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '跳过导览' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
