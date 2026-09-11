import { describe, expect, it } from 'vitest';
import {
  parsePolicyAnswer,
  policyErrorMessage,
  policyDisplayStatus,
  policyDisplayValidity,
} from './policyIntelligencePresentation.js';
import { policyApplicationStatus } from 'otto-server';
import type { OfficialPolicyDocument } from 'otto-server';

describe('扩展政策条件的补充回答', () => {
  it('keeps public-policy access and saved data visible when networking or the model is unavailable', () => {
    expect(policyErrorMessage(new Error('fetch failed'))).toContain('已有资料不会因此删除');
    expect(policyErrorMessage('分析模型未配置')).toContain('公共政策仍可浏览');
    expect(policyErrorMessage('分析模型未配置')).toContain('正常对话');
  });
  it('explains connection failures without exposing IPC or credentials', () => {
    expect(policyErrorMessage("Error invoking remote method 'policy-intelligence:action': Error: 服务器返回 502")).toContain('先核对状态');
    expect(policyErrorMessage('等待超时')).toContain('不要重复提交');
    expect(policyErrorMessage('请同意保存企业资料')).toBe('请同意保存企业资料');
    expect(policyErrorMessage('失败 Bearer SECRET https://private.example')).not.toMatch(/SECRET|private.example/);
  });
  it('keeps desktop and server time classification consistent for invalid windows and future governance', () => {
    const now = new Date('2026-09-03T12:00:00+08:00');
    const cases: Array<Partial<OfficialPolicyDocument>> = [
      { startsAt: '2026-10-10', deadline: '2026-10-01' },
      { startsAt: 'invalid', deadline: '2026-10-01' },
      { deadline: '2026-02-30' },
      {
        validFrom: '2026-10-10',
        validUntil: '2026-09-01',
        deadline: '2026-10-01',
      },
      {
        governance: {
          status: 'revoked',
          effectiveAt: '2026-10-01',
          quote: '',
          referenceUrl: '',
        },
        validUntil: '2026-09-01',
        deadline: '2026-10-01',
      },
      { deadline: '2026-09-03' },
    ];
    for (const value of cases)
      expect(
        policyDisplayStatus(value as OfficialPolicyDocument, now.getTime()),
      ).toBe(policyApplicationStatus(value, now));
    expect(
      policyDisplayValidity(cases[3] as OfficialPolicyDocument, now.getTime()),
    ).toContain('待核验');
    expect(
      policyDisplayStatus(
        { deadline: '2026-09-03' } as OfficialPolicyDocument,
        Date.parse('2026-09-03T23:59:59.500+08:00'),
      ),
    ).toBe('open');
  });
  it('keeps unknown separate from false when checking exclusions', () => {
    expect(parsePolicyAnswer('blacklisted', '否', 'boolean')).toBe(false);
    expect(parsePolicyAnswer('repaired', '是', 'boolean')).toBe(true);
    expect(parsePolicyAnswer('repaired', '不确定', 'boolean')).toBeNull();
    expect(() => parsePolicyAnswer('repaired', '应该吧', 'boolean')).toThrow();
  });
  it('supports numeric facts introduced by new policy categories', () => {
    expect(parsePolicyAnswer('exportRevenueCny', '125万元', 'number')).toBe(
      1250000,
    );
    expect(parsePolicyAnswer('patentCount', '3', 'number')).toBe(3);
    expect(
      parsePolicyAnswer('exportRevenueCny', '不确定', 'number'),
    ).toBeNull();
    expect(() =>
      parsePolicyAnswer('patentCount', '可能有几项', 'number'),
    ).toThrow();
  });
  it('does not guess that identifiers are numeric unless the condition specifies it', () => {
    expect(parsePolicyAnswer('projectCode', '000123')).toBe('000123');
  });
});
