import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RecruitmentOneOffAnalysis } from './RecruitmentOneOffAnalysis.js';
const request = { kind: 'analyze_intake_once' as const, jobId: 'job', itemId: 'a'.repeat(64), expectedRevision: 1, scopeToken: 'b'.repeat(64), headerToken: 'c'.repeat(64), modelVersion: 'v', confirmed: true as const };
it('requires independent per-item consent and invalidates it synchronously when the confirmed revision changes', () => {
  const onRun = vi.fn(); const { rerender } = render(<RecruitmentOneOffAnalysis request={request} modelId="company-model" disabled={false} onRun={onRun} />);
  const button = screen.getByRole('button', { name: '只分析这一份（企业模型）', hidden: true }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); fireEvent.click(button); expect(onRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(/我确认本份简历可发送给/));
  expect(button.disabled).toBe(false);
  rerender(<RecruitmentOneOffAnalysis request={{ ...request, expectedRevision: 2 }} modelId="company-model" disabled={false} onRun={onRun} />);
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/我确认本份简历可发送给/)); fireEvent.click(button);
  expect(onRun).toHaveBeenCalledWith({ ...request, expectedRevision: 2 });
  expect(screen.getByText(/不会开启后台任务/)).toBeTruthy();
});
it('does not offer fallback model calls when server configuration is missing', () => {
  render(<RecruitmentOneOffAnalysis disabled={false} onRun={vi.fn()} />);
  expect(screen.queryByRole('button', { name: '只分析这一份（企业模型）', hidden: true })).toBeNull();
  expect(screen.getByText(/先保存企业模型与岗位额度/)).toBeTruthy();
});
