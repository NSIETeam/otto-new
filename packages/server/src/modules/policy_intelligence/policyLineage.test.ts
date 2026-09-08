import { describe, expect, it } from 'vitest';
import { annotatePolicyBatches } from './policyLineage.js';
import type { OfficialPolicyDocument } from './contracts.js';
const doc = (
  id: string,
  year: string,
  references: Array<{ label: string; url: string }> = [],
): OfficialPolicyDocument =>
  ({
    id,
    title: `${year}年度创新企业第一批申报通知`,
    url: `https://www.gov.cn/${id}`,
    sourceId: 's',
    region: { country: 'CN' },
    level: 'national',
    sourceStatus: 'verified',
    references,
  }) as OfficialPolicyDocument;
describe('evidence-based policy batch lineage', () => {
  it('links different years only through explicit original-page references, not similar titles', () => {
    const parent = {
      label: '创新企业支持管理办法',
      url: 'https://www.gov.cn/parent',
    };
    const result = annotatePolicyBatches([
      doc('a', '2026', [parent]),
      doc('b', '2025', [parent]),
      doc('unrelated', '2024'),
    ]);
    expect(result[0].batch?.year).toBe('2026');
    expect(result[0].relatedBatches?.map((r) => r.policyId)).toEqual(['b']);
    expect(result[0].relatedBatches?.[0].evidenceUrl).toBe(parent.url);
    expect(result[2].relatedBatches).toEqual([]);
  });
  it('does not correlate tenants in different regions or expose arbitrary URLs', () => {
    const source = doc('a', '2026', [
      { label: '旧年通知', url: 'https://evil.test/x' },
    ]);
    const other = {
      ...doc('b', '2025', source.references),
      region: { country: 'CN' as const, province: '四川省' },
      level: 'province' as const,
    };
    expect(annotatePolicyBatches([source, other])[0].relatedBatches).toEqual(
      [],
    );
  });
});
