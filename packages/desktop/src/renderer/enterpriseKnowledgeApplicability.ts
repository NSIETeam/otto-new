/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseKnowledgeItem } from '../preload/index.js';

const DAY_MS = 86_400_000;

export type EnterpriseKnowledgeApplicabilityState =
  | 'current'
  | 'verify_before_use'
  | 'historical'
  | 'blocked';

export interface EnterpriseKnowledgeApplicability {
  state: EnterpriseKnowledgeApplicabilityState;
  usable: boolean;
  reason: string | null;
}

function hasUnresolvedConflict(item: EnterpriseKnowledgeItem): boolean {
  const label = item.sourceLabel?.trim() || '';
  if (/管理员已裁决冲突/u.test(label)) return false;
  return /证据存在冲突|冲突证据[^；。]*禁止自动发布|\bcontested\b/iu.test(label);
}

/**
 * Applies the same fail-closed recall rule to normal chat, A2A and the memory UI.
 * Historical records remain visible in administration but are not injected as facts.
 */
export function evaluateEnterpriseKnowledgeApplicability(
  item: EnterpriseKnowledgeItem,
  now = Date.now(),
): EnterpriseKnowledgeApplicability {
  if (hasUnresolvedConflict(item)) {
    return { state: 'blocked', usable: false, reason: '存在尚未裁决的证据冲突' };
  }
  if (item.status && item.status !== 'active') {
    return { state: 'blocked', usable: false, reason: '记录尚未发布或已经归档' };
  }
  const expiresAt = Date.parse(item.expiresAt || '');
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return { state: 'historical', usable: false, reason: '服务器登记的知识有效期已结束' };
  }
  const reviewDueAt = Date.parse(item.reviewDueAt || '');
  if (Number.isFinite(reviewDueAt) && reviewDueAt <= now) {
    return { state: 'verify_before_use', usable: true, reason: '已到管理员复核日期' };
  }
  if (item.sourceType !== 'auto_capture') {
    return { state: 'current', usable: true, reason: null };
  }
  const reference = Math.max(
    ...[item.lastObservedAt, item.reviewedAt, item.updatedAt, item.createdAt]
      .map((value) => Date.parse(value || ''))
      .filter(Number.isFinite),
  );
  if (!Number.isFinite(reference)) {
    return { state: 'verify_before_use', usable: true, reason: '缺少可复核的最近验证时间' };
  }
  const ageDays = Math.max(0, (now - reference) / DAY_MS);
  if (ageDays > 180) {
    return { state: 'historical', usable: false, reason: '超过 180 天未获新证据' };
  }
  if (ageDays > 90) {
    return { state: 'verify_before_use', usable: true, reason: '超过 90 天未获新证据' };
  }
  return { state: 'current', usable: true, reason: null };
}

export function enterpriseKnowledgeExclusionNotice(
  excluded: readonly EnterpriseKnowledgeApplicability[],
): string {
  if (excluded.length === 0) return '';
  const reasons = [...new Set(excluded.map((item) => item.reason).filter(Boolean))];
  return `[企业知识使用约束] 已排除 ${excluded.length} 条不可直接使用的企业记忆：${reasons.join('；')}。`;
}
