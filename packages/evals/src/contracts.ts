/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

export type EvaluationLane =
  | 'agent'
  | 'coding'
  | 'context'
  | 'planning'
  | 'policy'
  | 'recovery'
  | 'rpa'
  | 'spreadsheet';

export interface EvaluationEvidence {
  kind:
    | 'tool_trace'
    | 'approval'
    | 'artifact'
    | 'assertion'
    | 'citation'
    | 'context_compaction'
    | 'plan_revision'
    | 'recovery_checkpoint'
    | 'verification';
  summary: string;
}

export interface EvaluationScores {
  correctness: number;
  completion: number;
  evidence: number;
  safety: number;
}

export interface EvaluationVerdict {
  passed: boolean;
  evidence: EvaluationEvidence[];
  scores?: Partial<EvaluationScores>;
  failure?: string;
}

export interface DeterministicScenario {
  id: string;
  lane: EvaluationLane;
  description: string;
  requiredEvidence: ReadonlyArray<EvaluationEvidence['kind']>;
  execute(): Promise<EvaluationVerdict>;
}

export interface EvaluationReport {
  version: 1;
  generatedAt: string;
  scenarios: Array<{
    id: string;
    lane: EvaluationLane;
    passed: boolean;
    evidence: EvaluationEvidence[];
    durationMs: number;
    scores: EvaluationScores;
    failure?: string;
  }>;
  summary: {
    total: number;
    passed: number;
    passRate: number;
    evidenceCoverage: number;
    averageScores: EvaluationScores;
    lanes: Record<string, { total: number; passed: number; passRate: number }>;
  };
}
