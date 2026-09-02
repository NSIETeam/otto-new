/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PolicyIntelligenceDialog } from './PolicyIntelligenceDialog.js';

const disabledState = {
  enabled: false, profile: { organizationName: '甲公司' }, policies: [], assessments: [], syncStatus: 'idle' as const,
};

describe('政策智能服务界面', () => {
  it('默认明确关闭，只有用户点击开启后才配置并同步', async () => {
    const configure = vi.fn(async () => ({ ...disabledState, enabled: true }));
    const sync = vi.fn(async () => ({ ...disabledState, enabled: true }));
    Object.assign(window.otto, {
      policyIntelligenceGet: vi.fn(async () => disabledState),
      policyIntelligenceConfigure: configure,
      policyIntelligenceSync: sync,
      policyIntelligenceUpdateProfile: vi.fn(),
    });
    render(<PolicyIntelligenceDialog open scopeId="org-a" seedProfile={{ organizationName: '甲公司' }} onClose={vi.fn()}/>);
    expect(await screen.findByText('关闭状态不访问政策网站、不调用模型，也不消耗 Token。')).toBeTruthy();
    expect(sync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '开启服务' }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({ scopeId: 'org-a', enabled: true })));
    await waitFor(() => expect(sync).toHaveBeenCalledWith({ scopeId: 'org-a', reason: 'manual' }));
  });

  it('展示差距和官方原文，并把原文交给受控外链打开器', async () => {
    const openExternal = vi.fn(async () => undefined);
    Object.assign(window.otto, {
      openExternal,
      policyIntelligenceGet: vi.fn(async () => ({
        enabled: true,
        profile: { organizationName: '甲公司', registeredRegion: '北京市', industry: '软件' },
        syncStatus: 'idle' as const,
        policies: [{ id: 'p1', title: '研发补助项目', url: 'https://kw.beijing.gov.cn/p1', sourceName: '北京市科委', publishedAt: '2026-09-01', fetchedAt: '2026-09-02T00:00:00.000Z', contentHash: 'hash', bodyText: '原文' }],
        assessments: [{ policyId: 'p1', status: 'has_gaps' as const, score: 72, summary: '行业初步匹配', conditions: [], gaps: ['研发投入还差 2%'], missingFields: [], resourceConnections: ['市科委申报平台'], assessedAt: '2026-09-02T00:00:00.000Z', profileFingerprint: 'profile', policyContentHash: 'hash' }],
      })),
      policyIntelligenceConfigure: vi.fn(), policyIntelligenceSync: vi.fn(), policyIntelligenceUpdateProfile: vi.fn(),
    });
    render(<PolicyIntelligenceDialog open scopeId="org-a" seedProfile={{ organizationName: '甲公司' }} onClose={vi.fn()}/>);

    expect(await screen.findByText('研发补助项目')).toBeTruthy();
    expect(screen.getByText(/研发投入还差 2%/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看官方原文' }));
    expect(openExternal).toHaveBeenCalledWith('https://kw.beijing.gov.cn/p1');
  });
});
