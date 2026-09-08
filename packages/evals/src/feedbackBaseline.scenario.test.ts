import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_BASELINE,
  baselineFingerprint,
  summarizeBaseline,
  compareBaselines,
} from './feedbackBaseline.js';

describe('reported-task baseline manifest and accounting (not model quality scores)', () => {
  it('reports false deliveries and measured intervention-free success, leaving unmeasured counts unknown', () => {
    const summary = summarizeBaseline([
      {
        id: 'a',
        passed: true,
        correct: true,
        completed: true,
        userInterventions: 0,
      },
      {
        id: 'b',
        passed: false,
        correct: false,
        completed: true,
        userInterventions: 2,
      },
      { id: 'c', passed: false },
    ]);
    expect(summary.falseDeliveries).toBe(1);
    expect(summary.interventions).toEqual({
      measured: 2,
      total: 2,
      firstPassSuccesses: 1,
      firstPassSuccessRate: 0.5,
    });
    expect(
      summarizeBaseline([{ id: 'unknown', passed: true }]).interventions
        .firstPassSuccessRate,
    ).toBeNull();
  });
  it('versions independent expected outputs and changes identity when the grader changes', () => {
    expect(FEEDBACK_BASELINE.length).toBeGreaterThanOrEqual(8);
    expect(new Set(FEEDBACK_BASELINE.map((c) => c.id)).size).toBe(
      FEEDBACK_BASELINE.length,
    );
    expect(baselineFingerprint(FEEDBACK_BASELINE)).toBe(
      baselineFingerprint(structuredClone(FEEDBACK_BASELINE)),
    );
    const changed = structuredClone(FEEDBACK_BASELINE);
    changed[0].expected = {};
    expect(baselineFingerprint(changed)).not.toBe(
      baselineFingerprint(FEEDBACK_BASELINE),
    );
  });
  it('includes failures in the denominator and does not treat missing costs as zero', () => {
    const summary = summarizeBaseline([
      {
        id: 'a',
        passed: true,
        correct: true,
        completed: true,
        durationMs: 10,
        estimatedCost: 0.01,
        closureAttempts: 1,
      },
      {
        id: 'a',
        passed: false,
        correct: true,
        completed: false,
        durationMs: 30,
        estimatedCost: null,
        closureAttempts: 2,
      },
      {
        id: 'b',
        passed: false,
        correct: false,
        completed: false,
        error: 'provider_failure',
      },
    ]);
    expect(summary.successRate).toBe(1 / 3);
    expect(summary.correctButIncomplete).toBe(1);
    expect(summary.durationMs).toEqual({ measured: 2, p50: 10, p95: 30 });
    expect(summary.totalEstimatedCost).toBeNull();
    expect(summary.failedCases).toEqual(['a', 'b']);
  });
  it('refuses apples-to-oranges comparisons and pairs case/repeat identities', () => {
    const report = {
      datasetHash: 'same',
      model: 'fixed-model',
      provider: 'provider',
      modelConfiguration: 'fixed-settings-hash',
      records: [{ id: 'a', repeat: 1, passed: false }],
    };
    expect(() =>
      compareBaselines(report, { ...report, datasetHash: 'changed' }),
    ).toThrow(/dataset/);
    expect(() =>
      compareBaselines(report, { ...report, model: 'changed' }),
    ).toThrow(/model/);
    expect(() =>
      compareBaselines(report, { ...report, modelConfiguration: 'changed' }),
    ).toThrow(/model/);
    expect(() => compareBaselines(report, { ...report, records: [] })).toThrow(
      /case/,
    );
    expect(
      compareBaselines(report, {
        ...report,
        records: [{ id: 'a', repeat: 1, passed: true }],
      }),
    ).toMatchObject({ compared: 1, improved: ['a#1'], regressed: [] });
  });

  it('compares measured experience, cost and token deltas, keeping missing measurements unknown', () => {
    const identity = {
      datasetHash: 'same',
      model: 'fixed',
      provider: 'same',
      modelConfiguration: 'hash',
    };
    const result = compareBaselines(
      {
        ...identity,
        records: [
          {
            id: 'a',
            passed: false,
            durationMs: 100,
            inputTokens: 900,
            firstVisibleTextMs: 5,
            unverifiedTextChunks: 2,
            estimatedCost: 0.02,
            userInterventions: 1,
          },
        ],
      },
      {
        ...identity,
        records: [
          {
            id: 'a',
            passed: true,
            durationMs: 80,
            inputTokens: 600,
            firstVisibleTextMs: 30,
            unverifiedTextChunks: 0,
            estimatedCost: 0.01,
            userInterventions: 0,
          },
        ],
      },
    );
    expect(result.deltas).toMatchObject({
      inputTokens: -300,
      durationMs: -20,
      firstVisibleTextMs: 25,
      unverifiedTextChunks: -2,
      estimatedCost: -0.01,
      userInterventions: -1,
      outputTokens: null,
    });
    expect(() =>
      compareBaselines(
        { ...identity, modelConfiguration: undefined, records: [] },
        { ...identity, modelConfiguration: undefined, records: [] },
      ),
    ).toThrow(/configuration/i);
  });
});
