/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  OfficialPolicyDocument,
  PolicyConclusion,
  PolicyEnterpriseProfile,
  PolicyExclusionResult,
  PolicyFactRule,
  PolicySupportEstimate,
} from './contracts.js';
import {
  corePolicyProfile,
  knownPolicyFact,
  policyHash,
} from './policyDomain.js';

export const POLICY_INTERPRETATION_VERSION = 3;
export const validFactKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(value) &&
  !['constructor', 'prototype', '__proto__'].includes(value);
export function policyQuote(raw: unknown, body: string): string {
  if (
    typeof raw !== 'string' ||
    raw.trim().length < 4 ||
    raw.length > 2000 ||
    !body.replace(/\s/gu, '').includes(raw.replace(/\s/gu, ''))
  )
    throw new Error('引用与原文不一致');
  return raw.trim();
}
function quotedNumber(value: number, quote: string): boolean {
  return [...quote.matchAll(/(\d+(?:\.\d+)?)\s*(万|亿|%|％)?/gu)].some(
    (match) =>
      Math.abs(
        Number(match[1]) *
          (match[2] === '万'
            ? 10000
            : match[2] === '亿'
              ? 100000000
              : /[%％]/u.test(match[2] ?? '')
                ? 0.01
                : 1) -
          value,
      ) < 1e-9,
  );
}
export function parseFactRule(
  raw: unknown,
  body: string,
  depth = 0,
  budget = { remaining: 120 },
): PolicyFactRule {
  if (
    depth > 12 ||
    --budget.remaining < 0 ||
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw)
  )
    throw new Error('排除条件结构无效');
  const item = raw as Record<string, unknown>;
  if ('all' in item || 'any' in item) {
    const key = 'all' in item ? 'all' : 'any';
    const children = item[key];
    if (
      Object.keys(item).length !== 1 ||
      !Array.isArray(children) ||
      !children.length ||
      children.length > 60
    )
      throw new Error('排除条件关系无效');
    return {
      [key]: children.map((child) =>
        parseFactRule(child, body, depth + 1, budget),
      ),
    } as PolicyFactRule;
  }
  if (
    !validFactKey(item.field) ||
    !['eq', 'gte', 'lte', 'contains'].includes(String(item.operator)) ||
    !['string', 'number', 'boolean'].includes(typeof item.value)
  )
    throw new Error('排除条件事实字段无效');
  const quote = policyQuote(item.quote, body);
  const value = item.value as string | number | boolean;
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || !quotedNumber(value, quote))
  )
    throw new Error('条件数值与原文不一致');
  if (
    typeof value === 'string' &&
    (!value.trim() ||
      value.length > 200 ||
      !quote.replace(/\s/gu, '').includes(value.replace(/\s/gu, '')))
  )
    throw new Error('条件取值未在原文核实');
  if (
    ['gte', 'lte'].includes(String(item.operator)) &&
    typeof value !== 'number'
  )
    throw new Error('比较值必须是数值');
  if (item.operator === 'contains' && typeof value !== 'string')
    throw new Error('包含条件必须是文本');
  return {
    field: item.field,
    operator: item.operator as 'eq' | 'gte' | 'lte' | 'contains',
    value,
    quote,
    ...(typeof item.question === 'string' && item.question.trim()
      ? { question: item.question.trim().slice(0, 400) }
      : {}),
  };
}
export function factRuleLeaves(
  rule: PolicyFactRule,
): Array<Extract<PolicyFactRule, { field: string }>> {
  return 'field' in rule
    ? [rule]
    : ('all' in rule ? rule.all : rule.any).flatMap(factRuleLeaves);
}
export function policyFactKeys(doc: OfficialPolicyDocument): string[] {
  return [
    ...new Set([
      ...doc.conditions.flatMap((c) => c.factKeys),
      ...(doc.exclusions ?? []).flatMap((e) =>
        [e.when, e.appliesWhen, e.unless].flatMap((r) =>
          r ? factRuleLeaves(r).map((l) => l.field) : [],
        ),
      ),
      ...(doc.supportEstimate?.kind === 'rate'
        ? [doc.supportEstimate.field]
        : []),
    ]),
  ];
}
export function policyQuestion(
  doc: OfficialPolicyDocument,
  field: string,
): { field: string; label: string; valueType: 'text' | 'number' | 'boolean' } {
  const exclusion = doc.exclusions?.find((e) =>
    [e.when, e.appliesWhen, e.unless].some(
      (r) => r && factRuleLeaves(r).some((leaf) => leaf.field === field),
    ),
  );
  const leaf =
    exclusion &&
    [exclusion.when, exclusion.appliesWhen, exclusion.unless]
      .flatMap((r) => (r ? factRuleLeaves(r) : []))
      .find((l) => l.field === field);
  const condition = doc.conditions.find((c) => c.factKeys.includes(field));
  return {
    field,
    label:
      leaf?.question ||
      (exclusion && factRuleLeaves(exclusion.when)[0]?.field === field
        ? exclusion.question
        : undefined) ||
      condition?.question ||
      (leaf
        ? `请核实“${exclusion!.label}”：${leaf.quote}。企业的 ${field} 是什么？布尔项请回答“是”或“否”，不清楚可选“不确定”。`
        : `请补充 ${condition?.label ?? field}；不清楚可选“不确定”。`),
    valueType: leaf
      ? typeof leaf.value === 'boolean'
        ? 'boolean'
        : typeof leaf.value === 'number'
          ? 'number'
          : 'text'
      : doc.conditions.some((c) => c.comparison?.field === field) ||
          (doc.supportEstimate?.kind === 'rate' &&
            doc.supportEstimate.field === field)
        ? 'number'
        : 'text',
  };
}
type Truth = true | false | undefined;
function evaluate(
  rule: PolicyFactRule,
  profile: PolicyEnterpriseProfile,
): { truth: Truth; missing: string[] } {
  if (!('field' in rule)) {
    const all = 'all' in rule;
    const children = (all ? rule.all : rule.any).map((r) =>
      evaluate(r, profile),
    );
    const decisive = children.some((c) => c.truth === !all);
    return {
      truth: decisive
        ? !all
        : children.every((c) => c.truth === all)
          ? all
          : undefined,
      missing: decisive ? [] : children.flatMap((c) => c.missing),
    };
  }
  const value = Object.hasOwn(profile, rule.field)
    ? profile[rule.field]
    : undefined;
  if (
    !knownPolicyFact(value) ||
    (rule.operator !== 'contains' && typeof value !== typeof rule.value) ||
    (rule.operator === 'contains' && !Array.isArray(value))
  )
    return { truth: undefined, missing: [rule.field] };
  return {
    truth:
      rule.operator === 'eq'
        ? value === rule.value
        : rule.operator === 'contains'
          ? (value as string[]).includes(String(rule.value))
          : rule.operator === 'gte'
            ? (value as number) >= (rule.value as number)
            : (value as number) <= (rule.value as number),
    missing: [],
  };
}
export function evaluateExclusions(
  doc: OfficialPolicyDocument,
  profile: PolicyEnterpriseProfile,
): PolicyExclusionResult[] {
  return (doc.exclusions ?? []).map((e) => {
    const applies = e.appliesWhen
      ? evaluate(e.appliesWhen, profile)
      : { truth: true, missing: [] };
    const trigger = evaluate(e.when, profile);
    const exception = e.unless
      ? evaluate(e.unless, profile)
      : { truth: false, missing: [] };
    const clear =
      applies.truth === false ||
      trigger.truth === false ||
      exception.truth === true;
    const hit =
      applies.truth === true &&
      trigger.truth === true &&
      exception.truth === false;
    return {
      id: e.id,
      label: e.label,
      quote: e.quote,
      result: clear ? 'clear' : hit ? 'hit' : 'unknown',
      missingFields:
        clear || hit
          ? []
          : [
              ...new Set([
                ...applies.missing,
                ...trigger.missing,
                ...exception.missing,
              ]),
            ],
      scopeConditionIds: e.scopeConditionIds,
    };
  });
}
export function policyModelProfile(
  doc: OfficialPolicyDocument,
  profile: PolicyEnterpriseProfile,
): PolicyEnterpriseProfile {
  const needed = new Set([
    ...Object.keys(corePolicyProfile(profile)),
    ...policyFactKeys(doc),
  ]);
  if ([...needed].some((key) => key.endsWith('Cny'))) needed.add('fiscalYear');
  return Object.fromEntries(
    Object.entries(profile).filter(
      ([key]) => validFactKey(key) && needed.has(key),
    ),
  );
}
export function policyRulesHash(doc: OfficialPolicyDocument): string {
  return policyHash([
    POLICY_INTERPRETATION_VERSION,
    doc.interpretationVersion,
    doc.conditions,
    doc.conditionTree,
    doc.exclusionsReviewed,
    doc.exclusions,
    doc.governance,
    doc.validFrom,
    doc.validUntil,
    doc.deadline,
    doc.startsAt,
    doc.evergreen,
    doc.supportEstimate,
  ]);
}
export function parseSupportEstimate(
  raw: unknown,
  body: string,
): PolicySupportEstimate | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('支持金额规则无效');
  const item = raw as Record<string, unknown>;
  const quote = policyQuote(item.quote, body);
  const money = (v: unknown): v is number =>
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= 0 &&
    v <= 1e12 &&
    quotedNumber(v, quote);
  if (
    item.kind === 'fixed' &&
    money(item.amountCny) &&
    !/最高|上限|不超过|至多|以内|[%％]|择优|视情况/u.test(quote)
  )
    return { kind: 'fixed', amountCny: item.amountCny, quote };
  if (
    item.kind === 'rate' &&
    validFactKey(item.field) &&
    typeof item.rate === 'number' &&
    item.rate > 0 &&
    item.rate <= 1 &&
    quotedNumber(item.rate, quote) &&
    (!/最高|上限|不超过|至多|以内/u.test(quote) || item.capCny !== undefined) &&
    !/分档|阶梯|择优|视情况/u.test(quote) &&
    (item.capCny === undefined || money(item.capCny))
  )
    return {
      kind: 'rate',
      field: item.field,
      rate: item.rate,
      capCny: item.capCny as number | undefined,
      quote,
    };
  throw new Error('支持金额或比例与原文不一致');
}
export function estimatePolicySupport(
  doc: OfficialPolicyDocument,
  profile: PolicyEnterpriseProfile,
  status: PolicyConclusion,
): { amountCny?: number; explanation: string; quote?: string } {
  const rule = doc.supportEstimate;
  if (!rule)
    return {
      explanation: '未提取到可确定计算的金额规则，请以原文及主管部门核定为准。',
    };
  if (status !== 'likely_eligible')
    return {
      explanation: '资格尚未核实，不估算可获得金额。',
      quote: rule.quote,
    };
  const basis = rule.kind === 'rate' ? profile[rule.field] : 0;
  if (
    typeof basis !== 'number' ||
    !Number.isFinite(basis) ||
    basis < 0 ||
    basis > 1e15
  )
    return {
      explanation: '缺少可核验的计费基数，暂不估算。',
      quote: rule.quote,
    };
  const amount =
    rule.kind === 'fixed'
      ? rule.amountCny
      : Math.min(basis * rule.rate, rule.capCny ?? Infinity);
  return {
    amountCny: Math.round(amount * 100) / 100,
    quote: rule.quote,
    explanation:
      rule.kind === 'fixed'
        ? '按原文定额估算，不代表获批或到账金额。'
        : `基数 ${basis} 元 × ${rule.rate * 100}%${rule.capCny === undefined ? '' : `，上限 ${rule.capCny} 元`}；不代表获批或到账金额。`,
  };
}
