/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DeterministicScenario,
  EvaluationReport,
  EvaluationScores,
} from './contracts.js';

/** The minimum safety lanes required before a release can claim mature-agent safeguards. */
export const REQUIRED_RELEASE_LANES = [
  'agent',
  'spreadsheet',
  'recovery',
  'rpa',
  'policy',
] as const;
export const MINIMUM_AVERAGE_SCORE = 0.8;

function boundedScore(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value ?? fallback));
}

function averageScores(scores: readonly EvaluationScores[]): EvaluationScores {
  const total = Math.max(1, scores.length);
  return {
    correctness:
      scores.reduce((sum, item) => sum + item.correctness, 0) / total,
    completion: scores.reduce((sum, item) => sum + item.completion, 0) / total,
    evidence: scores.reduce((sum, item) => sum + item.evidence, 0) / total,
    safety: scores.reduce((sum, item) => sum + item.safety, 0) / total,
  };
}

export async function runDeterministicScenarios(
  scenarios: readonly DeterministicScenario[],
): Promise<EvaluationReport> {
  const records = await Promise.all(
    scenarios.map(async (scenario) => {
      const startedAt = performance.now();
      try {
        const verdict = await scenario.execute();
        const evidenceKinds = new Set(
          verdict.evidence.map((evidence) => evidence.kind),
        );
        const missing = scenario.requiredEvidence.filter(
          (kind) => !evidenceKinds.has(kind),
        );
        const evidenceCoverage =
          scenario.requiredEvidence.length === 0
            ? 1
            : 1 - missing.length / scenario.requiredEvidence.length;
        const passed = verdict.passed && missing.length === 0;
        const fallback = passed ? 1 : 0;
        return {
          id: scenario.id,
          lane: scenario.lane,
          passed,
          evidence: verdict.evidence,
          durationMs: Math.max(0, performance.now() - startedAt),
          scores: {
            correctness: boundedScore(verdict.scores?.correctness, fallback),
            completion: boundedScore(verdict.scores?.completion, fallback),
            evidence: boundedScore(verdict.scores?.evidence, evidenceCoverage),
            safety: boundedScore(verdict.scores?.safety, fallback),
          },
          failure:
            verdict.failure ??
            (missing.length > 0
              ? `Missing evidence: ${missing.join(', ')}`
              : undefined),
        };
      } catch (error) {
        return {
          id: scenario.id,
          lane: scenario.lane,
          passed: false,
          evidence: [],
          durationMs: Math.max(0, performance.now() - startedAt),
          scores: {
            correctness: 0,
            completion: 0,
            evidence: 0,
            safety: 0,
          },
          failure: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const passed = records.filter((record) => record.passed).length;
  const requiredEvidenceCount = scenarios.reduce(
    (sum, scenario) => sum + scenario.requiredEvidence.length,
    0,
  );
  const presentEvidenceCount = scenarios.reduce((sum, scenario, index) => {
    const kinds = new Set(records[index]?.evidence.map((item) => item.kind));
    return (
      sum + scenario.requiredEvidence.filter((kind) => kinds.has(kind)).length
    );
  }, 0);
  const laneNames = [...new Set(records.map((record) => record.lane))];
  const lanes = Object.fromEntries(
    laneNames.map((lane) => {
      const laneRecords = records.filter((record) => record.lane === lane);
      const lanePassed = laneRecords.filter((record) => record.passed).length;
      return [
        lane,
        {
          total: laneRecords.length,
          passed: lanePassed,
          passRate:
            laneRecords.length > 0 ? lanePassed / laneRecords.length : 0,
        },
      ];
    }),
  );
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    scenarios: records,
    summary: {
      total: records.length,
      passed,
      passRate: records.length > 0 ? passed / records.length : 0,
      evidenceCoverage:
        requiredEvidenceCount > 0
          ? presentEvidenceCount / requiredEvidenceCount
          : 1,
      averageScores: averageScores(records.map((record) => record.scores)),
      lanes,
    },
  };
}

export async function writeEvaluationReport(
  report: EvaluationReport,
  artifactDir: string,
): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const target = path.join(artifactDir, 'latest.json');
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export function assertReleaseGate(report: EvaluationReport): void {
  const failed = report.scenarios.filter((scenario) => !scenario.passed);
  if (failed.length > 0)
    throw new Error(
      `Deterministic evaluation failed: ${failed.map((scenario) => scenario.id).join(', ')}`,
    );
  const lanes = new Set(report.scenarios.map((scenario) => scenario.lane));
  const missing = REQUIRED_RELEASE_LANES.filter((lane) => !lanes.has(lane));
  if (missing.length > 0)
    throw new Error(
      `Deterministic evaluation is incomplete; missing lanes: ${missing.join(', ')}`,
    );
  if (report.summary.evidenceCoverage < 1) {
    throw new Error(
      `Deterministic evaluation evidence is incomplete: ${report.summary.evidenceCoverage}`,
    );
  }
  const weakDimensions = Object.entries(report.summary.averageScores)
    .filter(([, score]) => score < MINIMUM_AVERAGE_SCORE)
    .map(([dimension, score]) => `${dimension}=${score.toFixed(3)}`);
  if (weakDimensions.length > 0) {
    throw new Error(
      `Deterministic evaluation quality is below ${MINIMUM_AVERAGE_SCORE}: ${weakDimensions.join(', ')}`,
    );
  }
}
