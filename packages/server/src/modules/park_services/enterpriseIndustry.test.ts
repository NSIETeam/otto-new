import { describe, expect, it } from 'vitest';
import {
  buildIndustryGraph,
  normalizePrimaryIndustry,
} from './enterpriseIndustry.js';
import type { EnterprisePublicProfile } from './parkPartnershipTypes.js';

const profile = (
  id: string,
  code: string | null = 'it_services',
  confirmed = true,
): EnterprisePublicProfile => ({
  organizationId: id,
  organizationName: id,
  summary: '',
  website: '',
  industryTags: ['相同标签'],
  productsServices: [],
  capabilities: [],
  cooperationNeeds: [],
  publicContact: '',
  isPublic: true,
  updatedAt: null,
  primaryIndustryCode: code,
  industryConfirmedByCompany: confirmed,
});
describe('standard primary industry', () => {
  it('accepts only dictionary codes and derives trusted names and confirmation', () => {
    expect(normalizePrimaryIndustry('it_services')).toMatchObject({
      primaryIndustryName: '软件与信息技术服务',
      industryConfirmedByCompany: true,
    });
    expect(normalizePrimaryIndustry(null).industryConfirmedByCompany).toBe(
      false,
    );
    expect(() => normalizePrimaryIndustry('invented')).toThrow();
    expect(() => normalizePrimaryIndustry(12)).toThrow();
  });
  it('groups exact confirmed codes without guessing from labels or disclosing private members', () => {
    const graph = buildIndustryGraph([
      profile('b'),
      profile('a'),
      profile('c', 'medical_devices'),
      profile('unknown', null),
      profile('unconfirmed', 'it_services', false),
      { ...profile('private'), isPublic: false },
    ]);
    expect(graph.industryGroups).toEqual([
      {
        code: 'it_services',
        name: '软件与信息技术服务',
        memberOrganizationIds: ['a', 'b'],
      },
      {
        code: 'medical_devices',
        name: '医疗器械',
        memberOrganizationIds: ['c'],
      },
    ]);
    expect(graph.unclassifiedNodeIds).toEqual(['unconfirmed', 'unknown']);
    expect(graph.relationshipCount).toBe(1);
  });
  it('counts a dense industry without allocating quadratic edge objects or duplicate members', () => {
    const graph = buildIndustryGraph([
      ...Array.from({ length: 100 }, (_, i) => profile(String(i))),
      profile('0'),
    ]);
    expect(graph.relationshipCount).toBe(4950);
    expect(graph.industryGroups[0].memberOrganizationIds).toHaveLength(100);
  });
  it('allows research classification only for explicitly isolated demo data', () => {
    expect(
      buildIndustryGraph([
        profile('a', 'it_services', false),
        profile('b', 'it_services', false),
      ]).relationshipCount,
    ).toBe(0);
    expect(
      buildIndustryGraph(
        [
          profile('a', 'it_services', false),
          profile('b', 'it_services', false),
        ],
        'demo',
      ).relationshipCount,
    ).toBe(1);
  });
});
