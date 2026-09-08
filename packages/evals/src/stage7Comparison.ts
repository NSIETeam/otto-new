/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
export const STAGE7_FAMILIES = [
  'code_repair',
  'file_delivery',
  'gui',
  'restart',
  'steering',
  'enterprise',
] as const;
export type Stage7Family = (typeof STAGE7_FAMILIES)[number];
export interface Stage7Plan {
  beforeSource: string;
  afterSource: string;
  /** Hash of fixed model/revision/endpoint/prices/budget, environment, tools, grader and dataset. */
  experimentHash: string;
  cases: Array<{ id: string; family: Stage7Family; critical: boolean }>;
  repeats: number;
}
export interface Stage7Record {
  variant: 'before' | 'after';
  caseId: string;
  repeat: number;
  sourceFingerprint: string;
  experimentHash: string;
  mode: 'real_model' | 'scripted' | 'data_smoke';
  status: 'executed' | 'timeout' | 'provider_error' | 'not_run';
  independentPass: boolean | null;
  productCompleted: boolean | null;
  constraintViolation: boolean | null;
  traceComplete: boolean;
  correctiveFollowups: number | null;
  clarificationRequests: number | null;
  approvalRequests: number | null;
  durationMs: number | null;
  costUsd: number | null;
  evidenceHashes: string[];
  humanReview: 'approved' | 'rejected' | 'pending';
}
const digest = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f\d]{64}$/u.test(s);
const count = (n: number | null) =>
  n === null || (Number.isSafeInteger(n) && n >= 0);
const measured = (r: Stage7Record) =>
  r.status === 'executed' &&
  r.mode === 'real_model' &&
  r.traceComplete &&
  r.evidenceHashes.length > 0;
const observable = (r: Stage7Record) =>
  measured(r) &&
  r.independentPass !== null &&
  r.productCompleted !== null &&
  r.constraintViolation !== null;
const passed = (r: Stage7Record) =>
  measured(r) &&
  r.independentPass === true &&
  r.productCompleted === true &&
  r.constraintViolation === false;
const sum = (values: Array<number | null>) =>
  values.length && values.every((n) => n !== null)
    ? (values as number[]).reduce((a, b) => a + b, 0)
    : null;
function upper95(failures: number, n: number) {
  if (!n) return null;
  const z2 = 1.96 ** 2;
  const p = failures / n;
  return (
    (p +
      z2 / (2 * n) +
      1.96 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) /
    (1 + z2 / n)
  );
}
function summary(records: Stage7Record[]) {
  const observed = records.filter(observable);
  const falseDeliveries = observed.filter(
    (r) =>
      r.productCompleted === true &&
      (r.independentPass === false || r.constraintViolation === true),
  ).length;
  const firstPasses = records.filter(
    (r) => passed(r) && r.correctiveFollowups === 0,
  ).length;
  const times = records
    .flatMap((r) => (r.durationMs === null ? [] : [r.durationMs]))
    .sort((a, b) => a - b);
  return {
    scheduled: records.length,
    executed: records.filter((r) => r.status === 'executed').length,
    notRun: records.filter((r) => r.status === 'not_run').length,
    knownOutcomes: observed.length,
    passed: records.filter(passed).length,
    firstPasses,
    // The lower bound keeps all scheduled runs in the denominator without
    // presenting missing observations as a measured zero-percent score.
    confirmedFirstPassLowerBound: records.length
      ? firstPasses / records.length
      : null,
    firstPassRate:
      records.length &&
      observed.length === records.length &&
      records.every((r) => r.correctiveFollowups !== null)
        ? firstPasses / records.length
        : null,
    falseDeliveries,
    falseDeliveryRate:
      observed.length === records.length && records.length
        ? falseDeliveries / records.length
        : null,
    falseDeliveryUpper95:
      observed.length === records.length
        ? upper95(falseDeliveries, observed.length)
        : null,
    totalCostUsd: sum(records.map((r) => r.costUsd)),
    correctiveFollowups: sum(records.map((r) => r.correctiveFollowups)),
    clarificationRequests: sum(records.map((r) => r.clarificationRequests)),
    approvalRequests: sum(records.map((r) => r.approvalRequests)),
    durationMeasured: times.length,
    durationP50Ms: times.length
      ? times[Math.ceil(times.length * 0.5) - 1]
      : null,
    durationP95Ms: times.length
      ? times[Math.ceil(times.length * 0.95) - 1]
      : null,
  };
}

/** Report admission only, not an executor or an attestation that imported observations are true.
 * Human QA must inspect the referenced native evidence; this never releases software.
 */
