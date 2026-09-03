/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { createHash } from 'node:crypto';
import type {
  PolicyRegion,
  PolicySource,
  PolicyConditionTree,
  PolicyResult,
  PolicyConclusion,
  PolicyCondition,
  PolicyStatus,
  PolicyEnterpriseProfile,
  PolicyGovernance,
} from './contracts.js';

const MUNICIPALITIES = ['北京', '上海', '天津', '重庆'];
export const POLICY_CORE_FIELDS = [
  'registeredRegion',
  'industry',
  'establishedAt',
  'enterpriseType',
  'mainBusiness',
  'qualifications',
] as const;
export const POLICY_FIELD_LABELS: Record<string, string> = {
  registeredRegion: '企业注册所在地（省／市／区县）',
  industry: '所属行业',
  establishedAt: '成立日期',
  enterpriseType: '登记类型',
  mainBusiness: '主营业务',
  qualifications: '已有资质（没有请填暂无）',
  employeeCount: '从业人数',
  annualRevenueCny: '年度营业收入（元）',
  rdExpenseCny: '年度研发费用（元）',
  fiscalYear: '数据所属年度',
};
export const DEFAULT_POLICY_CATEGORIES = [
  '资质认定',
  '人才支持',
  '项目补贴',
  '税收优惠',
  '政策活动',
  '融资支持',
  '就业社保',
  '知识产权',
  '绿色低碳',
  '数字化转型',
  '外贸发展',
];

