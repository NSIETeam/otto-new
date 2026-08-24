/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  DurableWorkflowFailureCertainty,
  DurableWorkflowSideEffect,
} from './contracts.js';

export type DurableFailureDisposition =
  'retry' | 'dead_letter' | 'unknown_outcome';

export function failureDisposition(input: {
  sideEffect: DurableWorkflowSideEffect;
  attempt: number;
  maxAttempts: number;
  certainty: DurableWorkflowFailureCertainty;
}): DurableFailureDisposition {
  if (
    input.sideEffect === 'external' &&
    input.certainty !== 'confirmed_not_started'
  ) {
    return 'unknown_outcome';
  }
  return input.attempt < input.maxAttempts ? 'retry' : 'dead_letter';
}

export function expiredLeaseDisposition(input: {
  sideEffect: DurableWorkflowSideEffect;
  attempt: number;
  maxAttempts: number;
}): DurableFailureDisposition {
  if (input.sideEffect === 'external') return 'unknown_outcome';
  return input.attempt < input.maxAttempts ? 'retry' : 'dead_letter';
}

export function boundedRetryDelayMs(attempt: number): number {
  const normalized = Math.max(1, Math.min(10, Math.floor(attempt)));
  return Math.min(5 * 60_000, 1_000 * 2 ** (normalized - 1));
}
