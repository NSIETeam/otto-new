/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { OttoMessage } from 'otto-server';
import { ToolCallStatus } from 'otto-server';
import { Message } from './Message.js';
import { Prose } from './Prose.js';
vi.mock('../assets/otto-avatar.png', () => ({ default: 'avatar.png' }));
afterEach(() => {
  delete (window as unknown as { otto?: unknown }).otto;
});
const outputPath = 'C:/private/report.pptx';
const message = (text: string): OttoMessage => ({
  id: 'a',
  role: 'assistant',
  sessionId: 's',
  source: 'local',
  timestamp: 1,
  phase: 'final_answer',
  content: [{ type: 'text', value: text }],
  turn: {
    contractVersion: 1,
    turnId: 't',
    sequence: 2,
    status: 'completed',
    startedAt: 0,
    updatedAt: 2,
    items: [],
    artifacts: [
      { id: 'p', path: outputPath, label: '报告.pptx', verified: true },
    ],
  },
});
describe('natural delivery display', () => {
  it.each([
    `路径是 ${outputPath}，稍后可查看`,
    `\`\`\`text\n${outputPath}\n\`\`\``,
  ])(
    'does not mistake a mere path mention for a clickable delivery: %s',
    (text) => {
      render(
        <Message
          message={message(text)}
          onCopy={vi.fn()}
          onRegenerate={vi.fn()}
        />,
      );
      expect(screen.getByRole('region', { name: '交付物' })).toBeTruthy();
      expect(
        screen.getByRole('link', { name: '在 Otto 中预览 报告.pptx' }),
      ).toBeTruthy();
    },
  );
  it('does not hide an unverified artifact warning behind a model-written inline link', () => {
    const m = message(`[报告](<${outputPath}>)`);
    m.turn!.artifacts![0].verified = false;
    render(<Message message={m} onCopy={vi.fn()} onRegenerate={vi.fn()} />);
    expect(screen.getByText('待验证')).toBeTruthy();
  });
  it('puts final content ahead of earlier commentary and keeps one final action row', () => {
    const m = message('简短的最终答复');
    m.progressMessages = [
      { id: 'p', text: '发现尚未包含第三季度数据。', timestamp: 0 },
    ];
    const { container } = render(
      <Message message={m} onCopy={vi.fn()} onRegenerate={vi.fn()} />,
    );
    expect(container.textContent!.indexOf('简短的最终答复')).toBeLessThan(
      container.textContent!.indexOf('发现尚未包含第三季度数据。'),
    );
    expect(screen.getAllByLabelText('重新生成')).toHaveLength(1);
    expect(screen.getByText('发现尚未包含第三季度数据。')).toBeTruthy();
  });
  it.each([
    'review_answer_evidence',
    'plan_delivery_repair',
    'prepare_repair_format',
  ])(
    'hides successful internal bookkeeping %s but keeps its failed outcome',
    (toolName) => {
      const m = message('最终答复');
      m.turn = undefined;
      const tool = {
        id: 'h',
        toolName,
        parameters: {},
        status: ToolCallStatus.Success,
      };
      m.associatedToolCalls = [tool];
      const { container, rerender } = render(
        <Message message={m} onCopy={vi.fn()} onRegenerate={vi.fn()} />,
      );
      expect(container.querySelector('.otto-process-trace')).toBeNull();
      rerender(
        <Message
          message={{
            ...m,
            associatedToolCalls: [{ ...tool, status: ToolCallStatus.Error }],
          }}
          onCopy={vi.fn()}
          onRegenerate={vi.fn()}
        />,
      );
      expect(container.querySelector('.otto-process-trace')).not.toBeNull();
    },
  );
  it('shows friendly names for non-PPT files while inspecting and opens nothing automatically', async () => {
    const activateLocalPath = vi.fn(async () => ({ ok: true }));
    window.otto = {
      inspectLocalPath: vi.fn(async () => ({
        exists: true,
        kind: 'file',
        canOpen: true,
      })),
      activateLocalPath,
    } as unknown as typeof window.otto;
    const { container } = render(<Prose text={'`C:/private/客户报告.docx`'} />);
    expect(container.textContent).not.toContain('C:/private');
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: '在文件夹中显示 客户报告.docx' }),
      ).toBeTruthy(),
    );
    expect(activateLocalPath).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('link', { name: '在文件夹中显示 客户报告.docx' }),
    );
    await waitFor(() =>
      expect(activateLocalPath).toHaveBeenCalledWith(
        'C:/private/客户报告.docx',
        'reveal',
      ),
    );
    expect(activateLocalPath).not.toHaveBeenCalledWith(
      expect.anything(),
      'open',
    );
  });
});
