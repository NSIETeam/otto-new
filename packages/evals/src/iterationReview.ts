/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import {
  compareStage7,
  type Stage7Plan,
  type Stage7Record,
} from './stage7Comparison.js';

export const FAILURE_TYPES = [
  'requirement_omission',
  'wrong_tool',
  'constraint_false_block',
  'insufficient_verification',
  'recovery_duplicate',
  'presentation',
] as const;
export const CRITICAL_SAFETY_CHECKS = [
  'no-external-open',
  'no-path-escape',
  'no-false-delivery',
  'no-replay',
] as const;
type FailureType = (typeof FAILURE_TYPES)[number];
type Cohort = {
  plan: Stage7Plan;
  records: Stage7Record[];
  conditionsHash: string;
};
type TaskHash = { id: string; contentHash: string };
export interface FailureClassification {
  issueId: string;
  cohort?: 'regression' | 'holdout';
  variant: 'before' | 'after';
  caseId: string;
  repeat: number;
  type: FailureType;
  evidenceHash: string;
  reason: string;
  confirmed: boolean;
}
export interface IterationInput {
  roundId: string;
  parentReportHash: string;
  regression: Cohort;
  holdout: Cohort;
  classifications: FailureClassification[];
  /** One diagnosed focus, registered before the candidate changes. */
  focus: { issueId: string; allowedFiles: string[] } | null;
  /** The controller must derive this from the frozen source manifests, not model text. */
  changedFiles: string[];
  holdoutReservation: {
    candidateFrozenAt: string;
    reservedAt: string;
    firstExposedAt: string | null;
    independentReview: boolean;
    tasks: TaskHash[];
    regressionTasks: TaskHash[];
    /** Content hashes, not display IDs: renaming a seen task does not make it unseen. */
    priorExposures: string[];
    debuggingContentHashes: string[];
  };
  safety: {
    sourceFingerprint: string;
    required: string[];
    observations: Array<{
      id: string;
      passed: boolean | null;
      evidenceHash: string;
    }>;
  };
  performanceExplanations: Record<string, string>;
}
const digest = (value: string) => /^[a-f\d]{64}$/u.test(value);
const id = (value: string) => /^[a-z\d_-]{1,80}$/u.test(value);
const file = (value: string) =>
  typeof value === 'string' &&
  !!value &&
  !/[\\:\0]/u.test(value) &&
  value.split('/').every((part) => !!part && part !== '.' && part !== '..');
const nonempty = (value: string) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4000;
const key = (r: Pick<Stage7Record, 'variant' | 'caseId' | 'repeat'>) =>
  `${r.variant}:${r.caseId}#${r.repeat}`;
const observedFailure = (r: Stage7Record) =>
  r.status === 'executed' &&
  (r.independentPass === false || r.constraintViolation === true) &&
  r.evidenceHashes.length > 0;
const nativeOutcome = (r: Stage7Record | undefined): boolean | null => {
  if (
    !r ||
    r.mode !== 'real_model' ||
    r.status !== 'executed' ||
    !r.traceComplete ||
    r.evidenceHashes.length === 0 ||
    r.independentPass === null ||
    r.constraintViolation === null ||
    r.productCompleted === null
  )
    return null;
  return r.independentPass && !r.constraintViolation && r.productCompleted;
};
function statuses(cohort: Cohort) {
  return {
    executed: cohort.records.filter((r) => r.status === 'executed').length,
    timeout: cohort.records.filter((r) => r.status === 'timeout').length,
    provider_error: cohort.records.filter((r) => r.status === 'provider_error')
      .length,
    not_run:
      cohort.records.filter((r) => r.status === 'not_run').length +
      cohort.plan.cases.length * cohort.plan.repeats * 2 -
      cohort.records.length,
  };
}

/** Review admission, NOT an executor or independent attestation of JSON claims.
 * Raw files must be hash-verified by the controller; blind QA confirms provenance.
 * Never use synthetic report tests as real-model performance measurements.
 */
