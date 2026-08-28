/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type EnterpriseKnowledgeRetentionReason =
  | 'incubating'
  | 'transient'
  | 'contested'
  | 'long_term_recurrence'
  | 'cross_member_corroboration'
  | 'governed_decision'
  | 'high_impact_verified';

export interface EnterpriseKnowledgeObservationSignals {
  category: string;
  content: string;
  confidence: number;
  verified: boolean;
  clientImpactScore?: number;
  clientSignals?: string[];
}

export interface EnterpriseKnowledgeEvidenceSummary {
  evidenceCount: number;
  distinctSessionCount: number;
  distinctContributorCount: number;
  spanDays: number;
  averageConfidence: number;
  maximumImpactScore: number;
  hasVerifiedEvidence: boolean;
  /** 有本轮局部验证依据的证据数量；比单纯的“出现过验证”更适合校准可靠度。 */
  verifiedEvidenceCount?: number;
  /** 相似主题中互相冲突的证据条数；存在冲突时禁止自动晋升。 */
  contradictoryEvidenceCount?: number;
}

export interface EnterpriseKnowledgeRetentionDecision {
  promote: boolean;
  reason: EnterpriseKnowledgeRetentionReason;
  impactScore: number;
  reliabilityScore: number;
  reasons: string[];
}

const FINAL_DECISION = /(?:最终决定|正式采用|正式确定|拍板|统一规定|公司规定|制度要求|必须|禁止|不得|标准流程)/iu;
const VERIFIED_RESULT = /(?:已修复|已解决|验证通过|测试通过|验收通过|确认有效|已恢复|已上线|已经生效|fixed|resolved|verified|tests? passed)/iu;
const HIGH_IMPACT = /(?:重大|宕机|事故|数据丢失|安全|合规|法律|合同|客户投诉|金额|成本|收入|损失|生产环境|sla)/iu;
const SPECULATIVE = /(?:可能|也许|或许|猜测|不确定|暂时认为|尚未验证|待确认|maybe|perhaps|unverified)/iu;
const TRANSCRIPT_NOISE = /^(?:用户|助手|assistant|user|system)\s*[:：]/iu;
const CONVERSATION_DEPENDENT = /(?:本次对话|这次对话|本轮对话|上面的回复|以上回答|刚才说的|你刚才|我刚才|以下是.{0,8}总结|总结一下这次)/iu;
const TRANSIENT_STATE = /(?:今天|明天|后天|本周|本月|待会|稍后|临时(?:先|使用|处理|安排)|暂时(?:先|使用|处理|安排)|先这样|正在处理中|尚在进行|明天再决定)/iu;
const AFFIRMATIVE_STANCE = /(?:必须|需要|应当|应该|要求|允许|启用|采用|使用|保留|执行|上线)/iu;
const NEGATIVE_STANCE = /(?:无需|不需要|不得|禁止|不允许|不能|取消|停用|不再|废止|下线)/iu;

