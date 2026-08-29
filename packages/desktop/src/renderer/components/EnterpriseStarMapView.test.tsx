/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnterpriseStarMapView } from './EnterpriseStarMapView.js';

beforeEach(() => {
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterpriseParkStarMap: vi.fn(async () => ({
        parkId: 'park-a',
        parkName: '宏创园区',
        currentOrganizationId: 'org-a',
        generatedAt: '2026-08-29T08:00:00.000Z',
        nodes: [
          {
            organizationId: 'org-a', organizationName: '甲企业', summary: '软件企业',
            website: '', industryTags: ['软件'], productsServices: ['数字化改造'],
            capabilities: ['软件开发'], cooperationNeeds: ['法律咨询'],
            publicContact: 'a@example.com', isPublic: true, updatedAt: null,
          },
          {
            organizationId: 'org-b', organizationName: '乙企业', summary: '法律服务企业',
            website: '', industryTags: ['法律'], productsServices: ['法律咨询服务'],
            capabilities: ['法律咨询'], cooperationNeeds: ['软件开发'],
            publicContact: 'b@example.com', isPublic: true, updatedAt: null,
          },
        ],
        edges: [{
          id: 'org-a--org-b', sourceOrganizationId: 'org-a', targetOrganizationId: 'org-b',
          strength: 'strong', ruleConfidence: 0.86,
          evidence: ['甲企业公开需求“法律咨询”与乙企业公开能力“法律咨询”存在互补'],
          unverifiedQuestions: ['双方需核实交付范围、产能、时间与商务条件。'],
        }],
      })),
    } as unknown as Window['otto'],
  });
});

describe('EnterpriseStarMapView', () => {
  it('shows public organizations, rule evidence and a non-decision disclaimer', async () => {
    render(<EnterpriseStarMapView onBack={() => undefined} />);

    expect(await screen.findByText('甲企业 ↔ 乙企业')).toBeTruthy();
    expect(screen.getByText(/公开需求“法律咨询”/)).toBeTruthy();
    expect(screen.getByText('规则置信度 86%')).toBeTruthy();
    expect(screen.getByText(/不代表合作承诺、履约能力或商业成功概率/)).toBeTruthy();
    await waitFor(() => expect(window.otto.enterpriseParkStarMap).toHaveBeenCalledOnce());
  });
});
