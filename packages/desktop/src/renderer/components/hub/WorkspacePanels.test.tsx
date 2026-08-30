// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryPanel, ToolsPanel } from './WorkspacePanels.js';

describe('ToolsPanel', () => {
  it('leaves the loading state after a bounded wait and offers retry', () => {
    vi.useFakeTimers();
    const refreshTools = vi.fn();
    const data = {
      state: { tools: [] },
      actions: { refreshTools },
    } as never;
    render(<ToolsPanel data={data} activeSession={{ sessionId: 'session-1' } as never} />);

    expect(screen.getByText('正在加载工具清单…')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText(/工具清单读取超时/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(refreshTools).toHaveBeenCalledWith('session-1');
    expect(screen.getByText('正在加载工具清单…')).toBeTruthy();
    vi.useRealTimers();
  });

  it('shows an empty result instead of loading forever after tools resolve', () => {
    const data = {
      state: { tools: [], toolsLoadedSessionId: 'session-1' },
      actions: { refreshTools: vi.fn() },
    } as never;
    render(<ToolsPanel data={data} activeSession={{ sessionId: 'session-1' } as never} />);
    expect(screen.getByText('当前会话没有可用工具。')).toBeTruthy();
  });

  it('shows an empty result instead of loading forever after memory resolves', () => {
    const data = {
      state: { memoryFiles: [], memoryLoaded: true },
      actions: { refreshMemory: vi.fn(), addMemory: vi.fn() },
    } as never;
    render(<MemoryPanel data={data} />);
    expect(screen.getByText('当前没有记忆文件。')).toBeTruthy();
  });
});
