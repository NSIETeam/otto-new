/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export interface PolicyRegion {
  country: 'CN';
  province?: string;
  city?: string;
  district?: string;
}
export type PolicyLevel = 'national' | 'province' | 'city' | 'district';
export type PolicyStatus =
  | 'open'
  | 'upcoming'
  | 'evergreen'
  | 'closed'
  | 'unknown'
  | 'reference'
  | 'withdrawn'
  | 'expired';
export type PolicyResult = 'met' | 'gap' | 'unknown';
export type PolicyConclusion =
  'likely_eligible' | 'has_gaps' | 'unlikely' | 'unknown';
export type PolicyConditionTree =
  string | { all: PolicyConditionTree[] } | { any: PolicyConditionTree[] };
export interface PolicyEnterpriseProfile {
  organizationName?: string;
  registeredRegion?: string;
  region?: PolicyRegion;
  industry?: string;
  establishedAt?: string;
  enterpriseType?: string;
  mainBusiness?: string;
  employeeCount?: number;
  annualRevenueCny?: number;
  rdExpenseCny?: number;
  fiscalYear?: number;
  qualifications?: string[];
  productsServices?: string[];
  capabilities?: string[];
  notes?: string;
  [field: string]: unknown;
}
export interface PolicySource {
  id: string;
  name: string;
  listUrl: string;
  allowedHosts: string[];
  level: PolicyLevel;
  region: PolicyRegion;
}
export interface PolicyReference {
  label: string;
  url: string;
  quote: string;
}
export interface PolicyCondition {
  id: string;
  label: string;
  quote: string;
  factKeys: string[];
  question?: string;
  result?: PolicyResult;
  evidence?: string;
  comparison?: { field: string; operator: 'gte' | 'lte' | 'eq'; value: number };
}
/** Bounded data, never executable code. Each predicate carries its own source evidence. */
export type PolicyFactRule =
  | {
      field: string;
      operator: 'eq' | 'gte' | 'lte' | 'contains';
      value: string | number | boolean;
      quote: string;
      question?: string;
    }
  | { all: PolicyFactRule[] }
  | { any: PolicyFactRule[] };
export interface PolicyExclusion {
  id: string;
  label: string;
  quote: string;
  when: PolicyFactRule;
  appliesWhen?: PolicyFactRule;
  unless?: PolicyFactRule;
  /** Omitted means policy-wide; otherwise only these OR/AND branches are affected. */
  scopeConditionIds?: string[];
  question?: string;
}
export interface PolicyExclusionResult {
  id: string;
  label: string;
  quote: string;
  result: 'hit' | 'clear' | 'unknown';
  missingFields: string[];
  scopeConditionIds?: string[];
}
export interface PolicyGovernance {
  status: 'revoked' | 'superseded' | 'conflict';
  quote: string;
  referenceUrl: string;
  effectiveAt?: string;
}
export type PolicySupportEstimate =
  | { kind: 'fixed'; amountCny: number; quote: string }
  | {
      kind: 'rate';
      field: string;
      rate: number;
      capCny?: number;
      quote: string;
    };
