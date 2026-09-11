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
  it('keeps one enable entry with nearby consent instead of a duplicate enable panel', async () => {
    const act=vi.fn(async()=>({...state,enabled:true}));
    Object.assign(window.otto,{policyIntelligenceGet:vi.fn(async()=>state),policyIntelligenceAction:act});
    render(<PolicyIntelligenceDialog open scopeId="o:a" seedProfile={{}} onClose={vi.fn()} />);
    await screen.findByText('绿色金融申报');
    expect(screen.queryByText('开启企业个性化政策服务')).toBeNull();
    expect(screen.queryByRole('button',{name:'确认开启'})).toBeNull();
    fireEvent.click(screen.getByRole('checkbox',{name:/同意.*企业基础资料/u}));
    fireEvent.click(screen.getByRole('button',{name:'开启个性化服务'}));
    await screen.findByRole('button',{name:'关闭个性化服务'});
    expect(act).toHaveBeenCalledTimes(1);
  });
  it('reconciles a lost configure response with a read, without resubmitting', async () => {
    const get=vi.fn().mockResolvedValueOnce({...state,enabled:true}).mockResolvedValue({...state,enabled:false});
    const act=vi.fn().mockRejectedValue(new Error("Error invoking remote method 'policy-intelligence:action': Error: 服务器返回 502"));
    Object.assign(window.otto,{policyIntelligenceGet:get,policyIntelligenceAction:act});
    render(<PolicyIntelligenceDialog open scopeId="o:a" seedProfile={{}} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button',{name:'关闭个性化服务'}));
    await screen.findByRole('button',{name:'开启个性化服务'});
    expect(get).toHaveBeenCalledTimes(2);
    expect(act).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Error invoking/)).toBeNull();
  });
  it('does not present a failed initial load as an empty library', async () => {
    Object.assign(window.otto,{policyIntelligenceGet:vi.fn().mockRejectedValue(new Error('服务器返回 502'))});
    render(<PolicyIntelligenceDialog open scopeId="o:a" seedProfile={{}} onClose={vi.fn()} />);
    await screen.findByText('暂时无法加载政策');
    expect(screen.queryByText('当前筛选条件下暂无已收录政策')).toBeNull();
    expect(screen.getByRole('button',{name:'重新读取状态'})).toBeTruthy();
  });
  it('blocks another toggle when both mutation and reconciliation fail, until a read confirms state', async () => {
    const get = vi.fn().mockResolvedValueOnce({ ...state, enabled: true }).mockRejectedValue(new Error('服务器返回 502'));
    const action = vi.fn().mockRejectedValue(new Error('服务器返回 502'));
    Object.assign(window.otto, { policyIntelligenceGet: get, policyIntelligenceAction: action });
    render(<PolicyIntelligenceDialog open scopeId="o:a" seedProfile={{}} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '关闭个性化服务' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect((screen.getByRole('button', { name: '关闭个性化服务' }) as HTMLButtonElement).disabled).toBe(true);
    get.mockResolvedValue({ ...state, enabled: false });
    fireEvent.click(screen.getByRole('button', { name: '重新读取状态' }));
    await screen.findByRole('button', { name: '开启个性化服务' });
    expect(action).toHaveBeenCalledOnce();
  });
  it('places collapsed nationwide sources after the policy list in a bounded region', async () => {
    Object.assign(window.otto,{policyIntelligenceGet:vi.fn(async()=>({...state,sourceHealth:[{sourceId:'s',name:'全国来源测试',url:'https://www.gov.cn',status:'available',documentCount:1}]}))});
    render(<PolicyIntelligenceDialog open scopeId="o:a" seedProfile={{}} onClose={vi.fn()} />);
    const title=await screen.findByText('绿色金融申报');
    const details=screen.getByText('全国官方来源接入情况').closest('details')!;
    expect(details.open).toBe(false);
    expect(title.compareDocumentPosition(details)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(details?.querySelector('.otto-policy-v2__sources-scroll')).toBeTruthy();
  });
  it('关闭重开保留已读政策，即使新的读取尚未结束', async () => {
    const get = vi.fn().mockResolvedValueOnce(state).mockImplementation(() => new Promise(() => {}));
    Object.assign(window.otto, { policyIntelligenceGet: get });
    const props = { scopeId: 'org-1', seedProfile: {}, onClose: vi.fn() };
    const view = render(<PolicyIntelligenceDialog open {...props} />);
    await screen.findByText('绿色金融申报');
    view.rerender(<PolicyIntelligenceDialog open={false} {...props} />);
    view.rerender(<PolicyIntelligenceDialog open {...props} />);
    expect(screen.getByText('绿色金融申报')).toBeTruthy();
  });

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
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /同意/u }));
    fireEvent.click(screen.getByRole('button', { name: '开启个性化服务' }));
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
