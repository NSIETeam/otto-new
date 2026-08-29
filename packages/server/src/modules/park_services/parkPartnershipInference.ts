/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  EnterprisePublicProfile,
  ParkPartnershipEdge,
  ParkPartnershipStrength,
} from './parkPartnershipTypes.js';

type EvidenceKind = '公开能力' | '公开产品/服务';

interface ComplementaryEvidence {
  requesterName: string;
  providerName: string;
  need: string;
  offering: string;
  kind: EvidenceKind;
}

function normalizedMatchValue(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s,，。.!！?？、;；:：()（）【】\u005b\u005d_/\\-]+/g, '');
}

function isComplementary(left: string, right: string): boolean {
  const a = normalizedMatchValue(left);
  const b = normalizedMatchValue(right);
  if (!a || !b || Math.min(a.length, b.length) < 2) return false;
  return a.includes(b) || b.includes(a);
}

function collectEvidence(
  requester: EnterprisePublicProfile,
  provider: EnterprisePublicProfile,
): ComplementaryEvidence[] {
  const result: ComplementaryEvidence[] = [];
  for (const need of requester.cooperationNeeds) {
    for (const capability of provider.capabilities) {
      if (isComplementary(need, capability)) {
        result.push({
          requesterName: requester.organizationName,
          providerName: provider.organizationName,
          need,
          offering: capability,
          kind: '公开能力',
        });
      }
    }
    for (const product of provider.productsServices) {
      if (isComplementary(need, product)) {
        result.push({
          requesterName: requester.organizationName,
          providerName: provider.organizationName,
          need,
          offering: product,
          kind: '公开产品/服务',
        });
      }
    }
  }
  return result;
}

function strengthFor(
  evidenceCount: number,
  bidirectional: boolean,
): ParkPartnershipStrength {
  if (evidenceCount >= 3 || (evidenceCount >= 2 && bidirectional)) {
    return 'strong';
  }
  if (evidenceCount >= 2 || bidirectional) return 'promising';
  return 'exploratory';
}

/**
 * Produces deterministic, rule-based suggestions using only explicitly
 * disclosed cooperation needs, products/services and capabilities.
 */
export function inferParkPartnerships(
  profiles: EnterprisePublicProfile[],
): ParkPartnershipEdge[] {
  const publicProfiles = profiles
    .filter((profile) => profile.isPublic)
    .slice()
    .sort((a, b) => a.organizationId.localeCompare(b.organizationId));
  const edges: ParkPartnershipEdge[] = [];

  for (let leftIndex = 0; leftIndex < publicProfiles.length; leftIndex += 1) {
    const left = publicProfiles[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < publicProfiles.length;
      rightIndex += 1
    ) {
      const right = publicProfiles[rightIndex]!;
      const leftToRight = collectEvidence(left, right);
      const rightToLeft = collectEvidence(right, left);
      const matches = [...leftToRight, ...rightToLeft];
      if (matches.length === 0) continue;

      const evidence = Array.from(
        new Set(
          matches.map(
            (match) =>
              `${match.requesterName}公开需求“${match.need}”与${match.providerName}${match.kind}“${match.offering}”存在互补`,
          ),
        ),
      );
      const bidirectional = leftToRight.length > 0 && rightToLeft.length > 0;
      edges.push({
        id: `${left.organizationId}--${right.organizationId}`,
        sourceOrganizationId: left.organizationId,
        targetOrganizationId: right.organizationId,
        strength: strengthFor(evidence.length, bidirectional),
        ruleConfidence: Math.min(0.94, 0.62 + evidence.length * 0.08),
        evidence,
        unverifiedQuestions: [
          '双方需核实交付范围、产能、时间与商务条件。',
          '公开资料是否仍然有效，需由企业联系人确认。',
        ],
      });
    }
  }

  return edges;
}
