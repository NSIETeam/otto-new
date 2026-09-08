import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecruitmentSourceResults } from './RecruitmentSourceResults.js';

describe('招聘来源范围说明', () => {
  it('shows the reviewed search scope even when no candidates were returned', () => {
    render(<RecruitmentSourceResults result={{ runId: 'run-1', candidates: [], sources: [{ sourceId: 'workable', label: 'Workable', status: 'ok', count: 0, durationMs: 1, message: '只读已绑定岗位，未按自由文本筛选，不是全站人才搜索。' }] }} sources={[]} busy={false} onImport={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('不是全站人才搜索');
    expect(screen.getByText(/临时检索结果保留 24 小时/).textContent).toContain('已正式入档的候选人资料不受影响');
  });
});
