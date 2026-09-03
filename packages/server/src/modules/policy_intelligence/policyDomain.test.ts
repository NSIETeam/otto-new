import { describe, expect, it } from 'vitest';
import {
  normalizePolicyRegion,
  sourceMatchesRegion,
  policyCategories,
  evaluatePolicyConclusion,
  policyApplicationStatus,
  validatePolicyEvidence,
  policyRecommendationGroup,
} from './policyDomain.js';

describe('nationwide policy domain', () => {
  it('normalizes municipalities and fully qualified non-Beijing addresses', () => {
    expect(normalizePolicyRegion('上海市浦东新区')).toEqual({
      country: 'CN',
      province: '上海市',
      city: '上海市',
      district: '浦东新区',
    });
    expect(normalizePolicyRegion('广东省深圳市南山区')).toEqual({
      country: 'CN',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
    });
    expect(normalizePolicyRegion('四川省成都市武侯区')).toEqual({
      country: 'CN',
      province: '四川省',
      city: '成都市',
      district: '武侯区',
    });
    expect(normalizePolicyRegion('朝阳区')).toEqual({ country: 'CN' });
  });
  it('never matches a same-named district in another city or falls back to Beijing', () => {
    const enterprise = normalizePolicyRegion('广东省深圳市南山区');
    expect(
      sourceMatchesRegion(
        { level: 'national', region: { country: 'CN' } },
        enterprise,
      ),
    ).toBe(true);
    expect(
      sourceMatchesRegion(
        { level: 'city', region: { country: 'CN', city: '深圳市' } },
        enterprise,
      ),
    ).toBe(true);
    expect(
      sourceMatchesRegion(
        {
          level: 'district',
          region: { country: 'CN', city: '北京市', district: '南山区' },
        },
        enterprise,
      ),
    ).toBe(false);
    expect(
      sourceMatchesRegion(
        {
          level: 'district',
          region: { country: 'CN', city: '深圳市', district: '南山区' },
        },
        enterprise,
      ),
    ).toBe(true);
    expect(
      sourceMatchesRegion(
        { level: 'city', region: { country: 'CN', city: '北京市' } },
        enterprise,
      ),
    ).toBe(false);
  });
  it('preserves new multi-category labels rather than a five-value enum', () => {
    expect(
      policyCategories(['绿色低碳', '融资支持', '绿色低碳', '数据要素', '']),
    ).toEqual(['绿色低碳', '融资支持', '数据要素']);
  });
  it('evaluates required AND/OR groups instead of trusting the model headline', () => {
    const facts = { a: 'met', b: 'gap', c: 'unknown' } as const;
    expect(evaluatePolicyConclusion({ all: ['a', 'b'] }, facts)).toBe(
      'has_gaps',
    );
    expect(evaluatePolicyConclusion({ all: ['a', 'c'] }, facts)).toBe(
      'unknown',
    );
    expect(evaluatePolicyConclusion({ any: ['a', 'b'] }, facts)).toBe(
      'likely_eligible',
    );
    expect(evaluatePolicyConclusion({ all: [] }, facts)).toBe('unknown');
    expect(evaluatePolicyConclusion({ all: ['missing'] }, facts)).toBe(
      'unknown',
    );
  });
  it('does not turn missing dates into evergreen policies and honors precise deadlines', () => {
    const now = new Date('2026-09-03T10:00:00+08:00');
    expect(policyApplicationStatus({}, now)).toBe('unknown');
    expect(
      policyApplicationStatus({ deadline: '2026-09-03T09:00:00+08:00' }, now),
    ).toBe('closed');
    expect(
      policyApplicationStatus(
        { startsAt: '2026-09-05', deadline: '2026-09-10' },
        now,
      ),
    ).toBe('upcoming');
    expect(policyApplicationStatus({ deadline: '2026-09-03' }, now)).toBe(
      'open',
    );
    expect(policyApplicationStatus({ deadline: '2026-02-31' }, now)).toBe(
      'unknown',
    );
  });
  it('requires an actual quote and actual enterprise facts before trusting a met condition', () => {
    const evidence = {
      label: '营业收入达到门槛',
      quote: '营业收入不少于100万元',
      factKeys: ['annualRevenueCny'],
      result: 'met' as const,
    };
    expect(
      validatePolicyEvidence(evidence, '申报企业营业收入不少于100万元。', {})
        .result,
    ).toBe('unknown');
    expect(() =>
      validatePolicyEvidence(evidence, '完全不同的政策正文', {
        annualRevenueCny: 2000000,
      }),
    ).toThrow(/原文/);
    expect(
      validatePolicyEvidence(
        {
          ...evidence,
          comparison: {
            field: 'annualRevenueCny',
            operator: 'gte',
            value: 1000000,
          },
        },
        '营业收入不少于100万元',
        { annualRevenueCny: 500000 },
      ).result,
    ).toBe('gap');
  });
  it('treats empty and explicitly uncertain qualification lists as unknown facts', () => {
    const condition = {
      label: '资质',
      quote: '具备高新技术企业资质',
      factKeys: ['qualifications'],
      result: 'met' as const,
    };
    for (const qualifications of [[], ['不确定'], ['不知道']]) {
      expect(
        validatePolicyEvidence(condition, condition.quote, { qualifications })
          .result,
      ).toBe('unknown');
    }
  });
  it('keeps incomplete facts in evaluation without claiming qualification', () => {
    expect(policyRecommendationGroup('open', 'unknown', true)).toBe('evaluate');
    expect(policyRecommendationGroup('open', 'has_gaps', true)).toBe('all');
    expect(policyRecommendationGroup('closed', 'likely_eligible', true)).toBe(
      'all',
    );
    expect(policyRecommendationGroup('open', 'likely_eligible', false)).toBe(
      'all',
    );
  });
});