export interface PolicyFeedback {
  policyId: string;
  policyContentHash: string;
  policyVersion: number;
  diagnosisId?: string;
  outcome: 'submitted' | 'approved' | 'rejected' | 'dispute';
  reason:
    'none' | 'eligibility' | 'materials' | 'quota' | 'competition' | 'other';
  note: string;
  reviewStatus: 'recorded' | 'pending';
  revision: number;
  updatedAt: string;
}
export interface OfficialPolicyDocument {
  id: string;
  title: string;
  url: string;
  sourceId: string;
  sourceName: string;
  level: PolicyLevel;
  region: PolicyRegion;
  issuer: string;
  categories: string[];
  publishedAt?: string;
  startsAt?: string;
  deadline?: string;
  evergreen?: boolean;
  referenceOnly?: boolean;
  validFrom?: string;
  validUntil?: string;
  governance?: PolicyGovernance;
  exclusions?: PolicyExclusion[];
  exclusionsReviewed?: boolean;
  interpretationVersion?: number;
  supportEstimate?: PolicySupportEstimate;
  fetchedAt: string;
  contentHash: string;
  version: number;
  bodyText: string;
  summary: string;
  supportText: string;
  conditions: PolicyCondition[];
  conditionTree: PolicyConditionTree;
  materials: Array<{ id: string; label: string; quote: string }>;
  resources: PolicyReference[];
  attachments: Array<{ label: string; url: string; parsed: boolean }>;
  sourceStatus: 'verified' | 'unavailable';
  interpretationStatus: 'ready' | 'pending' | 'failed';
  error?: string;
}
export interface PolicyAssessment {
  policyId: string;
  status: PolicyConclusion;
  summary: string;
  conditions: Array<
    PolicyCondition & { result: PolicyResult; evidence: string }
  >;
  gaps: string[];
  missingFields: string[];
  resourceConnections: string[];
  assessedAt: string;
  profileFingerprint: string;
  policyContentHash: string;
  policyRulesHash?: string;
  exclusions?: PolicyExclusionResult[];
  warnings?: string[];
  supportEstimate?: { amountCny?: number; explanation: string; quote?: string };
  group: 'evaluate' | 'prepare' | 'all';
  modelProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
  analysisError?: string;
}
export interface PolicyDiagnosis extends PolicyAssessment {
  id: string;
  accountId: string;
  policyVersion: number;
  revision: number;
  answers: Record<string, string | number | boolean | string[] | null>;
  factVersion: string;
  stale: boolean;
  question?: {
    field: string;
    label: string;
    valueType?: 'number' | 'text' | 'boolean';
  };
}
export interface PolicyMaterialState {
  status: 'ready' | 'unknown' | 'missing';
  version: string;
  updatedAt: string;
  updatedBy: string;
}
export interface PolicyIntelligenceState {
  enabled: boolean;
  profile: PolicyEnterpriseProfile;
  policies: OfficialPolicyDocument[];
  assessments: PolicyAssessment[];
  diagnoses: PolicyDiagnosis[];
  materials: Record<string, PolicyMaterialState>;
  canManage: boolean;
  region: PolicyRegion;
  coverage: Array<{
    level: PolicyLevel;
    regionLabel: string;
    sourceCount: number;
    status: 'configured' | 'missing';
  }>;
  categories: string[];
  missingProfileFields: string[];
  syncStatus: 'idle' | 'syncing' | 'error';
  lastSyncAt?: string;
  lastError?: string;
  modelName: string;
  usedAnalysesToday: number;
  dailyAnalysisLimit: number;
  feedback?: PolicyFeedback[];
  feedbackRevisions?: Record<string, number>;
}
export interface PolicyActor {
  id: string;
  organizationId: string;
  organizationName: string;
  isAdmin: boolean;
  active: boolean;
}
export type PolicyFactValue = string | number | boolean | string[] | null;
export interface PolicyAction {
  action:
    | 'configure'
    | 'profile'
    | 'sync'
    | 'diagnose'
    | 'answer'
    | 'material'
    | 'feedback'
    | 'delete-feedback'
    | 'delete-diagnosis';
  enabled?: boolean;
  consent?: boolean;
  profile?: PolicyEnterpriseProfile;
  policyId?: string;
  diagnosisId?: string;
  revision?: number;
  field?: string;
  value?: PolicyFactValue;
  saveToEnterprise?: boolean;
  materialId?: string;
  materialStatus?: PolicyMaterialState['status'];
  feedback?: Pick<PolicyFeedback, 'outcome' | 'reason' | 'note'>;
}
export interface PolicyModel {
  name: string;
  extract(
    document: OfficialPolicyDocument,
    signal: AbortSignal,
  ): Promise<Partial<OfficialPolicyDocument>>;
  analyze(
    document: OfficialPolicyDocument,
    profile: PolicyEnterpriseProfile,
    signal: AbortSignal,
  ): Promise<{
    relevant: boolean;
    summary: string;
    conditions: Array<PolicyCondition & { result: PolicyResult }>;
    inputTokens?: number;
    outputTokens?: number;
    refutation?: {
      checked: true;
      concerns: Array<{ quote: string; note: string }>;
    };
  }>;
}
