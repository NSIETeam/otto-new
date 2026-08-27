/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseKnowledgeItem } from '../preload/index.js';

function compact(value: string | null | undefined, maximum: number): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

function evidenceLine(item: EnterpriseKnowledgeItem): string {
  const evidence = [
    typeof item.confidence === 'number'
      ? `${item.sourceType === 'auto_capture' ? '组织可靠度' : '记录置信度'} ${Math.round(
        Math.min(1, Math.max(0, item.confidence)) * 100,
      )}%`
      : '',
    (item.evidenceCount ?? 0) > 0 ? `${item.evidenceCount} 条证据` : '',
    (item.distinctSessionCount ?? 0) > 0 ? `${item.distinctSessionCount} 个会话` : '',
    (item.distinctContributorCount ?? 0) > 0
      ? `${item.distinctContributorCount} 名贡献者`
      : '',
    (item.verifiedEvidenceCount ?? 0) > 0 ? `${item.verifiedEvidenceCount} 条已验证` : '',
  ].filter(Boolean);
  if (item.sourceType === 'auto_capture') {
    const lastEvidence = Date.parse(item.lastObservedAt || item.updatedAt || item.createdAt);
    if (Number.isFinite(lastEvidence)) {
      const ageDays = Math.max(0, (Date.now() - lastEvidence) / 86_400_000);
      if (ageDays > 180) {
        evidence.push('时效：超过 180 天未获新证据，仅作历史参考，回答前必须重新确认');
      } else if (ageDays > 90) {
        evidence.push('时效：超过 90 天未获新证据，使用时应复核');
      }
    }
  }
  return evidence.length > 0 ? `证据：${evidence.join('；')}` : '';
}

/** Formats only published records returned by the authenticated enterprise server. */
export function buildEnterpriseKnowledgePromptContext(
  items: readonly EnterpriseKnowledgeItem[],
): string {
  return items
    .filter((item) => !item.status || item.status === 'active')
    .slice(0, 8)
    .map((item) => {
      const citation = `[企业知识#${compact(item.id, 40)} v${item.version || 1}]`;
      const scope = compact(item.department, 80) || '全组织';
      const source = compact(item.sourceLabel || item.sourceId, 140);
      const evidence = evidenceLine(item);
      return [
        `${citation} ${compact(item.title, 180) || compact(item.category, 100)}`,
        `范围：${scope}；分类：${compact(item.category, 100)}${source ? `；来源：${source}` : ''}`,
        ...(evidence ? [evidence] : []),
        compact(item.content, 900),
      ].join('\n');
    })
    .join('\n\n')
    .slice(0, 8_000);
}
