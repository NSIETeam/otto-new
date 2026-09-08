/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { DeliveryReadiness } from './deliveryClosure.js';
import type { AgentArtifactReference } from './protocol.js';

export function retainedDeliveryDraft(draft: string): string {
  // Drop only standalone, blanket success assertions. Do not discard useful
  // findings, citations or artifact links to guess at their semantic content.
  return draft
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !/^\s*(?:全部完成|已全部完成|已完成|完成|all done|all tasks completed|done)[。.!！\s]*$/iu.test(
          line,
        ),
    )
    .join('\n')
    .trim();
}

/** Provisional model prose must not masquerade as an accepted delivery. */
export function unverifiedDeliveryText(draft: string): string {
  const retained = retainedDeliveryDraft(draft);
  return retained ? `以下为尚未验收的过程说明：\n\n${retained}` : '';
}

export function incompleteDelivery(
  draft: string,
  review: DeliveryReadiness,
  artifacts: readonly AgentArtifactReference[] = [],
): string {
  const retained = retainedDeliveryDraft(draft);
  const outstanding = [...new Set(review.missing.map((c) => c.label))];
  const reasons = review.blockers?.length
    ? review.blockers
    : review.blocked
      ? ['存在待确认或待核对的操作；需要先明确其结果，不会自动重放。']
      : ['自动补齐次数已用尽、未取得进一步验收进展，或剩余执行预算不足。'];
  return [
    '当前工作尚未完成验收，以下内容不能视为整项任务已完成。',
    ...(retained ? ['已保留的工作说明（仍以验收结果为准）：', retained] : []),
    ...(() => {
      const links = artifacts
        .filter((a) => a.verified && a.path && !/[<>\r\n]/u.test(a.path))
        .map((a) => `- [${a.label.replace(/[[\]\\\r\n]/gu, '')}](<${a.path}>)`);
      return links.length
        ? [
            '已保留的可读取文件（内容仍以逐项验收为准）：\n\n' +
              links.join('\n'),
          ]
        : [];
    })(),
    '仍需核对：\n\n' +
      outstanding
        .slice(0, 12)
        .map((label) => `- ${label}`)
        .join('\n') +
      (outstanding.length > 12
        ? `\n- 另有 ${outstanding.length - 12} 项，详见处理记录。`
        : ''),
    '停止原因与下一步：\n\n' +
      reasons.map((reason) => `- ${reason}`).join('\n'),
  ].join('\n\n');
}
