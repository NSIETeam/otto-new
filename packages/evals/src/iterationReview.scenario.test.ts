/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  reviewIteration,
  FAILURE_TYPES,
  type IterationInput,
} from './iterationReview.js';
import {
  STAGE7_FAMILIES,
  type Stage7Plan,
  type Stage7Record,
} from './stage7Comparison.js';

const hash = (n: number) => n.toString(16).padStart(64, '0');
function fixture(): IterationInput {
  const cohort = (prefix: string, experiment: number) => {
    const plan: Stage7Plan = {
      beforeSource: hash(1),
      afterSource: hash(2),
      experimentHash: hash(experiment),
      repeats: 1,
      cases: STAGE7_FAMILIES.flatMap((family) =>
        [1, 2].map((i) => ({
          id: `${prefix}-${family}-${i}`,
          family,
          critical: true,
        })),
      ),
    };
    const records: Stage7Record[] = plan.cases.flatMap((c) =>
      (['before', 'after'] as const).map((variant) => ({
        variant,
        caseId: c.id,
        repeat: 1,
        sourceFingerprint: variant === 'before' ? hash(1) : hash(2),
        experimentHash: hash(experiment),
        mode: 'real_model',
        status: 'executed',
        independentPass: true,
        productCompleted: true,
        constraintViolation: false,
        traceComplete: true,
        correctiveFollowups: 0,
        clarificationRequests: 0,
        approvalRequests: 0,
        durationMs: 1000,
        costUsd: 0.01,
        evidenceHashes: [hash(8)],
        humanReview: 'approved',
      })),
    );
    records[0].independentPass = false;
    return { plan, records, conditionsHash: hash(9) };
  };
  const regression = cohort('dev', 3);
  const holdout = cohort('new', 4);
  return {
    roundId: 'round-2',
    parentReportHash: hash(5),
    regression,
    holdout,
    classifications: [
      {
        issueId: 'issue-1',
        variant: 'before',
        caseId: regression.plan.cases[0].id,
        repeat: 1,
        type: 'constraint_false_block',
        evidenceHash: hash(8),
        reason: 'Native guard denied the scoped generator.',
        confirmed: true,
      },
    ],
    focus: {
      issueId: 'issue-1',
      allowedFiles: ['packages/core/src/tools/example.ts'],
    },
    changedFiles: ['packages/core/src/tools/example.ts'],
    holdoutReservation: {
      candidateFrozenAt: '2026-09-08T01:00:00Z',
      reservedAt: '2026-09-08T00:00:00Z',
      firstExposedAt: '2026-09-08T02:00:00Z',
      independentReview: true,
      tasks: holdout.plan.cases.map((c, i) => ({
        id: c.id,
        contentHash: hash(100 + i),
      })),
      regressionTasks: regression.plan.cases.map((c, i) => ({
        id: c.id,
        contentHash: hash(200 + i),
      })),
      priorExposures: [],
      debuggingContentHashes: [],
    },
    safety: {
      sourceFingerprint: hash(2),
      required: [
        'no-external-open',
        'no-path-escape',
        'no-false-delivery',
        'no-replay',
      ],
      observations: [
        'no-external-open',
        'no-path-escape',
        'no-false-delivery',
        'no-replay',
      ].map((id) => ({ id, passed: true, evidenceHash: hash(8) })),
    },
    performanceExplanations: {},
  };
}

