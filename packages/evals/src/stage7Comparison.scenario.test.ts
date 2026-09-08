/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  compareStage7,
  STAGE7_FAMILIES,
  type Stage7Plan,
  type Stage7Record,
} from './stage7Comparison.js';
const hash = (n: number) => n.toString(16).padStart(64, '0');
const plan = (): Stage7Plan => ({
  beforeSource: hash(1),
  afterSource: hash(2),
  experimentHash: hash(3),
  cases: STAGE7_FAMILIES.flatMap((family) =>
    [1, 2].map((i) => ({ id: `${family}-${i}`, family, critical: true })),
  ),
  repeats: 1,
});
const records = (): Stage7Record[] =>
  plan().cases.flatMap((c) =>
    (['before', 'after'] as const).map((variant) => ({
      variant,
      caseId: c.id,
      repeat: 1,
      sourceFingerprint: variant === 'before' ? hash(1) : hash(2),
      experimentHash: hash(3),
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
      evidenceHashes: [hash(4)],
      humanReview: 'approved',
    })),
  );
describe('paired real-task release admission (synthetic report fixtures only)', () => {
  it('keeps every planned run in the denominator; missing is not a pass or free', () => {
    const result = compareStage7(plan(), []);
    expect(result.after.scheduled).toBe(12);
    expect(result.after.notRun).toBe(12);
    expect(result.after.firstPassRate).toBeNull();
    expect(result.after.confirmedFirstPassLowerBound).toBe(0);
    expect(result.after.totalCostUsd).toBeNull();
    expect(result.after.falseDeliveryRate).toBeNull();
    expect(result.admission).toBe('blocked');
  });
  it('only recommends manual pilot review even when all observations pass', () => {
    const result = compareStage7(plan(), records());
    expect(result.admission).toBe('manual_pilot_review');
    expect(result.productionReleaseAllowed).toBe(false);
    expect(result.after.falseDeliveryUpper95).toBeGreaterThan(0.2);
    expect(result.after.totalCostUsd).toBeCloseTo(0.12);
  });
  it.each(['sourceFingerprint', 'experimentHash'] as const)(
    'rejects changed %s instead of comparing unlike conditions',
    (field) => {
      const data = records();
      data[0][field] = hash(99);
      expect(() => compareStage7(plan(), data)).toThrow();
    },
  );
  it('rejects duplicate, unknown or out-of-range run identities', () => {
    expect(() => compareStage7(plan(), [...records(), records()[0]])).toThrow();
    expect(() =>
      compareStage7(plan(), [{ ...records()[0], caseId: 'not-planned' }]),
    ).toThrow();
    expect(() =>
      compareStage7(plan(), [{ ...records()[0], repeat: 2 }]),
    ).toThrow();
  });
  it('catches false delivery, constraint violation and a before-to-after regression', () => {
    const data = records();
    data[1].independentPass = false;
    data[1].constraintViolation = true;
    const result = compareStage7(plan(), data);
    expect(result.after.falseDeliveries).toBe(1);
    expect(result.regressed).toContain('code_repair-1#1');
    expect(result.admission).toBe('blocked');
  });
  it.each(['scripted', 'data_smoke'] as const)(
    'cannot promote %s observations to real-task evidence',
    (mode) => {
      const data = records().map((r) => ({ ...r, mode }));
      expect(compareStage7(plan(), data).admission).toBe('blocked');
      expect(compareStage7(plan(), data).after.firstPassRate).toBeNull();
    },
  );
  it('treats incomplete monitoring and missing independent oracle as unknown', () => {
    const data = records();
    data[1].traceComplete = false;
    data[3].independentPass = null;
    expect(compareStage7(plan(), data).admission).toBe('blocked');
    expect(compareStage7(plan(), data).after.falseDeliveryRate).toBeNull();
  });
  it('does not confuse planned approval/clarification with corrective user nudges', () => {
    const data = records();
    data[1].approvalRequests = 1;
    data[1].clarificationRequests = 1;
    expect(compareStage7(plan(), data).after.firstPassRate).toBe(1);
    data[1].correctiveFollowups = 1;
    expect(compareStage7(plan(), data).after.firstPassRate).toBeLessThan(1);
  });
  it('does not admit a JSON-only sample without the other five families', () => {
    const p = plan();
    p.cases = p.cases.filter((c) => c.family === 'file_delivery');
    const result = compareStage7(
      p,
      records().filter((r) => r.caseId.startsWith('file_delivery')),
    );
    expect(result.admission).toBe('blocked');
    expect(result.blockers).toContain('insufficient_family_coverage');
  });
  it('unknown cost or unreviewed output blocks pilot admission', () => {
    const data = records();
    data[1].costUsd = null;
    data[3].humanReview = 'pending';
    expect(compareStage7(plan(), data).admission).toBe('blocked');
    expect(compareStage7(plan(), data).after.totalCostUsd).toBeNull();
  });
  it('rejects impossible metrics and counterfeit successful provider failures', () => {
    const data = records();
    data[0].costUsd = -1;
    expect(() => compareStage7(plan(), data)).toThrow();
    const failed = records();
    failed[1].status = 'provider_error';
    expect(compareStage7(plan(), failed).after.firstPassRate).toBeNull();
    expect(compareStage7(plan(), failed).admission).toBe('blocked');
  });
  it('does not label a missing baseline as an improvement, or a missing candidate as a regression', () => {
    const data = records().filter((r, i) => i !== 0 && i !== 3);
    const result = compareStage7(plan(), data);
    expect(result.improved).toEqual([]);
    expect(result.regressed).toEqual([]);
    expect(result.blockers).toContain('missing_real_observations');
  });
  it('includes violated negative constraints in false delivery even when a content oracle passed', () => {
    const data = records();
    data[1].constraintViolation = true;
    const result = compareStage7(plan(), data);
    expect(result.after.falseDeliveries).toBe(1);
    expect(result.after.falseDeliveryRate).toBeCloseTo(1 / 12);
  });
  it('unknown constraint observation cannot produce a zero false-delivery rate', () => {
    const data = records();
    data[1].constraintViolation = null;
    expect(compareStage7(plan(), data).after.falseDeliveryRate).toBeNull();
  });
});
