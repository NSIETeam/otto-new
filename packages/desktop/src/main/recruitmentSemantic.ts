/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const RECRUITMENT_SEMANTIC_ANALYSIS_VERSION = 'otto-recruitment-semantic-v2.0';

export const RECRUITMENT_SEMANTIC_DIMENSIONS = [
  { id: 'core_capability', label: '核心能力', weight: 0.3 },
  { id: 'experience_depth', label: '经验深度', weight: 0.25 },
  { id: 'delivery_impact', label: '交付与结果', weight: 0.2 },
  { id: 'role_scope', label: '职责范围', weight: 0.15 },
  { id: 'transferability', label: '可迁移能力', weight: 0.1 },
] as const;

export type RecruitmentSemanticDimensionId =
  typeof RECRUITMENT_SEMANTIC_DIMENSIONS[number]['id'];

export type RecruitmentMatchLevel =
  | 'strong'
  | 'good'
  | 'partial'
  | 'weak'
  | 'insufficient';

export interface RecruitmentSemanticEvidence {
  line: number;
  quote: string;
}

export interface RecruitmentSemanticDimension {
  id: RecruitmentSemanticDimensionId;
  label: string;
  score: number;
  assessment: string;
  evidence: RecruitmentSemanticEvidence[];
  uncertainties: string[];
}

export interface RecruitmentHardRequirement {
  requirement: string;
  status: 'met' | 'partially_met' | 'not_met' | 'not_demonstrated' | 'unclear';
  explanation: string;
  evidence: RecruitmentSemanticEvidence[];
}

export interface RecruitmentSemanticInterviewQuestion {
  criterion: string;
  question: string;
  rationale: string;
  followUps: string[];
  goodSignals: string[];
  concernSignals: string[];
}

export interface RecruitmentSemanticEvaluation {
  summary: string;
  overallScore: number;
  matchLevel: RecruitmentMatchLevel;
  evidenceCoverage: number;
  dimensions: RecruitmentSemanticDimension[];
  hardRequirements: RecruitmentHardRequirement[];
  strengths: string[];
  risks: string[];
  missingInformation: string[];
  interviewQuestions: RecruitmentSemanticInterviewQuestion[];
  analysisVersion: string;
  modelProvider: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface RecruitmentSemanticAnalysisInput {
  candidateId: string;
  jobTitle: string;
  jobDescription: string;
  redactedResume: string;
}
