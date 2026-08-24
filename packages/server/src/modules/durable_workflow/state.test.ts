/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import {
  boundedRetryDelayMs,
  expiredLeaseDisposition,
  failureDisposition,
} from './state.js';

describe('durable workflow failure state', () => {
  it('never replays an external side effect whose outcome is unknown', () => {
    expect(
      expiredLeaseDisposition({
        sideEffect: 'external',
        attempt: 1,
        maxAttempts: 5,
      }),
    ).toBe('unknown_outcome');
    expect(
      failureDisposition({
        sideEffect: 'external',
        attempt: 1,
        maxAttempts: 5,
        certainty: 'known_failure',
      }),
    ).toBe('unknown_outcome');
  });

  it('retries an external call only when the executor confirms it never started', () => {
    expect(
      failureDisposition({
        sideEffect: 'external',
        attempt: 1,
        maxAttempts: 2,
        certainty: 'confirmed_not_started',
      }),
    ).toBe('retry');
  });

  it('moves safe work to dead letter after its retry budget is exhausted', () => {
    expect(
      expiredLeaseDisposition({
        sideEffect: 'idempotent',
        attempt: 3,
        maxAttempts: 3,
      }),
    ).toBe('dead_letter');
    expect(
      failureDisposition({
        sideEffect: 'none',
        attempt: 2,
        maxAttempts: 2,
        certainty: 'unknown_outcome',
      }),
    ).toBe('dead_letter');
  });

  it('uses bounded exponential retry delays', () => {
    expect(boundedRetryDelayMs(1)).toBe(1_000);
    expect(boundedRetryDelayMs(4)).toBe(8_000);
    expect(boundedRetryDelayMs(99)).toBeLessThanOrEqual(5 * 60_000);
  });
});
