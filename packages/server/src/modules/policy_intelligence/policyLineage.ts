/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { OfficialPolicyDocument } from './contracts.js';
import { policyHash } from './policyDomain.js';
import { officialPolicyUrl } from './policySources.js';
function official(url: string): boolean {
  try {
    return officialPolicyUrl(url, [new URL(url).hostname]);
  } catch {
    return false;
  }
}
// Related does NOT mean equivalent/superseding. Never copy eligibility rules or
// deadlines between batches. Only original-page links justify these relations.
export function annotatePolicyBatches(
  documents: OfficialPolicyDocument[],
): OfficialPolicyDocument[] {
  const refs = (doc: OfficialPolicyDocument) =>
    (doc.references ?? []).filter(
      (ref) => official(ref.url) && ref.url !== doc.url,
    );
  return documents.map((doc) => {
    const years = [...new Set(doc.title.match(/20\d{2}(?=年)/gu))];
    const own = refs(doc);
    const relatedBatches: NonNullable<
      OfficialPolicyDocument['relatedBatches']
    > = [];
    for (const other of documents) {
      if (
        other.id === doc.id ||
        other.sourceStatus !== 'verified' ||
        policyHash(doc.region) !== policyHash(other.region)
      )
        continue;
      const direct = own.find((ref) => ref.url === other.url);
      const reverse = refs(other).find((ref) => ref.url === doc.url);
      const common = own.find(
        (ref) =>
          /办法|细则|措施|规定/u.test(ref.label) &&
          refs(other).some((r) => r.url === ref.url),
      );
      const evidence = direct ?? reverse ?? common;
      if (!evidence) continue;
      relatedBatches.push({
        policyId: other.id,
        title: other.title,
        url: other.url,
        evidenceUrl: evidence.url,
        reason:
          common && !direct && !reverse
            ? '两份原文引用同一办法（仅供关联查阅，不代表条件相同）'
            : '原文存在直接引用（不代表替代或条件继承）',
      });
    }
    return {
      ...doc,
      batch: {
        year: years.length === 1 ? years[0] : undefined,
        label: doc.title.match(/第[一二三四五六七八九十百\d]+批(?:次)?/u)?.[0],
      },
      relatedBatches: relatedBatches.slice(0, 30),
    };
  });
}
