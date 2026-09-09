/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface EnterprisePublicProfileInput {
  primaryIndustryCode?: string | null;
  primaryIndustryName?: string | null;
  industryClassificationBasis?:
    | 'company_selected'
    | 'researcher_classified_from_public_business'
    | 'migrated_suggestion'
    | null;
  industryConfirmedByCompany?: boolean;
  summary: string;
  website: string;
  industryTags: string[];
  productsServices: string[];
  capabilities: string[];
  cooperationNeeds: string[];
  publicContact: string;
  isPublic: boolean;
}
export interface EnterprisePublicProfile extends EnterprisePublicProfileInput {
  organizationId: string;
  organizationName: string;
  updatedAt: string | null;
}

export type ParkPartnershipStrength = 'strong' | 'promising' | 'exploratory';

export interface ParkPartnershipEdge {
  id: string;
  sourceOrganizationId: string;
  targetOrganizationId: string;
  strength: ParkPartnershipStrength;
  /** A deterministic rule confidence, not a probability of commercial success. */
  ruleConfidence: number;
  evidence: string[];
  unverifiedQuestions: string[];
}

export interface EnterpriseParkStarMap {
  capacityStatus?: 'ready' | 'list_only';
  totalNodeCount?: number;
  relationType?: 'same_industry';
  dataSource?: 'real' | 'demo';
  taxonomyVersion?: string;
  industryGroups?: Array<{
    code: string;
    name: string;
    memberOrganizationIds: string[];
  }>;
  unclassifiedNodeIds?: string[];
  relationshipCount?: number;
  parkId: string;
  parkName: string;
  currentOrganizationId: string;
  generatedAt: string;
  nodes: EnterprisePublicProfile[];
  edges: ParkPartnershipEdge[];
}
