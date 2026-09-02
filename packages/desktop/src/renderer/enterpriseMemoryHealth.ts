/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

export type EnterpriseMemoryHealthStatus =
  | 'trusted'
  | 'learning'
  | 'needs_review'
  | 'conflicted'
  | 'expired';

export interface EnterpriseMemoryHealthItem {
  id: string;
  title?: string;
  category: string;
  content: string;
  confidence: number;
  status?: 'pending_review' | 'active' | 'archived';
  sourceType?: string;
  sourceLabel?: string | null;
  evidenceCount?: number;
  distinctSessionCount?: number;
  distinctContributorCount?: number;
  verifiedEvidenceCount?: number;
  reviewDueAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface EnterpriseMemoryHealthNode {
  id: string;
  title: string;
  category: string;
  status: EnterpriseMemoryHealthStatus;
  confidence: number;
  reasons: string[];
  question: string;
  actionLabel: string;
  usageScenarios: string[];
  useStatus: string;
  priority: number;
}

export interface EnterpriseMemoryHealthResult {
  governanceScore: number;
  counts: Record<EnterpriseMemoryHealthStatus, number>;
  nodes: EnterpriseMemoryHealthNode[];
  nextAction: EnterpriseMemoryHealthNode | null;
}

function dateReached(value: string | null | undefined, now: number): boolean {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp <= now;
}

function memoryName(item: Pick<EnterpriseMemoryHealthItem, 'title' | 'category'>): string {
  return (item.title || item.category || '这条企业记忆').trim();
}

export function enterpriseMemoryUsageScenarios(
  item: Pick<EnterpriseMemoryHealthItem, 'title' | 'category'>,
): string[] {
  const text = `${item.title || ''} ${item.category || ''}`;
  if (/(?:制度|审批|合同|合规|权限|财务|法务)/u.test(text)) {
    return ['回答制度与审批问题', '执行相关工作前检查约束'];
  }
  if (/(?:流程|交付|验收|操作|项目|复盘|实施)/u.test(text)) {
    return ['规划同类任务步骤', '生成检查清单和复盘'];
  }
  if (/(?:偏好|写作|格式|品牌|表达|文案)/u.test(text)) {
    return ['生成企业文案与文件', '保持表达和格式一致'];
  }
  if (/(?:客户|销售|报价|市场|产品)/u.test(text)) {
    return ['理解客户和产品背景', '准备方案、报价与沟通材料'];
  }
  if (/(?:技术|研发|代码|架构|运维|安全)/u.test(text)) {
    return ['规划技术任务和排查问题', '执行前检查企业技术约束'];
  }
  return ['回答相关企业问题', '执行相关任务时补充组织上下文'];
}

function learningReasons(item: EnterpriseMemoryHealthItem): string[] {
  const reasons: string[] = [];
  if ((item.distinctSessionCount ?? 0) < 2) reasons.push('缺少第二个独立会话验证');
  if ((item.distinctContributorCount ?? 0) < 2) reasons.push('缺少另一名贡献者确认');
  if ((item.verifiedEvidenceCount ?? 0) < 1) reasons.push('还没有明确验证证据');
  if (item.confidence < 0.75) reasons.push('当前可信度仍偏低');
  return reasons.length ? reasons : ['仍需在后续真实工作中继续验证'];
}

function classify(
  item: EnterpriseMemoryHealthItem,
  now: number,
): EnterpriseMemoryHealthNode {
  const title = memoryName(item);
  const conflicted = Boolean(item.sourceLabel?.includes('证据存在冲突'));
  const expired = dateReached(item.expiresAt, now);
  const reviewDue = !expired && dateReached(item.reviewDueAt, now);
  const pending = item.status === 'pending_review';
  const trustedByEvidence = (item.verifiedEvidenceCount ?? 0) > 0
    || ((item.distinctSessionCount ?? 0) >= 2 && (item.distinctContributorCount ?? 0) >= 2);
  const trustedByAdmin = item.sourceType === 'manual' && item.confidence >= 0.8;
  const trusted = item.status !== 'archived' && item.confidence >= 0.8
    && (trustedByEvidence || trustedByAdmin);

  let status: EnterpriseMemoryHealthStatus;
  let reasons: string[];
  let question: string;
  let actionLabel: string;
  let priority: number;
  if (conflicted) {
    status = 'conflicted';
    reasons = ['支持与反对证据同时存在', '冲突裁决完成前不会自动发布'];
    question = `“${title}”存在冲突：当前应以哪一条正式制度、验证结果或负责人确认为准？`;
    actionLabel = '去裁决';
    priority = 100;
  } else if (expired) {
    status = 'expired';
    reasons = ['知识有效期已经结束', 'Otto 不应继续把它作为当前事实使用'];
    question = `“${title}”现在仍然有效吗？如有效，请提供最新依据并重新设置有效期。`;
    actionLabel = '去复核';
    priority = 95;
  } else if (pending || reviewDue) {
    status = 'needs_review';
    reasons = pending
      ? ['自动学习已经形成候选', '管理员确认前不会影响其他成员']
      : ['已到计划复核日期', '需要确认制度、负责人或适用范围是否变化'];
    question = pending
      ? `“${title}”的表述准确吗？它适用于哪些部门、场景和时间范围？`
      : `“${title}”到期复核：当前内容、适用范围和有效期是否仍然准确？`;
    actionLabel = pending ? '去确认' : '去复核';
    priority = pending ? 90 : 85;
  } else if (trusted) {
    status = 'trusted';
    reasons = trustedByAdmin
      ? ['由企业管理员直接确认', '当前可信度达到可用标准']
      : ['已经获得独立工作证据支持', '当前可信度达到可用标准'];
    question = `“${title}”当前证据充分；后续出现新口径时，Otto 会保留证据并提示重新确认。`;
    actionLabel = '查看依据';
    priority = 0;
  } else {
    status = 'learning';
    reasons = learningReasons(item);
    question = `谁能确认“${title}”在真实工作中仍然成立？最好补充正式文件、负责人确认或另一次独立执行结果。`;
    actionLabel = '补充验证';
    priority = 60 + Math.round((1 - Math.min(1, Math.max(0, item.confidence))) * 20);
  }

  return {
    id: item.id,
    title,
    category: item.category,
    status,
    confidence: Math.min(1, Math.max(0, item.confidence)),
    reasons,
    question,
    actionLabel,
    usageScenarios: enterpriseMemoryUsageScenarios(item),
    useStatus: item.status === 'active' && !expired && !conflicted
      ? '已启用：遇到相关问题和任务时自动参考'
      : '未启用：完成确认或复核前不会自动调用',
    priority,
  };
}

export function buildEnterpriseMemoryHealth(
  items: readonly EnterpriseMemoryHealthItem[],
  now = Date.now(),
): EnterpriseMemoryHealthResult {
  const nodes = items
    .filter((item) => item.status !== 'archived')
    .map((item) => classify(item, now))
    .sort((left, right) => right.priority - left.priority
      || left.title.localeCompare(right.title, 'zh-CN'));
  const counts: Record<EnterpriseMemoryHealthStatus, number> = {
    trusted: 0,
    learning: 0,
    needs_review: 0,
    conflicted: 0,
    expired: 0,
  };
  for (const node of nodes) counts[node.status] += 1;
  const scoreByStatus: Record<EnterpriseMemoryHealthStatus, number> = {
    trusted: 100,
    learning: 55,
    needs_review: 35,
    conflicted: 10,
    expired: 0,
  };
  const governanceScore = nodes.length
    ? Math.round(nodes.reduce((sum, node) => sum + scoreByStatus[node.status], 0) / nodes.length)
    : 0;
  return {
    governanceScore,
    counts,
    nodes,
    nextAction: nodes.find((node) => node.priority > 0) ?? null,
  };
}