function cleanSegment(segment: string): string {
  return segment
    .replace(TRANSCRIPT_NOISE, '')
    .replace(/^\s*[#>*-]+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Convert a possible answer transcript into one reusable knowledge atom.
 * It intentionally preserves conclusions, conditions and validation while
 * dropping speaker turns, large code blocks and explanatory repetition.
 */
export function normalizeEnterpriseKnowledgeAtom(content: string): string {
  const withoutCode = String(content ?? '').replace(/```[\s\S]*?```/gu, ' [代码细节已省略] ');
  const segments = withoutCode
    .split(/\r?\n+|(?<=[。！？!?；;])/u)
    .map(cleanSegment)
    .filter((segment) => segment.length >= 8);
  const priorities = [FINAL_DECISION, /(?:根因|原因|问题在于|由于)/iu, /(?:解决|修复|改为|流程|方案)/iu, VERIFIED_RESULT, /(?:适用|前提|条件|仅当|除非)/iu];
  const selected: string[] = [];
  for (const priority of priorities) {
    const match = segments.find((segment) => priority.test(segment));
    if (match && !selected.includes(match)) selected.push(match);
    if (selected.length >= 3) break;
  }
  for (const segment of segments) {
    if (selected.length >= 3) break;
    if (!selected.includes(segment)) selected.push(segment);
  }
  return selected.join('\n').slice(0, 900).trim();
}

function tokenSet(value: string): Set<string> {
  const normalized = value
    .toLowerCase()
    .replace(/\bkey\b/gu, '键')
    .replace(/租户/gu, '企业')
    .replace(/增加|添加/gu, '加入')
    .replace(/根本原因|问题原因|根因|源于/gu, '原因')
    .replace(/未包含|没有包含|没有|缺少/gu, '缺失')
    .replace(/未隔离|串数据|数据串读|串读/gu, '隔离失败')
    .replace(/(?:隔离)?(?:回归)?(?:复测|测试|验证).{0,4}(?:通过|成功|确认)/gu, '验证成功')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const result = new Set<string>();
  for (const match of value.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,}/gu)) {
    result.add(match[0]);
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

/** Similarity for clustering paraphrased observations within one category. */
export function enterpriseKnowledgeObservationSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const jaccard = intersection / (a.size + b.size - intersection);
  const containment = intersection / Math.min(a.size, b.size);
  return (jaccard * 0.35) + (containment * 0.65);
}

export type EnterpriseKnowledgeEvidenceStance = 'affirmative' | 'negative' | 'neutral';

export function enterpriseKnowledgeEvidenceStance(
  content: string,
): EnterpriseKnowledgeEvidenceStance {
  // “不需要”“禁止使用”本身也包含“需要”“使用”等正向词，否定规则必须优先。
  if (NEGATIVE_STANCE.test(content)) return 'negative';
  return AFFIRMATIVE_STANCE.test(content) ? 'affirmative' : 'neutral';
}

function quantifiedClaims(content: string): Set<string> {
  return new Set(
    [...content.matchAll(/\d+(?:\.\d+)?\s*(?:%|元|万元|天|日|小时|分钟|人|次|个|GB|MB)?/giu)]
      .map((match) => match[0].replace(/\s+/gu, '').toLowerCase()),
  );
}

/**
 * 统计同主题证据中的冲突条目。相反的规范措辞，或同一高相似陈述中互斥的量化值，
 * 都会进入争议态；争议只能由管理员审核解决，不能靠票数自动覆盖少数证据。
 */
export function enterpriseKnowledgeContradictoryEvidenceIndexes(
  contents: readonly string[],
): Set<number> {
  const contradictory = new Set<number>();
  for (let leftIndex = 0; leftIndex < contents.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < contents.length; rightIndex += 1) {
      const left = contents[leftIndex];
      const right = contents[rightIndex];
      const similarity = enterpriseKnowledgeObservationSimilarity(left, right);
      if (similarity < 0.3) continue;
      const leftStance = enterpriseKnowledgeEvidenceStance(left);
      const rightStance = enterpriseKnowledgeEvidenceStance(right);
      const oppositeStance = leftStance !== 'neutral'
        && rightStance !== 'neutral'
        && leftStance !== rightStance;
      const leftClaims = quantifiedClaims(left);
      const rightClaims = quantifiedClaims(right);
      const differentQuantities = similarity >= 0.42
        && leftClaims.size > 0
        && rightClaims.size > 0
        && ![...leftClaims].some((claim) => rightClaims.has(claim));
      if (oppositeStance || differentQuantities) {
        contradictory.add(leftIndex);
        contradictory.add(rightIndex);
      }
    }
  }
  return contradictory;
}

export function enterpriseKnowledgeContradictoryEvidenceCount(
  contents: readonly string[],
): number {
  return enterpriseKnowledgeContradictoryEvidenceIndexes(contents).size;
}

function isTransientOrConversationDependent(content: string): boolean {
  if (CONVERSATION_DEPENDENT.test(content)) return true;
  return TRANSIENT_STATE.test(content) && !FINAL_DECISION.test(content);
}

export function scoreEnterpriseKnowledgeImpact(
  input: EnterpriseKnowledgeObservationSignals,
): { score: number; reasons: string[] } {
  const atom = normalizeEnterpriseKnowledgeAtom(input.content);
  const reasons: string[] = [];
  let score = 0.25 + Math.min(0.25, Math.max(0, input.confidence) * 0.25);
  if (FINAL_DECISION.test(atom)) {
    score += 0.25;
    reasons.push('明确制度或最终决策');
  }
  if (VERIFIED_RESULT.test(atom) || input.verified) {
    score += 0.2;
    reasons.push('存在已验证结果');
  }
  if (HIGH_IMPACT.test(atom)) {
    score += 0.2;
    reasons.push('涉及高影响业务');
  }
  if (SPECULATIVE.test(atom)) {
    score -= 0.35;
    reasons.push('包含未确认表述');
  }
  if (input.category === 'preference') {
    score = Math.min(score, 0.45);
    reasons.push('个人偏好不直接上升为企业事实');
  }
  const clientScore = Number.isFinite(input.clientImpactScore)
    ? Math.min(1, Math.max(0, input.clientImpactScore ?? 0))
    : 0;
  if (clientScore >= 0.8 && (input.clientSignals?.length ?? 0) > 0) {
    score += 0.05;
  }
  return { score: Math.min(1, Math.max(0, score)), reasons };
}

/**
 * 组织记忆可靠度不沿用某一次模型自报的置信度，而由证据量、独立会话、贡献者、
 * 局部验证和时间跨度共同决定。单人重复且没有验证时设置硬上限。
 */
export function scoreEnterpriseKnowledgeReliability(
  summary: EnterpriseKnowledgeEvidenceSummary,
): number {
  const verifiedEvidenceCount = summary.verifiedEvidenceCount
    ?? (summary.hasVerifiedEvidence ? 1 : 0);
  let score = 0.1
    + (Math.min(1, Math.max(0, summary.averageConfidence)) * 0.25)
    + (Math.min(1, summary.evidenceCount / 4) * 0.15)
    + (Math.min(1, summary.distinctSessionCount / 3) * 0.15)
    + (Math.min(1, summary.distinctContributorCount / 2) * 0.15)
    + (Math.min(1, verifiedEvidenceCount / 2) * 0.15)
    + (Math.min(1, Math.max(0, summary.spanDays) / 30) * 0.05);
  if (summary.distinctContributorCount < 2 && verifiedEvidenceCount < 2) {
    score = Math.min(score, 0.68);
  }
  if ((summary.contradictoryEvidenceCount ?? 0) > 0) {
    score = Math.min(score, 0.3);
  }
  return Math.min(1, Math.max(0, score));
}

export function decideEnterpriseKnowledgeRetention(
  current: EnterpriseKnowledgeObservationSignals,
  summary: EnterpriseKnowledgeEvidenceSummary,
): EnterpriseKnowledgeRetentionDecision {
  const impact = scoreEnterpriseKnowledgeImpact(current);
  const reliabilityScore = scoreEnterpriseKnowledgeReliability(summary);
  const verifiedEvidenceCount = summary.verifiedEvidenceCount
    ?? (summary.hasVerifiedEvidence ? 1 : 0);
  if ((summary.contradictoryEvidenceCount ?? 0) > 0) {
    return {
      promote: false,
      reason: 'contested',
      impactScore: impact.score,
      reliabilityScore,
      reasons: ['相似证据存在相互冲突，需人工裁决', ...impact.reasons],
    };
  }
  if (isTransientOrConversationDependent(current.content)) {
    return {
      promote: false,
      reason: 'transient',
      impactScore: impact.score,
      reliabilityScore,
      reasons: ['内容依赖当前对话或短期状态', ...impact.reasons],
    };
  }
  if (SPECULATIVE.test(current.content)) {
    return {
      promote: false,
      reason: 'incubating',
      impactScore: impact.score,
      reliabilityScore,
      reasons: ['结论仍含未确认或待验证表述', ...impact.reasons],
    };
  }
  const eligibleCategory = current.category === 'decision'
    || current.category === 'solution'
    || current.category === 'convention';
  const toolValidatedSolution = current.category === 'solution'
    && current.verified
    && verifiedEvidenceCount >= 2
    && VERIFIED_RESULT.test(current.content);
  const corroboratedOrganizationDecision = (
    current.category === 'decision' || current.category === 'convention'
  ) && FINAL_DECISION.test(current.content)
    && summary.distinctContributorCount >= 2;
  if (
    eligibleCategory
    && impact.score >= 0.82
    && current.confidence >= 0.82
    && summary.evidenceCount >= 2
    && summary.distinctSessionCount >= 2
    && (summary.distinctContributorCount >= 2 || summary.spanDays >= 1)
    && (toolValidatedSolution || corroboratedOrganizationDecision)
    && reliabilityScore >= (toolValidatedSolution ? 0.78 : 0.64)
  ) {
    return {
      promote: true,
      reason: toolValidatedSolution ? 'high_impact_verified' : 'governed_decision',
      impactScore: impact.score,
      reliabilityScore,
      reasons: impact.reasons,
    };
  }
  if (
    current.category !== 'preference'
    && (current.category !== 'research' || verifiedEvidenceCount >= 2)
    && summary.evidenceCount >= 3
    && summary.distinctSessionCount >= 3
    && summary.distinctContributorCount >= 2
    && summary.spanDays >= 7
    && summary.averageConfidence >= 0.72
    && reliabilityScore >= 0.72
  ) {
    return {
      promote: true,
      reason: 'long_term_recurrence',
      impactScore: Math.max(impact.score, summary.maximumImpactScore),
      reliabilityScore,
      reasons: ['跨时间反复出现', ...impact.reasons],
    };
  }
  if (
    current.category !== 'preference'
    && (current.category !== 'research' || verifiedEvidenceCount >= 2)
    && summary.evidenceCount >= 3
    && summary.distinctSessionCount >= 3
    && summary.distinctContributorCount >= 2
    && summary.averageConfidence >= 0.75
    && reliabilityScore >= 0.7
  ) {
    return {
      promote: true,
      reason: 'cross_member_corroboration',
      impactScore: Math.max(impact.score, summary.maximumImpactScore),
      reliabilityScore,
      reasons: ['多名员工独立印证', ...impact.reasons],
    };
  }
  return {
    promote: false,
    reason: 'incubating',
    impactScore: impact.score,
    reliabilityScore,
    reasons: impact.reasons,
  };
}

export interface EnterpriseKnowledgeSynthesisEvidence {
  content: string;
  confidence: number;
  verified: boolean;
  impactScore: number;
}

export interface EnterpriseKnowledgeSynthesisInput {
  category: string;
  department?: string | null;
  summary: EnterpriseKnowledgeEvidenceSummary;
  evidence: EnterpriseKnowledgeSynthesisEvidence[];
}

export interface EnterpriseKnowledgeSynthesisResult {
  title: string;
  content: string;
}

function evidenceCentrality(
  candidate: EnterpriseKnowledgeSynthesisEvidence,
  evidence: readonly EnterpriseKnowledgeSynthesisEvidence[],
): number {
  const support = evidence.length <= 1
    ? 1
    : evidence.reduce(
        (total, item) => total + enterpriseKnowledgeObservationSimilarity(
          candidate.content,
          item.content,
        ),
        0,
      ) / evidence.length;
  return support + (candidate.confidence * 0.2) + (candidate.verified ? 0.08 : 0)
    + (candidate.impactScore * 0.05);
}

function durableHeadline(content: string, fallback: string): string {
  const first = normalizeEnterpriseKnowledgeAtom(content)
    .split(/\r?\n/u)
    .map((line) => line.replace(/^(?:结论|长期结论|摘要)\s*[:：]?\s*/u, '').trim())
    .find(Boolean) || fallback;
  return first.replace(/[。；;：:]$/u, '').slice(0, 160);
}

/**
 * 把一组独立观察合成为可长期维护的组织知识卡片。正文明确区分结论、适用范围、
 * 形成依据和关键佐证，不再把某一次助手回答原样复制为企业记忆。
 */
export function synthesizeEnterpriseKnowledgeDocument(
  input: EnterpriseKnowledgeSynthesisInput,
): EnterpriseKnowledgeSynthesisResult {
  const evidence = input.evidence
    .map((item) => ({ ...item, content: normalizeEnterpriseKnowledgeAtom(item.content) }))
    .filter((item) => item.content.length >= 8);
  const representative = [...evidence].sort(
    (left, right) => evidenceCentrality(right, evidence) - evidenceCentrality(left, evidence),
  )[0];
  const headline = durableHeadline(representative?.content ?? '', input.category);
  const supporting = evidence
    .filter((item) => item !== representative)
    .map((item) => durableHeadline(item.content, ''))
    .filter((item, index, values) => item && values.indexOf(item) === index)
    .filter((item) => enterpriseKnowledgeObservationSimilarity(item, headline) < 0.9)
    .slice(0, 2);
  const summary = input.summary;
  const formation = [
    `${summary.evidenceCount} 条独立证据`,
    `${summary.distinctSessionCount} 个会话`,
    `${summary.distinctContributorCount} 名贡献者`,
    `观察跨度 ${Math.max(0, Math.round(summary.spanDays))} 天`,
    summary.hasVerifiedEvidence ? '包含已验证结果' : '尚无独立验证结果',
    `组织可靠度 ${Math.round(scoreEnterpriseKnowledgeReliability(summary) * 100)}%`,
  ].join('；');
  const sections = [
    `## 长期结论\n${headline}。`,
    `## 适用范围\n${input.department?.trim() || '全组织'}；分类：${input.category}`,
    `## 形成依据\n${formation}。`,
    ...(supporting.length > 0
      ? [`## 关键佐证\n${supporting.map((item) => `- ${item}。`).join('\n')}`]
      : []),
  ];
  return { title: headline, content: sections.join('\n\n').slice(0, 2_400) };
}

export function enterpriseKnowledgeRetentionReasonLabel(
  reason: EnterpriseKnowledgeRetentionReason,
): string {
  if (reason === 'high_impact_verified') return '高影响且已跨会话独立验证';
  if (reason === 'governed_decision') return '组织制度经跨成员确认';
  if (reason === 'long_term_recurrence') return '跨时间反复出现';
  if (reason === 'cross_member_corroboration') return '多名员工独立印证';
  if (reason === 'contested') return '证据存在冲突，需人工裁决';
  if (reason === 'transient') return '短期或对话依赖内容';
  return '证据积累中';
}