function name(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[\p{Script=Han}A-Za-z·（）() -]{2,40}$/u.test(value.trim())
    ? value.trim()
    : undefined;
}
export function normalizePolicyRegion(value: unknown): PolicyRegion {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const region: PolicyRegion = { country: 'CN' };
    if (name(raw.province)) region.province = name(raw.province);
    if (name(raw.city)) region.city = name(raw.city);
    if (region.city && name(raw.district)) region.district = name(raw.district);
    const municipality = MUNICIPALITIES.find(
      (item) => region.province === `${item}市` || region.city === `${item}市`,
    );
    if (municipality) region.province = region.city = `${municipality}市`;
    return region;
  }
  if (typeof value !== 'string') return { country: 'CN' };
  const text = value.replace(/\s+/gu, '').replace(/^中国/u, '');
  const municipality = MUNICIPALITIES.find((item) => text.startsWith(item));
  if (municipality) {
    const district = text
      .slice(municipality.length)
      .replace(/^市/u, '')
      .match(/^([\p{Script=Han}]{1,15}?(?:区|县))/u)?.[1];
    return {
      country: 'CN',
      province: `${municipality}市`,
      city: `${municipality}市`,
      ...(district ? { district } : {}),
    };
  }
  const match = text.match(
    /^(.+?(?:省|自治区|特别行政区))(.+?(?:市|自治州|地区|盟))(?:(.+?(?:区|县|市|旗)))?/u,
  );
  if (match)
    return {
      country: 'CN',
      province: match[1],
      city: match[2],
      ...(match[3] ? { district: match[3] } : {}),
    };
  // A city name can scope city sources, but an ambiguous bare district must never select a source.
  const city = text.match(
    /^([\p{Script=Han}]{2,15}?市)([\p{Script=Han}]{1,15}?(?:区|县))?/u,
  );
  return city
    ? {
        country: 'CN',
        city: city[1],
        ...(city[2] ? { district: city[2] } : {}),
      }
    : { country: 'CN' };
}
export function sourceMatchesRegion(
  source: Pick<PolicySource, 'level' | 'region'>,
  enterprise: PolicyRegion,
): boolean {
  if (source.level === 'national') return true;
  const { region } = source;
  if (region.province && region.province !== enterprise.province) return false;
  if (source.level === 'province')
    return !!region.province && region.province === enterprise.province;
  if (!region.city || region.city !== enterprise.city) return false;
  return (
    source.level === 'city' ||
    (!!region.district && region.district === enterprise.district)
  );
}
export function policyCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(
          (item) =>
            item.length > 0 && item.length <= 30 && !/[<>\r\n]/u.test(item),
        ),
    ),
  ].slice(0, 8);
}
export function policyHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function policyProfileVersion(profile: PolicyEnterpriseProfile): string {
  return policyHash(
    Object.fromEntries(
      Object.entries(profile)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
export function evaluatePolicyConclusion(
  tree: PolicyConditionTree,
  results: Record<string, PolicyResult>,
  depth = 0,
): PolicyConclusion {
  if (depth > 12) return 'unknown';
  if (typeof tree === 'string')
    return results[tree] === 'met'
      ? 'likely_eligible'
      : results[tree] === 'gap'
        ? 'has_gaps'
        : 'unknown';
  const children = 'all' in tree ? tree.all : tree.any;
  if (!Array.isArray(children) || children.length === 0 || children.length > 60)
    return 'unknown';
  const values = children.map((child) =>
    evaluatePolicyConclusion(child, results, depth + 1),
  );
  return 'all' in tree
    ? values.includes('has_gaps')
      ? 'has_gaps'
      : values.every((item) => item === 'likely_eligible')
        ? 'likely_eligible'
        : 'unknown'
    : values.includes('likely_eligible')
      ? 'likely_eligible'
      : values.every((item) => item === 'has_gaps')
        ? 'has_gaps'
        : 'unknown';
}
export function policyDate(
  value: string | undefined,
  end = false,
): number | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const day = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== value
    )
      return undefined;
    return Date.parse(`${value}T${end ? '23:59:59.999' : '00:00:00'}+08:00`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
    return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}
export function policyValidityStatus(
  document: {
    validFrom?: string;
    validUntil?: string;
    governance?: PolicyGovernance;
  },
  now = new Date(),
):
  'valid' | 'unknown' | 'expired' | 'withdrawn' | 'conflict' | 'not_effective' {
  const governance = document.governance;
  if (governance?.status === 'conflict') return 'conflict';
  if (governance) {
    const effective = policyDate(governance.effectiveAt);
    if (governance.effectiveAt && effective === undefined) return 'unknown';
    if (effective === undefined || effective <= now.getTime())
      return 'withdrawn';
  }
  const start = policyDate(document.validFrom);
  const end = policyDate(document.validUntil, true);
  if (
    (document.validFrom && start === undefined) ||
    (document.validUntil && end === undefined) ||
    (start !== undefined && end !== undefined && start > end)
  )
    return 'unknown';
  if (end !== undefined && end < now.getTime()) return 'expired';
  if (start !== undefined && start > now.getTime()) return 'not_effective';
  return start !== undefined && end !== undefined ? 'valid' : 'unknown';
}
export function policyApplicationStatus(
  document: {
    deadline?: string;
    startsAt?: string;
    evergreen?: boolean;
    referenceOnly?: boolean;
    validFrom?: string;
    validUntil?: string;
    governance?: PolicyGovernance;
  },
  now = new Date(),
): PolicyStatus {
  const validity = policyValidityStatus(document, now);
  if (validity === 'withdrawn' || validity === 'expired') return validity;
  if (validity === 'conflict' || validity === 'not_effective') return 'unknown';
  if (document.referenceOnly) return 'reference';
  const end = policyDate(document.deadline, true);
  const start = policyDate(document.startsAt);
  if (
    (document.deadline && end === undefined) ||
    (document.startsAt && start === undefined) ||
    (start !== undefined && end !== undefined && start > end)
  )
    return 'unknown';
  if (end !== undefined && end < now.getTime()) return 'closed';
  if (start !== undefined && start > now.getTime()) return 'upcoming';
  if (document.evergreen === true) return 'evergreen';
  return end !== undefined ? 'open' : 'unknown';
}
const canonicalText = (text: string): string => text.replace(/\s+/gu, '');
export function validatePolicyComparisonDirection(
  operator: string,
  quote: string,
): void {
  const lowerBound = /不少于|不低于|至少|及以上|大于等于|≥/u.test(quote);
  const upperBound = /不超过|不高于|至多|及以下|小于等于|≤/u.test(quote);
  if (
    (lowerBound && !upperBound && operator !== 'gte') ||
    (upperBound && !lowerBound && operator !== 'lte')
  )
    throw new Error('数值比较方向与原文不一致');
}
export function knownPolicyFact(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string')
    return (
      !!value.trim() &&
      !/^(?:不确定|不知道|不清楚|暂不提供)$/u.test(value.trim())
    );
  if (Array.isArray(value))
    return (
      value.length > 0 &&
      value.every((item) => typeof item === 'string' && knownPolicyFact(item))
    );
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    typeof value === 'boolean' ||
    (typeof value === 'object' && Object.keys(value).length > 0)
  );
}
export function validatePolicyEvidence<
  T extends Omit<PolicyCondition, 'id'> & { result: PolicyResult },
>(
  condition: T,
  body: string,
  profile: PolicyEnterpriseProfile,
): T & { evidence: string } {
  if (
    !condition.quote ||
    condition.quote.length < 4 ||
    !canonicalText(body).includes(canonicalText(condition.quote))
  )
    throw new Error('政策判断缺少可核验的原文引用');
  const keys = condition.factKeys.filter((key) => Object.hasOwn(profile, key));
  const known =
    keys.length === condition.factKeys.length &&
    keys.length > 0 &&
    keys.every((key) => knownPolicyFact(profile[key]));
  let result: PolicyResult = known ? condition.result : 'unknown';
  if (condition.comparison) {
    const comparison = condition.comparison;
    validatePolicyComparisonDirection(comparison.operator, condition.quote);
    const raw = profile[comparison.field];
    const quotedNumbers = [
      ...condition.quote.matchAll(/(\d+(?:\.\d+)?)\s*(万|亿)?/gu),
    ].map(
      (match) =>
        Number(match[1]) *
        (match[2] === '万' ? 10000 : match[2] === '亿' ? 100000000 : 1),
    );
    if (!quotedNumbers.includes(comparison.value))
      throw new Error('条件数值与原文不一致');
    if (!known || typeof raw !== 'number' || !Number.isFinite(raw))
      result = 'unknown';
    else
      result = (
        comparison.operator === 'gte'
          ? raw >= comparison.value
          : comparison.operator === 'lte'
            ? raw <= comparison.value
            : raw === comparison.value
      )
        ? 'met'
        : 'gap';
  }
  return {
    ...condition,
    result,
    evidence: known
      ? keys
          .map(
            (key) =>
              `${POLICY_FIELD_LABELS[key] ?? key}：${JSON.stringify(profile[key])}`,
          )
          .join('；')
      : `待补充：${condition.factKeys.map((key) => POLICY_FIELD_LABELS[key] ?? key).join('、') || '企业事实'}`,
  };
}
export function policyRecommendationGroup(
  status: PolicyStatus,
  conclusion: PolicyConclusion,
  relevant: boolean,
): 'evaluate' | 'prepare' | 'all' {
  if (
    !relevant ||
    ['closed', 'unknown', 'reference', 'withdrawn', 'expired'].includes(
      status,
    ) ||
    ['has_gaps', 'unlikely'].includes(conclusion)
  )
    return 'all';
  return status === 'upcoming' && conclusion === 'likely_eligible'
    ? 'prepare'
    : 'evaluate';
}
export function corePolicyProfile(
  profile: PolicyEnterpriseProfile,
): PolicyEnterpriseProfile {
  return Object.fromEntries(
    Object.entries(profile).filter(([key]) =>
      [
        ...POLICY_CORE_FIELDS,
        'region',
        'organizationName',
        'employeeCount',
      ].includes(key),
    ),
  );
}
export function missingPolicyProfileFields(
  profile: PolicyEnterpriseProfile,
): string[] {
  return POLICY_CORE_FIELDS.filter((key) =>
    key === 'registeredRegion'
      ? !normalizePolicyRegion(profile.region ?? profile.registeredRegion).city
      : !profile[key] ||
        (Array.isArray(profile[key]) &&
          (profile[key] as unknown[]).length === 0),
  );
}