export function compareStage7(
  plan: Stage7Plan,
  records: readonly Stage7Record[],
) {
  if (
    ![plan.beforeSource, plan.afterSource, plan.experimentHash].every(digest) ||
    plan.beforeSource === plan.afterSource ||
    !Number.isSafeInteger(plan.repeats) ||
    plan.repeats < 1 ||
    plan.repeats > 3 ||
    !plan.cases.length ||
    plan.cases.length * plan.repeats * 2 > 24 ||
    new Set(plan.cases.map((c) => c.id)).size !== plan.cases.length ||
    plan.cases.some(
      (c) =>
        !/^[a-z\d_-]{1,80}$/u.test(c.id) ||
        !STAGE7_FAMILIES.includes(c.family) ||
        typeof c.critical !== 'boolean',
    )
  )
    throw new Error('Invalid fixed plan');
  const ids = new Set(plan.cases.map((c) => c.id));
  const index = new Map<string, Stage7Record>();
  for (const r of records) {
    const key = `${r.variant}:${r.caseId}#${r.repeat}`;
    if (
      index.has(key) ||
      !['before', 'after'].includes(r.variant) ||
      !ids.has(r.caseId) ||
      !Number.isSafeInteger(r.repeat) ||
      r.repeat < 1 ||
      r.repeat > plan.repeats
    )
      throw new Error('Unplanned or duplicate observation');
    if (
      r.sourceFingerprint !==
        (r.variant === 'before' ? plan.beforeSource : plan.afterSource) ||
      r.experimentHash !== plan.experimentHash
    )
      throw new Error('Incomparable source or experiment');
    if (
      ![r.costUsd, r.durationMs].every(
        (n) =>
          n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0),
      ) ||
      ![
        r.correctiveFollowups,
        r.clarificationRequests,
        r.approvalRequests,
      ].every(count) ||
      ![r.independentPass, r.productCompleted, r.constraintViolation].every(
        (n) => n === null || typeof n === 'boolean',
      ) ||
      typeof r.traceComplete !== 'boolean' ||
      !Array.isArray(r.evidenceHashes) ||
      !r.evidenceHashes.every(digest) ||
      !['executed', 'timeout', 'provider_error', 'not_run'].includes(
        r.status,
      ) ||
      !['real_model', 'scripted', 'data_smoke'].includes(r.mode) ||
      !['approved', 'rejected', 'pending'].includes(r.humanReview)
    )
      throw new Error('Invalid observations');
    index.set(key, r);
  }
  const groups: Record<'before' | 'after', Stage7Record[]> = {
    before: [],
    after: [],
  };
  for (const variant of ['before', 'after'] as const)
    for (const c of plan.cases)
      for (let repeat = 1; repeat <= plan.repeats; repeat++) {
        groups[variant].push(
          index.get(`${variant}:${c.id}#${repeat}`) ?? {
            variant,
            caseId: c.id,
            repeat,
            sourceFingerprint:
              variant === 'before' ? plan.beforeSource : plan.afterSource,
            experimentHash: plan.experimentHash,
            status: 'not_run',
            mode: 'real_model',
            independentPass: null,
            productCompleted: null,
            constraintViolation: null,
            traceComplete: false,
            correctiveFollowups: null,
            clarificationRequests: null,
            approvalRequests: null,
            durationMs: null,
            costUsd: null,
            evidenceHashes: [],
            humanReview: 'pending',
          },
        );
      }
  const before = summary(groups.before);
  const after = summary(groups.after);
  const regressed = groups.before.flatMap((r, i) =>
    observable(r) &&
    observable(groups.after[i]) &&
    passed(r) &&
    !passed(groups.after[i])
      ? [`${r.caseId}#${r.repeat}`]
      : [],
  );
  const improved = groups.after.flatMap((r, i) =>
    observable(r) &&
    observable(groups.before[i]) &&
    passed(r) &&
    !passed(groups.before[i])
      ? [`${r.caseId}#${r.repeat}`]
      : [],
  );
  const all = [...groups.before, ...groups.after];
  const blockers: string[] = [];
  if (
    STAGE7_FAMILIES.some(
      (f) => plan.cases.filter((c) => c.family === f).length < 2,
    )
  )
    blockers.push('insufficient_family_coverage');
  if (
    all.some(
      (r) =>
        !measured(r) ||
        r.independentPass === null ||
        r.productCompleted === null ||
        r.constraintViolation === null,
    )
  )
    blockers.push('missing_real_observations');
  if (
    all.some(
      (r) =>
        r.costUsd === null ||
        r.durationMs === null ||
        r.correctiveFollowups === null ||
        r.clarificationRequests === null ||
        r.approvalRequests === null,
    )
  )
    blockers.push('missing_metrics');
  if (all.some((r) => r.humanReview !== 'approved'))
    blockers.push('human_qa_required');
  if (groups.after.some((r) => r.constraintViolation === true || !passed(r)))
    blockers.push('candidate_not_accepted');
  if (regressed.length) blockers.push('quality_regression');
  if (
    after.firstPassRate !== null &&
    before.firstPassRate !== null &&
    after.firstPassRate < before.firstPassRate
  )
    blockers.push('first_pass_regression');
  if (
    before.totalCostUsd !== null &&
    after.totalCostUsd !== null &&
    after.totalCostUsd > before.totalCostUsd * 1.2
  )
    blockers.push('cost_regression_over_20_percent');
  if (
    before.durationP95Ms !== null &&
    after.durationP95Ms !== null &&
    after.durationP95Ms > before.durationP95Ms * 1.2
  )
    blockers.push('latency_regression_over_20_percent');
  return {
    before,
    after,
    regressed,
    improved,
    blockers,
    admission: blockers.length
      ? ('blocked' as const)
      : ('manual_pilot_review' as const),
    productionReleaseAllowed: false as const,
    limitations: [
      'Report integrity is not semantic or provider attestation; native receipts and blind human QA remain required.',
      'At most 24 scheduled runs is a pilot, not proof of long-term reliability. Wilson bounds assume independent samples; repeated tasks can be correlated.',
      'No automatic publication, feature switch or production tenant action is performed.',
    ],
  };
}