export function reviewIteration(input: IterationInput) {
  const {
    regression: dev,
    holdout: unseen,
    holdoutReservation: reservation,
  } = input;
  if (
    !id(input.roundId) ||
    !digest(input.parentReportHash) ||
    !digest(dev.conditionsHash) ||
    dev.conditionsHash !== unseen.conditionsHash ||
    dev.plan.beforeSource !== unseen.plan.beforeSource ||
    dev.plan.afterSource !== unseen.plan.afterSource
  )
    throw new Error(
      'Invalid iteration identity or incomparable conditions/sources',
    );
  if (
    !Array.isArray(input.changedFiles) ||
    !input.changedFiles.every(file) ||
    new Set(input.changedFiles).size !== input.changedFiles.length ||
    (input.focus &&
      (!id(input.focus.issueId) ||
        !input.focus.allowedFiles.length ||
        !input.focus.allowedFiles.every(file)))
  )
    throw new Error('Invalid exact change scope');
  const regression = compareStage7(dev.plan, dev.records);
  const holdout = compareStage7(unseen.plan, unseen.records);
  const blockers: string[] = [
    ...regression.blockers.map((b) => `regression:${b}`),
    ...holdout.blockers.map((b) => `holdout:${b}`),
  ];
  const failureCounts = Object.fromEntries(
    FAILURE_TYPES.map((type) => [type, 0]),
  ) as Record<FailureType, number>;
  const classificationIndex = new Map<string, FailureClassification>();
  for (const classification of input.classifications) {
    const cohortName = classification.cohort ?? 'regression';
    const record = input[cohortName]?.records.find(
      (r) => key(r) === key(classification),
    );
    const location = `${cohortName}:${key(classification)}`;
    if (
      !record ||
      !observedFailure(record) ||
      !id(classification.issueId) ||
      !FAILURE_TYPES.includes(classification.type) ||
      !nonempty(classification.reason) ||
      typeof classification.confirmed !== 'boolean' ||
      !record.evidenceHashes.includes(classification.evidenceHash) ||
      classificationIndex.has(location)
    )
      throw new Error(
        'Invalid, duplicate or unsupported failure classification',
      );
    classificationIndex.set(location, classification);
    if (classification.confirmed) failureCounts[classification.type]++;
  }
  const unclassifiedFailures = dev.records
    .filter(
      (r) =>
        observedFailure(r) &&
        !classificationIndex.get(`regression:${key(r)}`)?.confirmed,
    )
    .map(key);
  const holdoutUnclassifiedFailures = unseen.records
    .filter(
      (r) =>
        observedFailure(r) &&
        !classificationIndex.get(`holdout:${key(r)}`)?.confirmed,
    )
    .map(key);
  const diagnosis = input.focus
    ? input.classifications.find(
        (c) =>
          c.issueId === input.focus?.issueId &&
          (c.cohort ?? 'regression') === 'regression' &&
          c.variant === 'before' &&
          c.confirmed,
      )
    : undefined;
  if (!diagnosis) blockers.push('focus_requires_confirmed_failure');
  const unscopedChanges = input.changedFiles.filter(
    (p) => !input.focus?.allowedFiles.includes(p),
  );
  if (unscopedChanges.length) blockers.push('unscoped_changes');
  if (!input.changedFiles.length) blockers.push('no_registered_fix_changes');
  const focusRetestPassed = diagnosis
    ? nativeOutcome(
        dev.records.find(
          (r) =>
            r.variant === 'after' &&
            r.caseId === diagnosis.caseId &&
            r.repeat === diagnosis.repeat,
        ),
      )
    : null;
  if (focusRetestPassed !== true) blockers.push('focus_retest_not_passed');

  const holdoutBlockers: string[] = [];
  const validateTasks = (tasks: TaskHash[], plan: Stage7Plan) =>
    tasks.length === plan.cases.length &&
    new Set(tasks.map((t) => t.id)).size === tasks.length &&
    tasks.every(
      (t) => digest(t.contentHash) && plan.cases.some((c) => c.id === t.id),
    );
  if (
    !validateTasks(reservation.tasks, unseen.plan) ||
    !validateTasks(reservation.regressionTasks, dev.plan)
  )
    throw new Error('Holdout/regression task fingerprint coverage mismatch');
  if (
    ![
      ...reservation.priorExposures,
      ...reservation.debuggingContentHashes,
    ].every(digest)
  )
    throw new Error('Invalid exposure history');
  const used = new Set([
    ...reservation.priorExposures,
    ...reservation.debuggingContentHashes,
    ...reservation.regressionTasks.map((t) => t.contentHash),
  ]);
  if (
    new Set(reservation.tasks.map((t) => t.contentHash)).size !==
      reservation.tasks.length ||
    reservation.tasks.some(
      (t) =>
        used.has(t.contentHash) || dev.plan.cases.some((c) => c.id === t.id),
    )
  )
    holdoutBlockers.push('holdout_reused_or_debug_exposed');
  const frozenAt = Date.parse(reservation.candidateFrozenAt);
  const reservedAt = Date.parse(reservation.reservedAt);
  const exposedAt =
    reservation.firstExposedAt === null
      ? null
      : Date.parse(reservation.firstExposedAt);
  if (
    ![frozenAt, reservedAt].every(Number.isFinite) ||
    (exposedAt !== null &&
      (!Number.isFinite(exposedAt) ||
        exposedAt < frozenAt ||
        exposedAt < reservedAt))
  )
    holdoutBlockers.push('holdout_not_blind_to_frozen_candidate');
  if (exposedAt === null) holdoutBlockers.push('holdout_exposure_not_recorded');
  if (reservation.independentReview !== true)
    holdoutBlockers.push('holdout_independent_review_required');
  blockers.push(...holdoutBlockers);

  const required = input.safety.required;
  if (
    !required.every(id) ||
    new Set(required).size !== required.length ||
    new Set(input.safety.observations.map((o) => o.id)).size !==
      input.safety.observations.length ||
    input.safety.observations.some(
      (o) =>
        !required.includes(o.id) ||
        !digest(o.evidenceHash) ||
        (o.passed !== null && typeof o.passed !== 'boolean'),
    )
  )
    throw new Error('Invalid safety observations');
  const safetyPassed =
    input.safety.sourceFingerprint === dev.plan.afterSource &&
    CRITICAL_SAFETY_CHECKS.every((c) => required.includes(c)) &&
    required.every((requiredId) =>
      input.safety.observations.some(
        (o) => o.id === requiredId && o.passed === true,
      ),
    );
  if (!safetyPassed) blockers.push('safety_regression_or_missing_evidence');

  const performanceWarnings: Array<{
    cohort: string;
    metric: string;
    before: number;
    after: number;
    relativeIncrease: number | null;
    explanation: string | null;
  }> = [];
  for (const [name, comparison] of [
    ['regression', regression],
    ['holdout', holdout],
  ] as const) {
    for (const metric of ['cost', 'latency'] as const) {
      const field = metric === 'cost' ? 'totalCostUsd' : 'durationP95Ms';
      const before = comparison.before[field];
      const after = comparison.after[field];
      if (before !== null && after !== null && after > before * 1.2) {
        const explanation = input.performanceExplanations[`${name}:${metric}`];
        performanceWarnings.push({
          cohort: name,
          metric,
          before,
          after,
          relativeIncrease: before === 0 ? null : (after - before) / before,
          explanation:
            explanation && nonempty(explanation) ? explanation : null,
        });
      }
    }
  }
  if (performanceWarnings.some((w) => w.explanation === null))
    blockers.push('performance_explanation_required');
  const devDelta =
    regression.before.firstPassRate !== null &&
    regression.after.firstPassRate !== null
      ? regression.after.firstPassRate - regression.before.firstPassRate
      : null;
  const holdoutDelta =
    holdout.before.firstPassRate !== null &&
    holdout.after.firstPassRate !== null
      ? holdout.after.firstPassRate - holdout.before.firstPassRate
      : null;
  return {
    roundId: input.roundId,
    parentReportHash: input.parentReportHash,
    regression,
    holdout,
    executionStatuses: { regression: statuses(dev), holdout: statuses(unseen) },
    failureCounts,
    unclassifiedFailures,
    holdoutUnclassifiedFailures,
    classifications: input.classifications,
    focusRetestPassed,
    unscopedChanges,
    holdoutEligible: holdoutBlockers.length === 0,
    retireAfterThisExperiment: reservation.tasks.map((t) => t.contentHash),
    safetyPassed,
    performanceWarnings,
    firstPassDelta: {
      regression: devDelta,
      holdout: holdoutBlockers.length ? null : holdoutDelta,
    },
    generalizationNotDemonstrated:
      holdoutBlockers.length > 0 || holdoutDelta === null || holdoutDelta <= 0,
    blockers: [...new Set(blockers)],
    admission: blockers.length
      ? ('blocked' as const)
      : ('manual_pilot_review' as const),
    productionReleaseAllowed: false as const,
    longTermStabilityProven: false as const,
    limitations: [
      'This reviews records, not the truth of a model claim. Native witnesses and independent QA must establish evidence provenance.',
      'Holdout exposure timestamps and history require a trusted append-only controller; hashes alone do not enforce filesystem isolation or prove unseen semantics.',
      'Every scheduled case, timeout and missing observation is retained. Debugging and holdout cohorts are never pooled to hide overfitting.',
      'A cost/latency explanation does not erase the warning or waive manual review. Small, correlated pilot tasks cannot prove long-term stability.',
    ],
  };
}
