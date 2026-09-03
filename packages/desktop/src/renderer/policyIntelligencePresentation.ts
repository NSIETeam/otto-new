/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  OfficialPolicyDocument,
  PolicyIntelligenceState,
  PolicyFactValue,
} from 'otto-server';
export const POLICY_LEVEL_LABELS: Record<string, string> = {
  national: '国家级',
  province: '省级',
  city: '市级',
  district: '区县级',
};
export const POLICY_STATUS_LABELS: Record<string, string> = {
  open: '申报中',
  upcoming: '即将开始',
  closed: '已截止',
  evergreen: '常年受理',
  reference: '参考政策',
  unknown: '时间待核验',
  withdrawn: '已废止／被替代',
  expired: '文件已失效',
};
export const POLICY_CONCLUSION_LABELS = {
  likely_eligible: '已有资料支持',
  has_gaps: '本批次有不满足条件',
  unlikely: '本批次命中排除',
  unknown: '待补充／待核实',
};
// Browser-safe date logic; the parity regression checks the server implementation.
// Do not import policyDomain at runtime: it also depends on node:crypto.
function policyDisplayDate(value?: string, end = false): number {
  if (!value) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const day = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== value
    )
      return NaN;
    return Date.parse(`${value}T${end ? '23:59:59.999' : '00:00:00'}+08:00`);
  }
  return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    ? Date.parse(value)
    : NaN;
}
function displayValidityState(
  doc: OfficialPolicyDocument,
  now: number,
): string {
  if (doc.governance?.status === 'conflict') return 'conflict';
  if (doc.governance) {
    const effective = policyDisplayDate(doc.governance.effectiveAt);
    if (doc.governance.effectiveAt && !Number.isFinite(effective))
      return 'unknown';
    if (!doc.governance.effectiveAt || effective <= now) return 'withdrawn';
  }
  const start = policyDisplayDate(doc.validFrom);
  const end = policyDisplayDate(doc.validUntil, true);
  if (
    (doc.validFrom && !Number.isFinite(start)) ||
    (doc.validUntil && !Number.isFinite(end)) ||
    start > end
  )
    return 'unknown';
  if (end < now) return 'expired';
  if (start > now) return 'not_effective';
  return Number.isFinite(start) && Number.isFinite(end) ? 'valid' : 'unknown';
}
export function policyDisplayValidity(
  doc: OfficialPolicyDocument,
  now = Date.now(),
): string {
  const validity = displayValidityState(doc, now);
  if (validity === 'conflict') return '来源关系存在冲突，待复核';
  if (validity === 'withdrawn') return '已废止／被替代';
  if (validity === 'expired') return '文件已失效';
  if (validity === 'not_effective') return '文件尚未生效';
  if (
    doc.governance?.effectiveAt &&
    policyDisplayDate(doc.governance.effectiveAt) > now
  )
    return `已公告效力变更，${doc.governance.effectiveAt} 生效`;
  return validity === 'valid'
    ? `明示有效期 ${doc.validFrom} 至 ${doc.validUntil}`
    : '文件效力待核验（未明确完整有效期）';
}
export function emptyPolicyState(): PolicyIntelligenceState {
  return {
    enabled: false,
    profile: {},
    policies: [],
    assessments: [],
    diagnoses: [],
    materials: {},
    canManage: false,
    region: { country: 'CN' },
    coverage: [],
    categories: [],
    missingProfileFields: [],
    syncStatus: 'idle',
    modelName: '',
    usedAnalysesToday: 0,
    dailyAnalysisLimit: 24,
  };
}
export function policyDisplayStatus(
  doc: OfficialPolicyDocument,
  now = Date.now(),
): string {
  const validity = displayValidityState(doc, now);
  if (validity === 'withdrawn' || validity === 'expired') return validity;
  if (validity === 'conflict' || validity === 'not_effective') return 'unknown';
  if (doc.referenceOnly) return 'reference';
  const end = policyDisplayDate(doc.deadline, true);
  const start = policyDisplayDate(doc.startsAt);
  if (
    (doc.deadline && !Number.isFinite(end)) ||
    (doc.startsAt && !Number.isFinite(start)) ||
    start > end
  )
    return 'unknown';
  if (end < now) return 'closed';
  if (start > now) return 'upcoming';
  if (doc.evergreen) return 'evergreen';
  return Number.isFinite(end) ? 'open' : 'unknown';
}
export function parsePolicyAnswer(
  field: string,
  text: string,
  valueType?: 'number' | 'text' | 'boolean',
): PolicyFactValue {
  const value = text.trim();
  if (/^(?:不确定|不知道|不清楚|暂不提供)$/u.test(value)) return null;
  if (valueType === 'boolean') {
    if (/^(?:是|有|已完成|是的|true)$/iu.test(value)) return true;
    if (/^(?:否|没有|不是|未完成|false)$/iu.test(value)) return false;
    throw new Error(
      '请明确回答“是”或“否”；不清楚可选“不确定”，不会据此认定不符合。',
    );
  }
  if (
    valueType === 'number' ||
    [
      'annualRevenueCny',
      'rdExpenseCny',
      'employeeCount',
      'fiscalYear',
    ].includes(field)
  ) {
    const match = value
      .replace(/[，,\s]/gu, '')
      .match(/^(\d+(?:\.\d+)?)(万|亿)?(?:元|人|年)?$/u);
    if (!match)
      throw new Error('请填写明确的数值，金额可用万元；不清楚可选“不确定”。');
    const number =
      Number(match[1]) *
      (match[2] === '万' ? 10000 : match[2] === '亿' ? 100000000 : 1);
    if (!Number.isFinite(number) || number > 1e15)
      throw new Error('数值超过支持范围，请核对金额单位。');
    return number;
  }
  if (['qualifications', 'productsServices', 'capabilities'].includes(field))
    return value.split(/[、，,]/u).filter(Boolean);
  if (!value || value.length > 2000)
    throw new Error('请填写本题信息，或选择“不确定”。');
  return value;
}