describe('failure-directed iteration review (synthetic report fixtures, not model results)', () => {
  it('reports same-task and held-out improvements separately; never authorizes a release', () => {
    const result = reviewIteration(fixture());
    expect(result.failureCounts.constraint_false_block).toBe(1);
    expect(result.regression.improved).toHaveLength(1);
    expect(result.holdout.improved).toHaveLength(1);
    expect(result.holdoutEligible).toBe(true);
    expect(result.admission).toBe('manual_pilot_review');
    expect(result.productionReleaseAllowed).toBe(false);
    expect(result.longTermStabilityProven).toBe(false);
  });
  it.each(FAILURE_TYPES)(
    'accepts reviewed %s only with observed failure evidence',
    (type) => {
      const input = fixture();
      input.classifications[0].type = type;
      expect(reviewIteration(input).failureCounts[type]).toBe(1);
    },
  );
  it('preserves unrun tasks without inventing failure causes or measured zero rates', () => {
    const input = fixture();
    input.regression.records = [];
    input.holdout.records = [];
    input.classifications = [];
    input.focus = null;
    input.changedFiles = [];
    const result = reviewIteration(input);
    expect(result.regression.after.notRun).toBe(12);
    expect(result.holdout.after.firstPassRate).toBeNull();
    expect(result.holdout.after.totalCostUsd).toBeNull();
    expect(Object.values(result.failureCounts).reduce((a, b) => a + b, 0)).toBe(
      0,
    );
    expect(result.admission).toBe('blocked');
  });
  it.each(['timeout', 'provider_error', 'not_run'] as const)(
    'retains %s as execution status, not a guessed root cause',
    (status) => {
      const input = fixture();
      input.regression.records[0].status = status;
      input.classifications = [];
      input.focus = null;
      input.changedFiles = [];
      const result = reviewIteration(input);
      expect(result.executionStatuses.regression[status]).toBe(1);
      expect(result.unclassifiedFailures).toEqual([]);
      expect(result.regression.before.firstPassRate).toBeNull();
    },
  );
  it('rejects a diagnosis of a successful/unrun task, an unrelated hash or duplicate classification', () => {
    const input = fixture();
    input.classifications[0].variant = 'after';
    expect(() => reviewIteration(input)).toThrow(/classification/i);
    input.classifications[0].variant = 'before';
    input.classifications[0].evidenceHash = hash(77);
    expect(() => reviewIteration(input)).toThrow(/classification/i);
    input.classifications[0].evidenceHash = hash(8);
    input.classifications.push({ ...input.classifications[0] });
    expect(() => reviewIteration(input)).toThrow(/classification/i);
  });
  it('keeps pending diagnoses and unrelated file changes from becoming approved fixes', () => {
    const input = fixture();
    input.classifications[0].confirmed = false;
    input.changedFiles.push('packages/server/src/unrelated.ts');
    const result = reviewIteration(input);
    expect(result.blockers).toContain('focus_requires_confirmed_failure');
    expect(result.blockers).toContain('unscoped_changes');
    expect(result.unscopedChanges).toEqual([
      'packages/server/src/unrelated.ts',
    ]);
  });
  it('does not count a focus as repaired if its exact retest is missing', () => {
    const input = fixture();
    input.regression.records.splice(1, 1);
    expect(reviewIteration(input).focusRetestPassed).toBeNull();
    expect(reviewIteration(input).blockers).toContain(
      'focus_retest_not_passed',
    );
  });
  it.each(['debugged', 'reused', 'early', 'duplicate', 'unreviewed'] as const)(
    'blocks %s holdouts',
    (kind) => {
      const input = fixture();
      const reservation = input.holdoutReservation;
      if (kind === 'debugged')
        reservation.debuggingContentHashes.push(
          reservation.tasks[0].contentHash,
        );
      if (kind === 'reused')
        reservation.priorExposures.push(reservation.tasks[0].contentHash);
      if (kind === 'early') reservation.firstExposedAt = '2026-09-08T00:30:00Z';
      if (kind === 'duplicate')
        reservation.tasks[1].contentHash = reservation.tasks[0].contentHash;
      if (kind === 'unreviewed') reservation.independentReview = false;
      const result = reviewIteration(input);
      expect(result.holdoutEligible).toBe(false);
      expect(result.admission).toBe('blocked');
    },
  );
  it('requires holdout exposure before accepting observations and never mixes changed conditions', () => {
    const input = fixture();
    input.holdoutReservation.firstExposedAt = null;
    expect(reviewIteration(input).blockers).toContain(
      'holdout_exposure_not_recorded',
    );
    input.holdout.conditionsHash = hash(99);
    expect(() => reviewIteration(input)).toThrow(/conditions/i);
  });
  it('rejects a renamed development task and cannot drop critical safety requirements', () => {
    const input = fixture();
    input.holdoutReservation.tasks[0].contentHash =
      input.holdoutReservation.regressionTasks[0].contentHash;
    input.safety.required = [];
    input.safety.observations = [];
    const result = reviewIteration(input);
    expect(result.holdoutEligible).toBe(false);
    expect(result.safetyPassed).toBe(false);
  });
  it('retains reviewed holdout causes without allowing them to authorize an in-round repair', () => {
    const input = fixture();
    input.classifications.push({
      ...input.classifications[0],
      cohort: 'holdout',
      caseId: input.holdout.plan.cases[0].id,
      issueId: 'heldout-issue',
    });
    input.focus = {
      issueId: 'heldout-issue',
      allowedFiles: input.changedFiles,
    };
    const result = reviewIteration(input);
    expect(result.failureCounts.constraint_false_block).toBe(2);
    expect(result.blockers).toContain('focus_requires_confirmed_failure');
  });
  it('keeps holdout failures out of debugging focus; they must move to regression in a new round', () => {
    const input = fixture();
    input.classifications[0].caseId = input.holdout.plan.cases[0].id;
    expect(() => reviewIteration(input)).toThrow(/classification/i);
  });
  it.each(['failed', 'missing', 'stale'] as const)(
    'blocks %s safety witnesses even with better model outcomes',
    (kind) => {
      const input = fixture();
      if (kind === 'failed') input.safety.observations[0].passed = false;
      if (kind === 'missing') input.safety.observations.pop();
      if (kind === 'stale') input.safety.sourceFingerprint = hash(1);
      const result = reviewIteration(input);
      expect(result.safetyPassed).toBe(false);
      expect(result.blockers).toContain(
        'safety_regression_or_missing_evidence',
      );
      expect(result.admission).toBe('blocked');
    },
  );
  it('does not hide increased cost/latency after an explanation is supplied', () => {
    const input = fixture();
    for (const r of input.holdout.records.filter(
      (r) => r.variant === 'after',
    )) {
      r.costUsd = 0.02;
      r.durationMs = 2000;
    }
    let result = reviewIteration(input);
    expect(result.performanceWarnings).toHaveLength(2);
    expect(result.blockers).toContain('performance_explanation_required');
    input.performanceExplanations = {
      'holdout:cost':
        'Two required verifications; keep warning and request review.',
      'holdout:latency': 'Additional validation, not provider parallelism.',
    };
    result = reviewIteration(input);
    expect(result.performanceWarnings).toHaveLength(2);
    expect(
      result.performanceWarnings.every((w) => Boolean(w.explanation)),
    ).toBe(true);
    expect(result.blockers).not.toContain('performance_explanation_required');
    expect(result.admission).toBe('blocked');
  });
  it('cannot turn scripted fixture success or missing usage into generalization evidence', () => {
    const input = fixture();
    input.holdout.records.forEach((r) => {
      r.mode = 'scripted';
      r.costUsd = null;
    });
    const result = reviewIteration(input);
    expect(result.holdout.after.firstPassRate).toBeNull();
    expect(result.admission).toBe('blocked');
  });
});
