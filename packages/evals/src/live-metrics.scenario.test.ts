/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { summarizeLiveUsage, LIVE_CASES } from './liveRuntimeEval.js';
describe('live evaluation accounting (offline harness checks, not live results)', () => {
  it('does not pretend missing usage means zero cost', () => {
    expect(summarizeLiveUsage([undefined]).estimatedCost).toBeNull();
    expect(summarizeLiveUsage([]).inputTokens).toBeNull();
    expect(
      summarizeLiveUsage([
        { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ]).estimatedCost,
    ).toBeNull();
  });
  it('sums all model rounds rather than only the final answer', () => {
    expect(
      summarizeLiveUsage(
        [
          { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
          { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
        ],
        { inputPerMillion: 1, outputPerMillion: 2 },
      ).estimatedCost,
    ).toBe(0.006);
  });
  it('has distinct workloads with independent expected artifacts', () => {
    expect(new Set(LIVE_CASES.map((testCase) => testCase.task)).size).toBe(6);
    expect(
      LIVE_CASES.every((testCase) => testCase.expected !== undefined),
    ).toBe(true);
  });
});
