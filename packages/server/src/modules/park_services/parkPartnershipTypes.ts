/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface EnterprisePublicProfileInput {
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

export type ParkPartnershipStrength =
  | 'strong'
  | 'promising'
  | 'exploratory';

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
  parkId: string;
  parkName: string;
  currentOrganizationId: string;
  generatedAt: string;
  nodes: EnterprisePublicProfile[];
  edges: ParkPartnershipEdge[];
}
