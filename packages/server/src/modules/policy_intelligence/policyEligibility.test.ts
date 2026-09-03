import { describe, expect, it } from 'vitest';
import {
  evaluateExclusions,
  policyModelProfile,
  policyRulesHash,
  estimatePolicySupport,
  parseFactRule,
  parseSupportEstimate,
} from './policyEligibility.js';
import {
  policyApplicationStatus,
  policyRecommendationGroup,
  policyValidityStatus,
} from './policyDomain.js';
import type { OfficialPolicyDocument, PolicyExclusion } from './contracts.js';

const quote =
  '失信企业不予支持，已完成信用修复的除外。补助为投入的20%，最高10万元。';
const rule: PolicyExclusion = {
  id: 'credit',
  label: '信用要求',
  quote,
  when: { field: 'creditBlacklisted', operator: 'eq', value: true, quote },
  unless: { field: 'creditRepaired', operator: 'eq', value: true, quote },
};
const doc = {
  conditions: [],
  conditionTree: { all: [] },
  bodyText: quote,
  exclusions: [rule],
  exclusionsReviewed: true,
  contentHash: 'body',
  interpretationVersion: 3,
} as unknown as OfficialPolicyDocument;

describe('policy evidence-first v1.3 rules', () => {
  it('does not reject when the exception is unknown; false is a known fact', () => {
    expect(
      evaluateExclusions(doc, { creditBlacklisted: true })[0],
    ).toMatchObject({ result: 'unknown', missingFields: ['creditRepaired'] });
    expect(
      evaluateExclusions(doc, {
        creditBlacklisted: true,
        creditRepaired: false,
      })[0].result,
    ).toBe('hit');
    expect(
      evaluateExclusions(doc, {
        creditBlacklisted: true,
        creditRepaired: true,
      })[0].result,
    ).toBe('clear');
    expect(
      evaluateExclusions(doc, { creditBlacklisted: false })[0].result,
    ).toBe('clear');
  });
  it('honors applicability, scoped branches, nested AND/OR and unknown facts', () => {
    const scoped = {
      ...doc,
      exclusions: [
        {
          ...rule,
          scopeConditionIds: ['equipment'],
          appliesWhen: {
            any: [
              {
                field: 'equipmentType',
                operator: 'eq' as const,
                value: '淘汰类',
                quote,
              },
              {
                field: 'outdated',
                operator: 'eq' as const,
                value: true,
                quote,
              },
            ],
          },
        },
      ],
    };
    expect(
      evaluateExclusions(scoped, { equipmentType: '新型', outdated: false })[0]
        .result,
    ).toBe('clear');
    expect(
      evaluateExclusions(scoped, {
        creditBlacklisted: true,
        creditRepaired: false,
      })[0].result,
    ).toBe('unknown');
    expect(
      evaluateExclusions(scoped, {
        outdated: true,
        creditBlacklisted: true,
        creditRepaired: false,
      })[0],
    ).toMatchObject({ result: 'hit', scopeConditionIds: ['equipment'] });
  });
  it('rejects fabricated evidence, unsafe fields, unquoted numbers and huge rule trees', () => {
    const parse = (value: unknown) => parseFactRule(value, quote);
    expect(() =>
      parse({ field: '__proto__', operator: 'eq', value: true, quote }),
    ).toThrow();
    expect(() =>
      parse({ field: 'revenue', operator: 'gte', value: 999, quote }),
    ).toThrow();
    expect(() =>
      parse({
        field: 'revenue',
        operator: 'gte',
        value: 100000,
        quote: '虚构原文引用',
      }),
    ).toThrow();
    expect(() => parse({ any: Array(61).fill(rule.when) })).toThrow();
    let nested: unknown = rule.when;
    for (let i = 0; i < 15; i++) nested = { all: [nested] };
    expect(() => parse(nested)).toThrow();
  });
  it('minimizes model inputs and invalidates cached judgments when rules change', () => {
    expect(
      policyModelProfile(doc, {
        mainBusiness: '软件',
        notes: '内部秘密',
        annualRevenueCny: 1,
        creditBlacklisted: false,
      }),
    ).toEqual({ mainBusiness: '软件', creditBlacklisted: false });
    expect(policyRulesHash(doc)).not.toBe(
      policyRulesHash({ ...doc, exclusions: [] }),
    );
  });
  it('separates legal validity from the application window; missing dates are not valid forever', () => {
    const now = new Date('2026-09-03T00:00:00Z');
    expect(policyValidityStatus({}, now)).toBe('unknown');
    expect(policyApplicationStatus({ deadline: '2026-10-01' }, now)).toBe(
      'open',
    );
    expect(
      policyApplicationStatus(
        { deadline: '2026-10-01', validUntil: '2026-09-02' },
        now,
      ),
    ).toBe('expired');
    expect(
      policyApplicationStatus(
        {
          deadline: '2026-10-01',
          governance: {
            status: 'revoked',
            quote,
            referenceUrl: 'https://www.gov.cn/p',
          },
        },
        now,
      ),
    ).toBe('withdrawn');
    expect(
      policyApplicationStatus(
        {
          deadline: '2026-10-01',
          governance: {
            status: 'revoked',
            quote,
            referenceUrl: 'https://www.gov.cn/p',
            effectiveAt: '2026-09-10',
          },
        },
        now,
      ),
    ).toBe('open');
    expect(policyRecommendationGroup('open', 'has_gaps', true)).toBe('all');
    expect(policyRecommendationGroup('upcoming', 'likely_eligible', true)).toBe(
      'prepare',
    );
    expect(policyRecommendationGroup('upcoming', 'unknown', true)).toBe(
      'evaluate',
    );
  });
  it('computes quoted capped support only with known inputs and eligible conditions', () => {
    expect(() =>
      parseSupportEstimate({ kind: 'fixed', amountCny: 100000, quote }, quote),
    ).toThrow();
    expect(() =>
      parseSupportEstimate(
        { kind: 'rate', field: 'investment', rate: 0.2, quote },
        quote,
      ),
    ).toThrow();
    const support = {
      ...doc,
      supportEstimate: {
        kind: 'rate' as const,
        field: 'eligibleInvestmentCny',
        rate: 0.2,
        capCny: 100000,
        quote,
      },
    };
    expect(
      estimatePolicySupport(
        support,
        { eligibleInvestmentCny: 800000 },
        'likely_eligible',
      ),
    ).toMatchObject({ amountCny: 100000 });
    expect(
      estimatePolicySupport(support, {}, 'likely_eligible').amountCny,
    ).toBeUndefined();
    expect(
      estimatePolicySupport(
        support,
        { eligibleInvestmentCny: 800000 },
        'unknown',
      ).amountCny,
    ).toBeUndefined();
    expect(
      estimatePolicySupport(
        support,
        { eligibleInvestmentCny: -1 },
        'likely_eligible',
      ).amountCny,
    ).toBeUndefined();
  });
});
