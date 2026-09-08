import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RecruitmentBackgroundPanel } from './RecruitmentBackgroundPanel.js';
import type { RecruitmentBackgroundState } from 'otto-server';
import { validRecruitmentBackground } from '../recruitmentArchiveValidation.js';

it('saves enterprise limits without starting background work and allows an owner to discard a pending one-off result', () => {
  const onConfigure = vi.fn();
  const { rerender } = render(<RecruitmentBackgroundPanel canManage disabled={false} onConfigure={onConfigure} />);
  const save = screen.getByRole('button', { name: '保存额度，不开启后台' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/接受模型费用/));
  fireEvent.change(screen.getByLabelText('每天最多调用次数'), { target: { value: '2' } });
  fireEvent.click(save); expect(onConfigure).toHaveBeenCalledWith(false, 2, 100_000);
  const config: RecruitmentBackgroundState = { enabled: false, generation: 'g', actorAccountId: 'hr', confirmedAt: '2026-09-08', scopeToken: 's', headerToken: 'h', modelVersion: 'v', modelId: 'm', dailyRequestLimit: 2, dailyReservedTokenLimit: 100_000, message: '处理中', usage: [], pending: { id: 'run', itemId: 'item', day: '2026-09-08', until: '2099-01-01T00:00:00Z' } };
  rerender(<RecruitmentBackgroundPanel config={config} canManage disabled={false} onConfigure={onConfigure} />);
  const stop = screen.getByRole('button', { name: '停止接收本次结果（可能仍计费）' }) as HTMLButtonElement;
  expect(stop.disabled).toBe(false); fireEvent.click(stop);
  expect(onConfigure).toHaveBeenLastCalledWith(false, 2, 100_000);
});

it('labels the enterprise snapshot separately from job and desktop usage without inventing live totals', () => {
  const config: RecruitmentBackgroundState = { enabled: true, generation: 'g', actorAccountId: 'hr', confirmedAt: '2026-09-08', scopeToken: 's', headerToken: 'h', modelVersion: 'v', modelId: 'm', dailyRequestLimit: 5, dailyReservedTokenLimit: 100_000, message: '已开启', usage: [],
    organizationUsage: { day: '2026-09-07', checkedAt: '2026-09-07T10:00:00Z', dailyRequests: 10, dailyReservedTokens: 200_000, requests: 8, reservedTokens: 100_000, inputTokens: 50_000, outputTokens: 10_000, unknownRequests: 1 } };
  const { rerender } = render(<RecruitmentBackgroundPanel config={config} canManage={false} disabled={false} onConfigure={vi.fn()} />);
  expect(screen.getByText(/企业服务器招聘额度快照/).textContent).toContain('2026-09-07');
  expect(screen.getByText(/8 \/ 10 次/)).toBeTruthy();
  expect(screen.getByText(/桌面端自带模型.*不计入/)).toBeTruthy();
  rerender(<RecruitmentBackgroundPanel config={{ ...config, organizationUsage: undefined }} canManage={false} disabled={false} onConfigure={vi.fn()} />);
  expect(screen.getByText(/尚未取得企业总额度快照/)).toBeTruthy();
});

it('rejects malformed quota snapshots before replacing a shared archive', () => {
  const valid = { enabled: true, generation: 'g', actorAccountId: 'hr', confirmedAt: '2026-09-08', scopeToken: 'a'.repeat(64), headerToken: 'b'.repeat(64), modelVersion: 'v', modelId: 'm', dailyRequestLimit: 5, dailyReservedTokenLimit: 100_000, message: '', usage: [] };
  expect(validRecruitmentBackground(valid)).toBe(true);
  expect(validRecruitmentBackground({ ...valid, organizationUsage: { requests: { secret: true } } })).toBe(false);
});
