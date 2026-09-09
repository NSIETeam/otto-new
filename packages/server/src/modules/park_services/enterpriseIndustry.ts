/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import taxonomy from './enterpriseIndustryTaxonomy.json' with { type: 'json' };
import type {
  EnterprisePublicProfile,
  EnterprisePublicProfileInput,
} from './parkPartnershipTypes.js';

export const ENTERPRISE_INDUSTRIES = taxonomy;
export const INDUSTRY_TAXONOMY_VERSION = 'park-industry-v1';
const names = new Map(taxonomy.map(({ code, name }) => [code, name]));

/** Called only after the profile editor's authority has been checked. Never trusts supplied labels. */
export function normalizePrimaryIndustry(
  code: unknown,
): Pick<
  EnterprisePublicProfileInput,
  | 'primaryIndustryCode'
  | 'primaryIndustryName'
  | 'industryClassificationBasis'
  | 'industryConfirmedByCompany'
> {
  if (code === null || code === undefined || code === '')
    return {
      primaryIndustryCode: null,
      primaryIndustryName: null,
      industryClassificationBasis: null,
      industryConfirmedByCompany: false,
    };
  if (typeof code !== 'string' || !names.has(code))
    throw new Error('请选择有效的主营行业');
  return {
    primaryIndustryCode: code,
    primaryIndustryName: names.get(code)!,
    industryClassificationBasis: 'company_selected',
    industryConfirmedByCompany: true,
  };
}

/** Whitelist persisted fields. Legacy/malformed metadata must not override profile identity or visibility. */
export function readPrimaryIndustry(
  value: unknown,
): ReturnType<typeof normalizePrimaryIndustry> {
  const record =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const code = record.primaryIndustryCode;
  if (typeof code !== 'string' || !names.has(code))
    return normalizePrimaryIndustry(null);
  return {
    primaryIndustryCode: code,
    primaryIndustryName: names.get(code)!,
    industryConfirmedByCompany: record.industryConfirmedByCompany === true,
    industryClassificationBasis:
      record.industryClassificationBasis === 'company_selected' ||
      record.industryClassificationBasis ===
        'researcher_classified_from_public_business'
        ? record.industryClassificationBasis
        : 'migrated_suggestion',
  };
}

export function parsePrimaryIndustry(
  value: string,
): ReturnType<typeof normalizePrimaryIndustry> {
  try {
    return readPrimaryIndustry(JSON.parse(value));
  } catch {
    return normalizePrimaryIndustry(null);
  }
}

/** Input is already park-authorized. Groups represent the complete relation without quadratic edges. */
export function buildIndustryGraph(
  profiles: EnterprisePublicProfile[],
  dataSource: 'real' | 'demo' = 'real',
) {
  const groups = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  for (const profile of profiles) {
    if (!profile.isPublic) continue;
    const code = profile.primaryIndustryCode;
    if (
      !code ||
      !names.has(code) ||
      (dataSource === 'real' && profile.industryConfirmedByCompany !== true)
    ) {
      unknown.add(profile.organizationId);
      continue;
    }
    const group = groups.get(code) ?? new Set<string>();
    group.add(profile.organizationId);
    groups.set(code, group);
  }
  const industryGroups = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, members]) => ({
      code,
      name: names.get(code)!,
      memberOrganizationIds: [...members].sort(),
    }));
  return {
    capacityStatus:
      profiles.filter((profile) => profile.isPublic).length > 300
        ? ('list_only' as const)
        : ('ready' as const),
    totalNodeCount: new Set(
      profiles
        .filter((profile) => profile.isPublic)
        .map((profile) => profile.organizationId),
    ).size,
    relationType: 'same_industry' as const,
    dataSource,
    taxonomyVersion: INDUSTRY_TAXONOMY_VERSION,
    industryGroups,
    unclassifiedNodeIds: [...unknown].sort(),
    relationshipCount: industryGroups.reduce(
      (sum, group) =>
        sum +
        (group.memberOrganizationIds.length *
          (group.memberOrganizationIds.length - 1)) /
          2,
      0,
    ),
  };
}
