/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { inferParkPartnerships } from './parkPartnershipInference.js';
import type { EnterprisePublicProfile } from './parkPartnershipTypes.js';

function profile(
  organizationId: string,
  organizationName: string,
  input: Partial<EnterprisePublicProfile> = {},
): EnterprisePublicProfile {
  return {
    organizationId,
    organizationName,
    summary: '',
    website: '',
    industryTags: [],
    productsServices: [],
    capabilities: [],
    cooperationNeeds: [],
    publicContact: '',
    isPublic: true,
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...input,
  };
}

describe('inferParkPartnerships', () => {
  it('uses disclosed needs and capabilities to produce explainable evidence', () => {
    const edges = inferParkPartnerships([
      profile('org-a', '甲企业', {
        cooperationNeeds: ['园区数字化改造', '短视频推广'],
      }),
      profile('org-b', '乙企业', {
        capabilities: ['园区数字化改造实施'],
        productsServices: ['企业短视频推广'],
      }),
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceOrganizationId: 'org-a',
      targetOrganizationId: 'org-b',
      strength: 'promising',
    });
    expect(edges[0]!.ruleConfidence).toBeGreaterThanOrEqual(0.75);
    expect(edges[0]!.evidence).toEqual([
      '甲企业公开需求“园区数字化改造”与乙企业公开能力“园区数字化改造实施”存在互补',
      '甲企业公开需求“短视频推广”与乙企业公开产品/服务“企业短视频推广”存在互补',
    ]);
    expect(edges[0]!.unverifiedQuestions).toContain(
      '双方需核实交付范围、产能、时间与商务条件。',
    );
  });

  it('does not infer from contact details, website, summary or industry labels alone', () => {
    const edges = inferParkPartnerships([
      profile('org-a', '甲企业', {
        industryTags: ['人工智能'],
        summary: '寻找张三合作',
        publicContact: '张三 13800000000',
      }),
      profile('org-b', '乙企业', {
        industryTags: ['人工智能'],
        website: 'https://example.com/zhangsan',
        publicContact: '张三 13800000000',
      }),
    ]);

    expect(edges).toEqual([]);
  });

  it('keeps output deterministic and avoids duplicate reverse edges', () => {
    const profiles = [
      profile('org-b', '乙企业', {
        cooperationNeeds: ['法律咨询'],
        capabilities: ['软件开发'],
      }),
      profile('org-a', '甲企业', {
        cooperationNeeds: ['软件开发'],
        capabilities: ['法律咨询'],
      }),
    ];

    expect(inferParkPartnerships(profiles)).toEqual(
      inferParkPartnerships([...profiles].reverse()),
    );
    expect(inferParkPartnerships(profiles)).toHaveLength(1);
    expect(inferParkPartnerships(profiles)[0]!.strength).toBe('strong');
  });
});
