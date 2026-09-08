/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildRunSchedule,
  initialRunSlots,
  sourceChanges,
  assertPlanIdentity,
} from '../agent-experiment-plan.mjs';
const dataset = () =>
  JSON.parse(
    readFileSync('packages/evals/baselines/stage7-real-tasks-v1.json', 'utf8'),
  );
const hash = (letter) => letter.repeat(64);
const identity = () => ({
  beforeSource: hash('a'),
  afterSource: hash('b'),
  repeats: 1,
  order: buildRunSchedule(dataset(), 24),
});
it('fixes all 24 slots and interleaves variants before any results exist', () => {
  const order = buildRunSchedule(dataset(), 24);
  expect(order).toHaveLength(24);
  expect(order.slice(0, 4)).toEqual([
    { caseId: 'login-retry', repeat: 1, variant: 'before' },
    { caseId: 'login-retry', repeat: 1, variant: 'after' },
    { caseId: 'utc-display', repeat: 1, variant: 'after' },
    { caseId: 'utc-display', repeat: 1, variant: 'before' },
  ]);
  const slots = initialRunSlots(identity(), hash('c'));
  expect(slots).toHaveLength(24);
  expect(new Set(slots.map((s) => s.runId)).size).toBe(24);
  for (const slot of slots) {
    expect(slot).toMatchObject({
      status: 'not_run',
      attempted: false,
      rawResult: null,
      elapsedMs: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      independentPass: null,
      falseDelivery: null,
      interactions: {
        approvals: null,
        necessaryClarifications: null,
        plannedSteering: null,
        correctiveNudges: null,
      },
    });
    expect(slot.sourceFingerprint).toBe(
      slot.variant === 'before' ? hash('a') : hash('b'),
    );
  }
});
it('does not silently omit repeats or allow a batch beyond the fixed budget', () => {
  const twice = { ...dataset(), repeats: 2 };
  expect(() => buildRunSchedule(twice, 24)).toThrow(/budget/);
  const order = buildRunSchedule(twice, 48);
  expect(order).toHaveLength(48);
  expect(order.filter((s) => s.repeat === 2)).toHaveLength(24);
});
it('rejects duplicate cases, incomplete families, invalid repeats and identifiers', () => {
  for (const change of [
    { repeats: 0 },
    { repeats: 1.5 },
    { repeats: 4 },
    { cases: dataset().cases.slice(1) },
    { cases: [...dataset().cases, dataset().cases[0]] },
    {
      cases: dataset().cases.map((c, i) =>
        i === 0 ? { ...c, id: '../escape' } : c,
      ),
    },
  ])
    expect(() => buildRunSchedule({ ...dataset(), ...change }, 100)).toThrow();
});
it('records added, deleted and same-length modified bytes across every source area', () => {
  const before = [
    { path: 'packages/server/runtime.ts', sha256: hash('a') },
    { path: 'old.ts', sha256: hash('a') },
  ];
  const after = [
    { path: 'packages/server/runtime.ts', sha256: hash('b') },
    { path: 'packages/desktop/recruitment.ts', sha256: hash('b') },
  ];
  expect(sourceChanges(before, after)).toEqual([
    {
      path: 'old.ts',
      change: 'deleted',
      beforeSha256: hash('a'),
      afterSha256: null,
    },
    {
      path: 'packages/desktop/recruitment.ts',
      change: 'added',
      beforeSha256: null,
      afterSha256: hash('b'),
    },
    {
      path: 'packages/server/runtime.ts',
      change: 'modified',
      beforeSha256: hash('a'),
      afterSha256: hash('b'),
    },
  ]);
});
it('refuses duplicate file manifests and a plan that disagrees with its sealed identity', () => {
  expect(() =>
    sourceChanges(
      [
        { path: 'a', sha256: hash('a') },
        { path: 'a', sha256: hash('b') },
      ],
      [],
    ),
  ).toThrow();
  const id = identity();
  const plan = {
    ...id,
    cases: dataset().cases.map(({ id, family, critical }) => ({
      id,
      family,
      critical,
    })),
  };
  expect(() => assertPlanIdentity(plan, id)).not.toThrow();
  for (const change of [
    { beforeSource: hash('d') },
    { afterSource: hash('d') },
    { repeats: 2 },
    { cases: plan.cases.slice(1) },
  ])
    expect(() => assertPlanIdentity({ ...plan, ...change }, id)).toThrow();
});
