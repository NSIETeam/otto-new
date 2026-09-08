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
  reviewedAt?: string | null;
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
  if ((item.distinctSessionCount ?? 0) < 2) reasons.push('目前不足两个会话的观察记录');
  if ((item.distinctContributorCount ?? 0) < 2) reasons.push('目前不足两名贡献者的记录');
  if ((item.verifiedEvidenceCount ?? 0) < 1) reasons.push('尚无标记为已验证的记录；重复出现不等于事实已核实');
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
  // Counts and review records are observable; model scores and repetition are not factual validation.
  const trustedByEvidence = (item.verifiedEvidenceCount ?? 0) > 0;
  const trustedByAdmin = Boolean(item.reviewedAt);
  const trusted = item.status === 'active' && (trustedByEvidence || trustedByAdmin);

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
      ? ['内容已保存为待确认版本', '管理员确认前不会进入成员知识检索']
      : ['已到计划复核日期', '需要确认制度、负责人或适用范围是否变化'];
    question = pending
      ? `“${title}”的表述准确吗？它适用于哪些部门、场景和时间范围？`
      : `“${title}”到期复核：当前内容、适用范围和有效期是否仍然准确？`;
    actionLabel = pending ? '去确认' : '去复核';
    priority = pending ? 90 : 85;
  } else if (trusted) {
    status = 'trusted';
    reasons = trustedByAdmin
      ? ['有人工审核记录', '审核记录不代表所有场景均已验证']
      : ['有标记为已验证的观察记录', '仍需核对原文和适用条件，不等于结论必然正确'];
    question = `“${title}”已有确认记录；条件变化时仍需核对来源并重新确认。`;
    actionLabel = '查看依据';
    priority = 0;
  } else {
    status = 'learning';
    reasons = learningReasons(item);
    question = `谁能确认“${title}”在真实工作中仍然成立？最好补充正式文件、负责人确认或另一次独立执行结果。`;
    actionLabel = '补充验证';
    priority = 60;
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
    useStatus: enterpriseMemoryUseStatus(item, now),
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
  return {
    counts,
    nodes,
    nextAction: nodes.find((node) => node.priority > 0) ?? null,
  };
}

export function enterpriseMemoryUseStatus(item: Pick<EnterpriseMemoryHealthItem, 'status' | 'sourceLabel' | 'expiresAt'>, now = Date.now()): string {
  if (item.status === 'archived') return '已停止使用：不会进入知识检索';
  if (item.sourceLabel?.includes('证据存在冲突')) return '存在冲突：裁决并确认前不启用';
  if (dateReached(item.expiresAt, now)) return '已过期：复核前不启用';
  if (item.status !== 'active') return '待确认：尚未进入成员知识检索';
  return '可被检索：相关时作为参考，不代表本次已调用';
}
