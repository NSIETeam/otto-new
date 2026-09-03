/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PolicyIntelligenceDialog } from './PolicyIntelligenceDialog.js';
import { emptyPolicyState } from '../policyIntelligencePresentation.js';
const state = {
  ...emptyPolicyState(),
  canManage: true,
  profile: { organizationName: '上海公司' },
  region: { country: 'CN' as const, city: '上海市', district: '浦东新区' },
  coverage: [
    {
      level: 'district' as const,
      regionLabel: '浦东新区',
      sourceCount: 0,
      status: 'missing' as const,
    },
  ],
  categories: ['绿色金融'],
  policies: [
    {
      id: 'p1',
      title: '绿色金融申报',
      url: 'https://www.gov.cn/p1',
      sourceName: '国务院',
      sourceId: 'national',
      issuer: '国务院',
      level: 'national' as const,
      region: { country: 'CN' as const },
      categories: ['绿色金融'],
      version: 1,
      fetchedAt: '2026-09-03',
      contentHash: 'hash',
      bodyText: '政策原文',
      summary: '支持绿色项目',
      supportText: '按原文标准',
      conditions: [],
      conditionTree: { all: [] },
      materials: [],
      resources: [],
      attachments: [],
      sourceStatus: 'verified' as const,
      interpretationStatus: 'ready' as const,
    },
  ],
};
describe('全国企业政策服务界面', () => {
  it('shows exclusion evidence, validity and a consent-gated feedback form', async () => {
    const quote = '失信企业不予支持，完成修复的除外。';
    const view = {
      ...state,
      enabled: true,
      policies: [
        {
          ...state.policies[0],
          deadline: '2099-10-01',
          exclusionsReviewed: true,
          exclusions: [
            {
              id: 'credit',
              label: '信用排除',
              quote,
              when: {
                field: 'blacklisted',
                operator: 'eq' as const,
                value: true,
                quote,
              },
            },
          ],
        },
      ],
    };
    const act = vi.fn(async () => view);
    Object.assign(window.otto, {
      policyIntelligenceGet: vi.fn(async () => view),
      policyIntelligenceAction: act,
    });
    render(
      <PolicyIntelligenceDialog
        open
        scopeId="o:a"
        seedProfile={{}}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('绿色金融申报');
    fireEvent.click(screen.getByRole('button', { name: '条件与材料' }));
    expect(screen.getByText('排除条款与例外')).toBeTruthy();
    expect(screen.getByText(quote)).toBeTruthy();
    expect(screen.getByText(/文件效力待核验/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('反馈类型'), {
      target: { value: 'rejected' },
    });
    fireEvent.change(screen.getByLabelText('反馈原因'), {
      target: { value: 'quota' },
    });
    fireEvent.change(screen.getByLabelText('依据或情况说明'), {
      target: { value: '本批次名额已满' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存反馈记录' }));
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认以上信息/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存反馈记录' }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        scopeId: 'o:a',
        action: {
          action: 'feedback',
          policyId: 'p1',
          revision: 0,
          consent: true,
          feedback: {
            outcome: 'rejected',
            reason: 'quota',
            note: '本批次名额已满',
          },
        },
      }),
    );
  });
  it('关闭时仍可浏览，显示未覆盖来源，启用前必须知情同意', async () => {
    const act = vi.fn(async () => ({ ...state, enabled: true }));
    Object.assign(window.otto, {
      policyIntelligenceGet: vi.fn(async () => state),
      policyIntelligenceAction: act,
    });
    render(
      <PolicyIntelligenceDialog
        open
        scopeId="o:a"
        seedProfile={{}}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText('绿色金融申报')).toBeTruthy();
    expect(screen.getByText(/浦东新区.*尚未接入/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开启个性化服务' }));
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /同意/u }));
    fireEvent.click(screen.getByRole('button', { name: '确认开启' }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        scopeId: 'o:a',
        action: { action: 'configure', enabled: true, consent: true },
      }),
    );
  });
  it('类型随实际政策扩展，地区筛选不强行加入北京，原文走受控外链', async () => {
    const openExternal = vi.fn();
    Object.assign(window.otto, {
      policyIntelligenceGet: vi.fn(async () => state),
      openExternal,
    });
    render(
      <PolicyIntelligenceDialog
        open
        scopeId="o:a"
        seedProfile={{}}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText('绿色金融申报');
    expect(screen.getByRole('option', { name: '绿色金融' })).toBeTruthy();
    expect(screen.queryByText('北京市')).toBeNull();
    fireEvent.change(screen.getByLabelText('政策级别'), {
      target: { value: 'district' },
    });
    expect(screen.queryByText('绿色金融申报')).toBeNull();
    fireEvent.change(screen.getByLabelText('政策级别'), {
      target: { value: 'all' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查看官方原文' }));
    expect(openExternal).toHaveBeenCalledWith('https://www.gov.cn/p1');
  });
});
