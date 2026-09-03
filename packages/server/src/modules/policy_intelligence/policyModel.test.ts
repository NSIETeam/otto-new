import { describe, expect, it } from 'vitest';
import { parsePolicyExtraction } from './policyModel.js';
import type { OfficialPolicyDocument } from './contracts.js';
const document = {
  bodyText: '申报截至2026年10月1日。营业收入不少于100万元。材料：收入证明。',
  url: 'https://www.gov.cn/p1',
  attachments: [],
} as unknown as OfficialPolicyDocument;
const raw = {
  summary: '企业项目申报',
  supportText: '按规定支持',
  categories: ['绿色金融'],
  deadline: '2026-10-01',
  deadlineQuote: '申报截至2026年10月1日',
  conditions: [
    {
      id: 'revenue',
      label: '收入',
      quote: '营业收入不少于100万元',
      factKeys: ['annualRevenueCny'],
      comparison: {
        field: 'annualRevenueCny',
        operator: 'gte',
        value: 1000000,
      },
    },
  ],
  conditionTree: { all: ['revenue'] },
  materials: [{ id: 'proof', label: '收入证明', quote: '材料：收入证明' }],
  resources: [],
  exclusionsReviewed: true,
  exclusions: [],
};
describe('policy structured extraction', () => {
  it('does not confuse legal validity with a year-round application window or invert a threshold', () => {
    const source = {
      ...document,
      bodyText: document.bodyText + '本办法长期有效。',
    };
    expect(() =>
      parsePolicyExtraction(
        { ...raw, evergreen: true, evergreenQuote: '本办法长期有效' },
        source,
      ),
    ).toThrow();
    expect(() =>
      parsePolicyExtraction(
        {
          ...raw,
          conditions: [
            {
              ...raw.conditions[0],
              comparison: {
                field: 'annualRevenueCny',
                operator: 'lte',
                value: 1000000,
              },
            },
          ],
        },
        document,
      ),
    ).toThrow();
  });
  it('requires a complete negative-clause review and validates scoped exceptions', () => {
    const quote = '失信企业不予支持，完成修复的除外。';
    const source = { ...document, bodyText: document.bodyText + quote };
    const exclusion = {
      id: 'credit',
      label: '信用',
      quote,
      when: { field: 'blacklisted', operator: 'eq', value: true, quote },
      unless: { field: 'repaired', operator: 'eq', value: true, quote },
      scopeConditionIds: ['revenue'],
    };
    expect(
      parsePolicyExtraction({ ...raw, exclusions: [exclusion] }, source),
    ).toMatchObject({ interpretationVersion: 3, exclusions: [exclusion] });
    expect(() =>
      parsePolicyExtraction({ ...raw, exclusionsReviewed: undefined }, source),
    ).toThrow(/排除/);
    expect(() =>
      parsePolicyExtraction(
        {
          ...raw,
          exclusions: [{ ...exclusion, scopeConditionIds: ['other'] }],
        },
        source,
      ),
    ).toThrow();
  });
  it('requires quoted governance status, exact dates and verified reference links', () => {
    const quote = '本文件自2026年9月1日起废止。';
    const source = { ...document, bodyText: document.bodyText + quote };
    const governance = {
      status: 'revoked',
      quote,
      referenceUrl: document.url,
      effectiveAt: '2026-09-01',
      effectiveAtQuote: quote,
    };
    expect(() =>
      parsePolicyExtraction(
        { ...raw, governance: { ...governance, quote: '其他文件予以废止' } },
        { ...source, bodyText: source.bodyText + '其他文件予以废止' },
      ),
    ).toThrow();
    expect(() =>
      parsePolicyExtraction(
        { ...raw, governance: { ...governance, effectiveAt: undefined } },
        source,
      ),
    ).toThrow();
    expect(
      parsePolicyExtraction({ ...raw, governance }, source).governance,
    ).toMatchObject({ status: 'revoked', effectiveAt: '2026-09-01' });
    expect(() =>
      parsePolicyExtraction(
        {
          ...raw,
          governance: {
            ...governance,
            referenceUrl: 'https://evil.example/fake',
          },
        },
        source,
      ),
    ).toThrow();
    expect(() =>
      parsePolicyExtraction(
        { ...raw, governance: { ...governance, effectiveAt: '2026-08-01' } },
        source,
      ),
    ).toThrow();
    expect(() =>
      parsePolicyExtraction(
        { ...raw, validUntil: '2026-12-31', validUntilQuote: quote },
        source,
      ),
    ).toThrow();
  });
  it('accepts extensible types with quoted conditions and dates', () => {
    expect(parsePolicyExtraction(raw, document)).toMatchObject({
      categories: ['绿色金融'],
      deadline: '2026-10-01',
      interpretationStatus: 'ready',
    });
  });
  it('rejects missing conditions, fabricated references and invented dates', () => {
    expect(() =>
      parsePolicyExtraction(
        { ...raw, conditionTree: { all: ['fake'] } },
        document,
      ),
    ).toThrow();
    expect(() =>
      parsePolicyExtraction({ ...raw, deadline: '2027-10-01' }, document),
    ).toThrow();
    expect(() =>
      parsePolicyExtraction(
        {
          ...raw,
          resources: [
            { label: '联系人', url: 'https://evil.com', quote: '我编造的' },
          ],
        },
        document,
      ),
    ).toThrow();
  });
});
