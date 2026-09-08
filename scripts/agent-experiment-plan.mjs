/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
 * Pure experiment bookkeeping. Does not run tasks or assess model quality.
 */
import { isDeepStrictEqual } from 'node:util';
import { safeRelative } from './agent-experiment-files.mjs';
const families = [
  'code_repair',
  'file_delivery',
  'gui',
  'restart',
  'steering',
  'enterprise',
];
const validHash = (value) =>
  typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
export function buildRunSchedule(dataset, maxRuns) {
  if (
    !Number.isInteger(dataset.repeats) ||
    dataset.repeats < 1 ||
    dataset.repeats > 3 ||
    !Array.isArray(dataset.cases) ||
    !Number.isInteger(maxRuns) ||
    maxRuns < 1
  )
    throw new Error('Invalid experiment cases/repeats/budget');
  const ids = new Set();
  for (const c of dataset.cases) {
    if (
      typeof c.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,79}$/u.test(c.id) ||
      ids.has(c.id) ||
      !families.includes(c.family) ||
      typeof c.critical !== 'boolean'
    )
      throw new Error('Invalid or duplicate experiment case');
    ids.add(c.id);
  }
  if (
    families.some(
      (family) => dataset.cases.filter((c) => c.family === family).length < 2,
    )
  )
    throw new Error('All six families require at least two distinct cases');
  if (dataset.cases.length * 2 * dataset.repeats > maxRuns)
    throw new Error('Experiment exceeds fixed batch run budget');
  return Array.from({ length: dataset.repeats }, (_, r) =>
    dataset.cases.flatMap((c, index) =>
      ((index + r) % 2 ? ['after', 'before'] : ['before', 'after']).map(
        (variant) => ({
          caseId: c.id,
          repeat: r + 1,
          variant,
        }),
      ),
    ),
  ).flat();
}
export function assertPlanIdentity(plan, identity) {
  if (
    !validHash(plan.beforeSource) ||
    !validHash(plan.afterSource) ||
    plan.beforeSource !== identity.beforeSource ||
    plan.afterSource !== identity.afterSource ||
    plan.repeats !== identity.repeats ||
    !isDeepStrictEqual(
      buildRunSchedule(plan, identity.order.length),
      identity.order,
    )
  )
    throw new Error('Plan disagrees with sealed experiment identity');
}
export function initialRunSlots(identity, experimentHash) {
  if (
    ![identity.beforeSource, identity.afterSource, experimentHash].every(
      validHash,
    )
  )
    throw new Error('Missing experiment/source fingerprint');
  return identity.order.map((run, index) => ({
    ...run,
    runId: `${experimentHash}:${String(index + 1).padStart(3, '0')}`,
    ordinal: index + 1,
    experimentHash,
    sourceFingerprint: identity[`${run.variant}Source`],
    expectedMode: 'real_model',
    actualMode: null,
    status: 'not_run',
    attempted: false,
    startedAt: null,
    endedAt: null,
    elapsedMs: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    independentPass: null,
    falseDelivery: null,
    rawResult: null,
    interactions: {
      approvals: null,
      necessaryClarifications: null,
      plannedSteering: null,
      correctiveNudges: null,
    },
  }));
}
export function sourceChanges(before, after) {
  function entries(files) {
    const map = new Map();
    for (const file of files) {
      safeRelative(file.path);
      if (map.has(file.path) || !validHash(file.sha256))
        throw new Error('Invalid source manifest entries');
      map.set(file.path, file.sha256);
    }
    return map;
  }
  const a = entries(before),
    b = entries(after);
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((file) => {
    const beforeSha256 = a.get(file) ?? null,
      afterSha256 = b.get(file) ?? null;
    return beforeSha256 === afterSha256
      ? []
      : [
          {
            path: file,
            change:
              beforeSha256 === null
                ? 'added'
                : afterSha256 === null
                  ? 'deleted'
                  : 'modified',
            beforeSha256,
            afterSha256,
          },
        ];
  });
}
