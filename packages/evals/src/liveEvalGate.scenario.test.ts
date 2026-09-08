/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { liveEvalPreflight, LiveEvalBudget } from './liveEvalGate.js';

const configured = () => ({
  OTTO_LIVE_EVAL: '1',
  OTTO_EVAL_BASE_URL: 'https://fixture.invalid/v1',
  OTTO_EVAL_API_KEY: 'fixture-secret-not-a-real-key',
  OTTO_EVAL_MODEL: 'fixture-2026-09-01',
  OTTO_EVAL_MODEL_REVISION: 'fixture-2026-09-01',
  OTTO_EVAL_MAX_COST_USD: '2',
  OTTO_EVAL_CASE_COST_RESERVE_USD: '0.2',
  OTTO_EVAL_PROVIDER_CAP_CONFIRMED: '1',
  OTTO_EVAL_INPUT_PER_MILLION: '1',
  OTTO_EVAL_OUTPUT_PER_MILLION: '2',
});
describe('real evaluation admission (no network)', () => {
  it('pins public choices even without a credential or execution permission', () => {
    const result = liveEvalPreflight({
      ...configured(),
      OTTO_EVAL_API_KEY: '',
      OTTO_LIVE_EVAL: '',
      OTTO_EVAL_PROVIDER_CAP_CONFIRMED: '',
    });
    expect(result.ready).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.declaration.ready).toBe(true);
    expect(result.declaration.identity).toMatchObject({
      modelRevision: 'fixture-2026-09-01',
      maxCostUsd: 2,
    });
    expect(result.declaration.fingerprint).toBe(
      liveEvalPreflight(configured()).declaration.fingerprint,
    );
  });
  it('retains partial choices without turning absent prices into zero', () => {
    const result = liveEvalPreflight({ OTTO_EVAL_MODEL: 'fixture-2026-09-01' });
    expect(result.declaration.ready).toBe(false);
    expect(result.declaration.identity).toMatchObject({
      model: 'fixture-2026-09-01',
      modelRevision: null,
      inputPerMillion: null,
      maxCostUsd: null,
    });
    expect(result.declaration.missing).toContain('OTTO_EVAL_INPUT_PER_MILLION');
  });
  it('changes the public seal for a model, endpoint, price or budget change, never a key rotation', () => {
    const original = liveEvalPreflight(configured()).declaration.fingerprint;
    for (const change of [
      {
        OTTO_EVAL_MODEL: 'fixture-2026-09-02',
        OTTO_EVAL_MODEL_REVISION: 'fixture-2026-09-02',
      },
      { OTTO_EVAL_BASE_URL: 'https://other.invalid/v1' },
      { OTTO_EVAL_MAX_COST_USD: '3' },
      { OTTO_EVAL_INPUT_PER_MILLION: '2' },
    ])
      expect(
        liveEvalPreflight({ ...configured(), ...change }).declaration
          .fingerprint,
      ).not.toBe(original);
    expect(
      liveEvalPreflight({
        ...configured(),
        OTTO_EVAL_API_KEY: 'rotated-private-key',
      }).declaration.fingerprint,
    ).toBe(original);
  });
  it('reports missing choices without exposing credentials', () => {
    const result = liveEvalPreflight({
      OTTO_EVAL_API_KEY: 'do-not-print-this',
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain('OTTO_EVAL_MODEL_REVISION');
    expect(JSON.stringify(result)).not.toContain('do-not-print-this');
  });
  it('accepts an explicitly approved pinned configuration', () => {
    const result = liveEvalPreflight(configured());
    expect(result.ready).toBe(true);
    expect(result.identity?.modelRevision).toBe('fixture-2026-09-01');
    expect(result.identity?.maxCostUsd).toBe(2);
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(JSON.stringify(result)).not.toContain('fixture.invalid');
  });
  it.each([
    'http://external.invalid/v1',
    'https://u:p@fixture.invalid',
    'https://fixture.invalid?key=secret',
    'https://fixture.invalid/#secret',
  ])('rejects unsafe or credential-bearing endpoint %s', (url) => {
    expect(
      liveEvalPreflight({ ...configured(), OTTO_EVAL_BASE_URL: url }).ready,
    ).toBe(false);
  });
  it.each(['auto', 'latest', 'fixture-latest', 'fixture-preview', 'fixture'])(
    'rejects an unpinned/mismatched revision %s',
    (revision) => {
      expect(
        liveEvalPreflight({
          ...configured(),
          OTTO_EVAL_MODEL_REVISION: revision,
        }).ready,
      ).toBe(false);
    },
  );
  it.each(['', '-1', 'NaN', 'Infinity', '0'])(
    'requires a positive finite budget %s',
    (max) => {
      expect(
        liveEvalPreflight({ ...configured(), OTTO_EVAL_MAX_COST_USD: max })
          .ready,
      ).toBe(false);
    },
  );
  it('requires explicit opt-in and provider cap acknowledgment; a key alone is not permission', () => {
    expect(
      liveEvalPreflight({ ...configured(), OTTO_LIVE_EVAL: '0' }).ready,
    ).toBe(false);
    expect(
      liveEvalPreflight({
        ...configured(),
        OTTO_EVAL_PROVIDER_CAP_CONFIRMED: '0',
      }).ready,
    ).toBe(false);
  });
  it('keeps unavailable prices unavailable, not zero', () => {
    expect(
      liveEvalPreflight({ ...configured(), OTTO_EVAL_INPUT_PER_MILLION: '' })
        .ready,
    ).toBe(false);
  });
});
describe('batch budget reservation', () => {
  it('reserves before dispatch and cannot double settle or overbook', () => {
    const budget = new LiveEvalBudget(1, 0.6);
    const receipt = budget.reserve();
    expect(receipt).not.toBeNull();
    expect(budget.reserve()).toBeNull();
    budget.settle(receipt!, 0.2);
    expect(() => budget.settle(receipt!, 0)).toThrow();
    expect(budget.reserve()).not.toBeNull();
  });
  it('unknown usage stops the batch and keeps the reservation', () => {
    const budget = new LiveEvalBudget(2, 0.5);
    budget.settle(budget.reserve()!, null);
    expect(budget.reserve()).toBeNull();
    expect(budget.snapshot()).toMatchObject({
      stopped: true,
      reservedUsd: 0.5,
      actualEstimatedUsd: null,
    });
  });
  it('a request over its reserve stops future calls rather than claiming a hard billing guarantee', () => {
    const budget = new LiveEvalBudget(2, 0.5);
    budget.settle(budget.reserve()!, 0.8);
    expect(budget.reserve()).toBeNull();
    expect(budget.snapshot().stopReason).toBe('case_reserve_exceeded');
  });
});
